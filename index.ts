import { type ServerWebSocket, type Server } from "bun";

import {
  getFlightPosition,
  getFlightInfo,
  getFlightTrack,
} from "./src/aeroapi";
import { jsonWithCors, handleCorsOptions } from "./src/cors";
import {
  searchFlights,
  generateFlightMetadataAndSave,
  getSavedFlights,
  deleteFlight,
  updateWaypoints,
} from "./src/handlers";
import logger from "./src/logger";
import {
  type FlightMetadata,
  type FlightPositionResponse,
  type FlightInfoResponse,
  type FlightTrackObject,
  type WebSocketEvent,
  type WebSocketEventType,
} from "./src/types";
import { getCountriesVisited, db, standardizeFlightStatus } from "./src/utils";

// Connection tracking
interface ClientConnection {
  connected: boolean;
  clientId: string;
  setupComplete: boolean;
}

const clientConnections = new Map<ServerWebSocket, ClientConnection>();
const CLEANUP_INTERVAL = 30000; // 30 seconds
const CONNECTION_SETUP_TIMEOUT = 5000; // 5 seconds

// Start cleanup interval
const cleanupInterval = setInterval(cleanupStaleConnections, CLEANUP_INTERVAL);
let pollingInterval: ReturnType<typeof setInterval> | null = null;

// Add at the top with other state variables
let isShuttingDown = false;

const server = Bun.serve({
  port: process.env.PORT || 3001,
  routes: {
    // Flight management endpoints
    "/api/flights/search": {
      POST: searchFlights,
      OPTIONS: handleCorsOptions,
    },
    "/api/flights/save": {
      POST: generateFlightMetadataAndSave,
      OPTIONS: handleCorsOptions,
    },
    "/api/flights": {
      GET: getSavedFlights,
      DELETE: deleteFlight,
      OPTIONS: handleCorsOptions,
    },
    "/api/flights/update_waypoints": {
      POST: updateWaypoints,
      OPTIONS: handleCorsOptions,
    },
    // Tracking control endpoints
    "/api/tracking/start": {
      POST: handleStartTracking,
      OPTIONS: handleCorsOptions,
    },
    "/api/tracking/stop": {
      POST: handleStopTracking,
      OPTIONS: handleCorsOptions,
    },
    // Health check endpoint
    "/api/health": {
      GET: () => jsonWithCors({ status: "ok" }),
      OPTIONS: handleCorsOptions,
    },
  },
  fetch(req: Request, server: Server): Response | Promise<Response> {
    if (server.upgrade(req)) {
      return new Response(null, { status: 101 });
    }
    return jsonWithCors({ error: "Not found" }, { status: 404 });
  },
  error(error: Error) {
    logger.error({ err: error }, "Server error");
    return new Response(`Internal Server Error: ${error.message}`, {
      status: 500,
    });
  },
  websocket: {
    open(ws: ServerWebSocket) {
      const clientId = generateClientId();

      // Set up connection timeout
      const setupTimeout = setTimeout(() => {
        if (!clientConnections.get(ws)?.setupComplete) {
          logger.warn(
            { clientId, readyState: ws.readyState },
            "Connection setup timed out"
          );
          ws.close();
        }
      }, CONNECTION_SETUP_TIMEOUT);

      // Set up a small delay to ensure connection is stable
      setTimeout(() => {
        // Only proceed if the connection is still open
        if (ws.readyState === WebSocket.OPEN) {
          clearTimeout(setupTimeout);

          clientConnections.set(ws, {
            connected: true,
            clientId,
            setupComplete: true,
          });

          ws.subscribe("flight-updates");

          logger.info(
            {
              clientId,
              clientCount: clientConnections.size,
              timestamp: new Date().toISOString(),
              readyState: ws.readyState,
            },
            "New WebSocket connection"
          );

          // Send initial state to the new client
          getInitialState().then((state) => {
            const connection = clientConnections.get(ws);
            if (connection?.connected && connection.setupComplete) {
              ws.send(
                JSON.stringify({
                  event: "initial_state",
                  data: state,
                })
              );
            }
          });

          // Broadcast updated client count to all clients
          broadcastUpdate("client_added", clientConnections.size);
        } else {
          clearTimeout(setupTimeout);
          logger.warn(
            { clientId, readyState: ws.readyState },
            "Connection not stable, skipping setup"
          );
        }
      }, 1000); // 1 second delay to ensure connection stability
    },

    message(ws: ServerWebSocket, message: string | Buffer) {
      try {
        const data = JSON.parse(message.toString());
        const connection = clientConnections.get(ws);

        logger.debug(
          {
            clientId: connection?.clientId,
            event: data.event,
            message: data,
          },
          "Received WebSocket message"
        );
      } catch (error) {
        logger.error(
          {
            err: error,
            message: message.toString(),
            clientId: clientConnections.get(ws)?.clientId,
          },
          "Failed to parse WebSocket message"
        );
      }
    },

    close(ws: ServerWebSocket) {
      const connection = clientConnections.get(ws);
      if (connection) {
        // Only count as a client if setup was completed
        const shouldCount = connection.setupComplete;

        logger.info(
          {
            clientId: connection.clientId,
            clientCount: shouldCount
              ? clientConnections.size - 1
              : clientConnections.size,
            timestamp: new Date().toISOString(),
            readyState: ws.readyState,
            setupComplete: connection.setupComplete,
          },
          "WebSocket connection closed"
        );

        clientConnections.delete(ws);
        ws.unsubscribe("flight-updates");

        // Only broadcast if this was a fully established connection
        if (shouldCount) {
          broadcastUpdate("client_removed", clientConnections.size);
        }
      }
    },
  },
});

logger.info(
  { port: server.port, hostname: server.hostname },
  "Admin server running"
);

// Restore tracking state after server is initialized
restoreTrackingState().catch((error) => {
  logger.error({ err: error }, "Failed to restore tracking state");
});

// Generate a unique client ID
function generateClientId(): string {
  return Math.random().toString(36).substring(2, 15);
}

// Cleanup stale connections
function cleanupStaleConnections() {
  let cleanedCount = 0;

  for (const [ws, data] of clientConnections.entries()) {
    // Don't clean up connections that are still in setup
    if (!data.setupComplete) {
      continue;
    }

    // Check if connection is stale (closed or not open)
    if (ws.readyState !== WebSocket.OPEN) {
      logger.info(
        {
          clientId: data.clientId,
          setupComplete: data.setupComplete,
          readyState: ws.readyState,
        },
        "Cleaning up stale connection"
      );

      clientConnections.delete(ws);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.info(
      {
        cleanedCount,
        remainingConnections: clientConnections.size,
        activeConnections: Array.from(clientConnections.values()).filter(
          (c) => c.connected && c.setupComplete
        ).length,
      },
      "Cleaned up stale connections"
    );
  }
}

function broadcastUpdate<T>(event: WebSocketEventType, data: T) {
  const update: WebSocketEvent<T> = { event, data };
  const message = JSON.stringify(update);
  let successCount = 0;
  let failureCount = 0;
  let cleanupCount = 0;

  for (const [ws, connection] of clientConnections.entries()) {
    try {
      // Only broadcast to fully established connections
      if (
        connection.connected &&
        connection.setupComplete &&
        ws.readyState === WebSocket.OPEN
      ) {
        ws.send(message);
        successCount++;
      } else {
        logger.warn(
          {
            clientId: connection.clientId,
            connected: connection.connected,
            setupComplete: connection.setupComplete,
            readyState: ws.readyState,
            event,
          },
          "Skipping broadcast to inactive connection"
        );
        failureCount++;

        // If connection is not in setup and is inactive, mark for cleanup
        if (
          connection.setupComplete &&
          (!connection.connected || ws.readyState !== WebSocket.OPEN)
        ) {
          cleanupCount++;
        }
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          event,
          clientId: connection.clientId,
          clientCount: clientConnections.size,
        },
        "Failed to broadcast message"
      );
      failureCount++;
      // Mark connection as disconnected
      connection.connected = false;

      // If connection is not in setup, mark for cleanup
      if (connection.setupComplete) {
        cleanupCount++;
      }
    }
  }

  // Clean up failed connections after broadcast
  if (cleanupCount > 0) {
    for (const [ws, connection] of clientConnections.entries()) {
      if (
        connection.setupComplete &&
        (!connection.connected || ws.readyState !== WebSocket.OPEN)
      ) {
        clientConnections.delete(ws);
        cleanupCount--;
        if (cleanupCount === 0) break;
      }
    }
  }

  // Log broadcast statistics
  if (successCount > 0 || failureCount > 0) {
    logger.info(
      {
        event,
        successCount,
        failureCount,
        cleanupCount,
        totalConnections: clientConnections.size,
        activeConnections: Array.from(clientConnections.values()).filter(
          (c) => c.connected && c.setupComplete
        ).length,
      },
      "Broadcast completed"
    );
  }
}

async function getInitialState() {
  const flights = await db
    .collection<FlightMetadata>("flights")
    .find({})
    .toArray();

  const completedFlights = flights.filter(
    (f) => f.standardized_status === "completed"
  );
  const activeFlightData = flights.find((f) => f.is_tracking) || null;
  const lastPosition =
    activeFlightData?.flightTrack?.[activeFlightData.flightTrack.length - 1] ||
    null;
  // get the last completed flight
  const lastCompletedFlight = completedFlights[completedFlights.length - 1];

  return {
    client_count: clientConnections.size,
    active_flight: activeFlightData,
    current_location: lastCompletedFlight
      ? {
          country: lastCompletedFlight.destination.country_code,
          latitude: lastCompletedFlight.destination.latitude,
          longitude: lastCompletedFlight.destination.longitude,
          heading: 0,
          timestamp: lastCompletedFlight.actual_on,
        }
      : null,
    current_position: lastPosition
      ? {
          latitude: lastPosition.latitude,
          longitude: lastPosition.longitude,
          heading: lastPosition.heading,
          timestamp: lastPosition.timestamp,
        }
      : null,
    completed_flights: completedFlights,
    stats: {
      total_miles: completedFlights.reduce(
        (acc, f) => acc + f.route_distance,
        0
      ),
      total_countries: getCountriesVisited(flights),
      total_flights: completedFlights.length,
      last_updated: new Date(),
    },
  };
}

// Extract polling logic into a separate function
async function startPolling(
  faFlightId: string,
  initialPositionData: FlightPositionResponse,
  initialFlightData: FlightInfoResponse,
  positions: FlightTrackObject[]
) {
  // Clear any existing polling
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
  }

  // Get the existing flight data first
  const existingFlight = await db
    .collection<FlightMetadata>("flights")
    .findOne({ fa_flight_id: faFlightId });

  // Merge existing track data with new positions to avoid data loss
  let mergedTrackData: FlightTrackObject[] = [];

  if (
    existingFlight &&
    existingFlight.flightTrack &&
    existingFlight.flightTrack.length > 0
  ) {
    logger.info(
      { count: existingFlight.flightTrack.length },
      "Found existing flight track"
    );

    // Create a Set of existing timestamps for O(1) lookup
    const existingTimestamps = new Set(
      existingFlight.flightTrack.map((pos) => pos.timestamp)
    );

    // Start with existing track data
    mergedTrackData = [...existingFlight.flightTrack];

    // Add new positions that don't already exist
    for (const pos of positions) {
      if (!existingTimestamps.has(pos.timestamp)) {
        mergedTrackData.push(pos);
      }
    }

    // Sort by timestamp to ensure chronological order
    mergedTrackData.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    logger.info(
      { count: mergedTrackData.length },
      "Merged track now has positions"
    );
  } else {
    // No existing track data, just use the new positions
    mergedTrackData = positions;
    logger.info(
      { count: mergedTrackData.length },
      "No existing flight track, using positions from API"
    );
  }

  // update the flight with the new data
  const updatedFlight = await db
    .collection<FlightMetadata>("flights")
    .findOneAndUpdate(
      { fa_flight_id: faFlightId },
      {
        $set: {
          status: initialFlightData?.flights?.[0]?.status,
          standardized_status: initialFlightData?.flights?.[0]?.status
            ? standardizeFlightStatus(initialFlightData?.flights?.[0]?.status)
            : "unknown",
          is_tracking: true,
          waypoints: initialPositionData.waypoints,
          flightTrack: mergedTrackData,
        },
      },
      { returnDocument: "after" }
    );

  broadcastUpdate("start_flight", {
    flight: updatedFlight,
    current_position: {
      latitude: initialPositionData.last_position.latitude,
      longitude: initialPositionData.last_position.longitude,
      heading: initialPositionData.last_position.heading,
      timestamp: initialPositionData.last_position.timestamp,
    },
  });

  // Variables for retry mechanism
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;
  const RETRY_DELAY_BASE = 5000;

  // Start polling FlightAware API for position updates only
  pollingInterval = setInterval(async () => {
    try {
      // Check if the flight is still being tracked in the database
      logger.debug({ faFlightId }, "Verifying tracking status");
      const flightStatus = await db
        .collection<FlightMetadata>("flights")
        .findOne({
          fa_flight_id: faFlightId,
          is_tracking: true,
        });

      if (!flightStatus) {
        logger.info(
          { faFlightId },
          "Flight is no longer being tracked in the database, stopping polling"
        );
        await stopPolling(faFlightId);
        return;
      }

      // Only fetch position data during polling
      logger.debug({ faFlightId }, "Fetching position data");
      const newPositionData = await getFlightPosition(faFlightId);

      if (!newPositionData || !newPositionData.last_position) {
        logger.warn({ faFlightId }, "No position data received");
        consecutiveErrors++;

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          logger.error(
            { faFlightId, consecutiveErrors },
            "Too many consecutive errors, stopping polling"
          );
          await stopPolling(faFlightId);
          return;
        }
        return;
      }

      // Check for landing indicators
      const lastPosition = newPositionData.last_position;
      if (
        newPositionData.actual_on ||
        (lastPosition.altitude === -1 && lastPosition.groundspeed === 0)
      ) {
        logger.info(
          {
            faFlightId,
            actual_on: newPositionData.actual_on,
            altitude: lastPosition.altitude,
            groundspeed: lastPosition.groundspeed,
          },
          "Flight has landed or is at gate, stopping polling"
        );
        await stopPolling(faFlightId);
        return;
      }

      // Reset error counter on successful data fetch
      consecutiveErrors = 0;

      // Check if this position already exists in the database
      const positionExists = await db
        .collection<FlightMetadata>("flights")
        .findOne({
          fa_flight_id: faFlightId,
          "flightTrack.timestamp": newPositionData.last_position.timestamp,
        });

      if (positionExists) {
        logger.info(
          { timestamp: newPositionData.last_position.timestamp },
          "Position with timestamp already exists, skipping update"
        );
        return;
      }

      // Update flight track data in database with new position
      logger.info({ faFlightId }, "Updating flight track in database");
      await db.collection<FlightMetadata>("flights").updateOne(
        { fa_flight_id: faFlightId },
        {
          $push: { flightTrack: newPositionData.last_position },
        }
      );

      // Broadcast position update
      logger.info({ faFlightId }, "Broadcasting position update");
      broadcastUpdate("position_update", {
        flight_id: faFlightId,
        position: newPositionData.last_position,
      });
      logger.info(
        { timestamp: newPositionData.last_position.timestamp },
        "Position update broadcast completed"
      );
    } catch (error) {
      logger.error(
        { err: error, faFlightId },
        "Error polling flight position data"
      );

      consecutiveErrors++;

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        logger.error(
          { faFlightId, consecutiveErrors },
          "Too many consecutive errors, stopping polling"
        );
        await stopPolling(faFlightId);
        return;
      }
    }
  }, 60000); // Poll every 60 seconds to respect API rate limits

  return updatedFlight;
}

// Modified route handlers for tracking
async function handleStartTracking(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { fa_flight_id: string };
    const faFlightId = body.fa_flight_id;

    if (!faFlightId) {
      return jsonWithCors({ error: "Missing flight ID" }, { status: 400 });
    }

    try {
      // First check if flight exists and if it's already being tracked
      const flight = await db.collection<FlightMetadata>("flights").findOne({
        fa_flight_id: faFlightId,
      });

      if (!flight) {
        return jsonWithCors({ error: "Flight not found" }, { status: 404 });
      }

      if (flight.is_tracking) {
        logger.info(
          { flightId: faFlightId },
          "Flight is already being tracked"
        );
        return jsonWithCors({ message: "Flight is already being tracked" });
      }

      // Fetch initial flight data from multiple sources in parallel
      const [flightData, positionData] = await Promise.all([
        getFlightInfo(faFlightId),
        getFlightPosition(faFlightId),
      ]);

      // Determine if we need historical track data
      const currentTime = new Date();
      const firstPositionTime = new Date(positionData.first_position_time);
      const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
      let positions: FlightTrackObject[] = [];

      if (currentTime.getTime() > firstPositionTime.getTime() + bufferTime) {
        // We need historical data if we're starting tracking after first position time
        const res = await getFlightTrack(faFlightId);
        positions = res.positions;
      }

      await startPolling(faFlightId, positionData, flightData, positions);
      return jsonWithCors({ message: "Tracking started successfully" });
    } catch (error) {
      logger.error({ err: error }, "Error starting flight tracking");
      return jsonWithCors(
        { error: "Failed to start tracking" },
        { status: 500 }
      );
    }
  } catch (error) {
    return jsonWithCors({ error: "Failed to start tracking" }, { status: 500 });
  }
}

// Function to restore tracking state on server startup
async function restoreTrackingState() {
  try {
    logger.info(
      "Checking for flights that were being tracked before server restart"
    );

    // First, find any flights with is_tracking=true
    const trackedFlights = await db
      .collection<FlightMetadata>("flights")
      .find({ is_tracking: true })
      .toArray();

    logger.info(
      { count: trackedFlights.length },
      "Found flights marked as tracking"
    );

    // If no flights found at all, we're done
    if (trackedFlights.length === 0) {
      logger.info("No flights were being tracked before server restart");
      return;
    }

    // If multiple flights found, we need to decide which one to restore
    if (trackedFlights.length > 1) {
      logger.info(
        { count: trackedFlights.length },
        "Found multiple tracked flights, analyzing"
      );

      // Sort by last position timestamp (most recent first)
      trackedFlights.sort((a, b) => {
        const aLastPosition =
          a.flightTrack?.[a.flightTrack.length - 1]?.timestamp;
        const bLastPosition =
          b.flightTrack?.[b.flightTrack.length - 1]?.timestamp;

        if (!aLastPosition && !bLastPosition) return 0;
        if (!aLastPosition) return 1;
        if (!bLastPosition) return -1;

        return (
          new Date(bLastPosition).getTime() - new Date(aLastPosition).getTime()
        );
      });

      // Take the most recently updated flight
      const mostRecentFlight = trackedFlights[0];

      // Safety check - this should never happen since we know length > 1
      if (!mostRecentFlight || !mostRecentFlight.fa_flight_id) {
        logger.error("Unexpected: No valid flight found after sorting");
        return;
      }

      logger.info(
        { flightId: mostRecentFlight.fa_flight_id },
        "Selected most recently active flight"
      );

      // Reset tracking flag for all other flights
      await db.collection("flights").updateMany(
        {
          fa_flight_id: {
            $ne: mostRecentFlight.fa_flight_id,
            $in: trackedFlights.map((f) => f.fa_flight_id),
          },
        },
        {
          $set: {
            is_tracking: false,
          },
        }
      );

      // Proceed with just the selected flight
      trackedFlights.splice(1);
    }

    const flight = trackedFlights[0];
    if (!flight || !flight.fa_flight_id) {
      logger.error("Found invalid flight data during state restoration");
      return;
    }

    logger.info(
      { flightId: flight.fa_flight_id },
      "Attempting to restore tracking"
    );

    // Check flight status to see if it's already completed
    try {
      const currentFlightInfo = await getFlightInfo(flight.fa_flight_id);
      if (currentFlightInfo?.flights?.[0]?.status) {
        const apiStatus = currentFlightInfo.flights[0].status;
        const standardized = standardizeFlightStatus(apiStatus);

        logger.info(
          { apiStatus, standardized },
          "Current API status for flight"
        );

        // If the flight is already completed, don't restart tracking
        if (standardized === "completed") {
          logger.info(
            { flightId: flight.fa_flight_id },
            "Flight is already completed, updating database and not restarting tracking"
          );

          await db.collection("flights").updateOne(
            { fa_flight_id: flight.fa_flight_id },
            {
              $set: {
                is_tracking: false,
                status: apiStatus,
                standardized_status: standardized,
              },
            }
          );

          return;
        }
      }
    } catch (error) {
      logger.warn(
        { err: error },
        "Unable to check current flight status, will attempt to restore tracking anyway"
      );
    }

    // Log existing track data for debugging
    if (flight.flightTrack && flight.flightTrack.length > 0) {
      logger.info(
        { count: flight.flightTrack.length },
        "Flight has existing position records"
      );
      logger.info(
        { firstTimestamp: flight.flightTrack[0]?.timestamp || "unknown" },
        "First position timestamp"
      );
      logger.info(
        {
          lastTimestamp:
            flight.flightTrack[flight.flightTrack.length - 1]?.timestamp ||
            "unknown",
        },
        "Last position timestamp"
      );
    } else {
      logger.info("Flight has no existing position records");
    }

    // Fetch initial flight data from multiple sources in parallel
    const [flightData, positionData] = await Promise.all([
      getFlightInfo(flight.fa_flight_id),
      getFlightPosition(flight.fa_flight_id),
    ]);

    if (positionData && positionData.last_position) {
      logger.info(
        { timestamp: positionData.last_position.timestamp },
        "Retrieved current position data from API"
      );
    } else {
      logger.info(
        "Retrieved position data from API but no last_position available"
      );
    }

    // Determine if we need historical track data
    const currentTime = new Date();
    const firstPositionTime = new Date(positionData.first_position_time);
    const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
    let positions: FlightTrackObject[] = [];

    if (currentTime.getTime() > firstPositionTime.getTime() + bufferTime) {
      // We need historical data if we're starting tracking after first position time
      logger.info("Fetching historical track data from API...");
      const res = await getFlightTrack(flight.fa_flight_id);
      positions = res.positions;
      logger.info(
        { count: positions.length },
        "Retrieved historical positions from API"
      );

      if (positions && positions.length > 0) {
        logger.info(
          {
            firstTimestamp: positions[0]?.timestamp || "unknown",
            lastTimestamp:
              positions[positions.length - 1]?.timestamp || "unknown",
          },
          "API track data range"
        );
      }
    }

    await startPolling(
      flight.fa_flight_id,
      positionData,
      flightData,
      positions
    );

    logger.info(
      { flightId: flight.fa_flight_id },
      "Flight tracking successfully restored"
    );
  } catch (error) {
    logger.error({ err: error }, "Error restoring tracking state");

    // Don't reset tracking state on error - let the next restart attempt try again
  }
}

async function handleStopTracking(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { fa_flight_id: string };

    if (!body.fa_flight_id) {
      return jsonWithCors({ error: "Missing flight ID" }, { status: 400 });
    }

    const success = await stopPolling(body.fa_flight_id, true);

    if (success) {
      return jsonWithCors({ message: "Tracking stopped successfully" });
    } else {
      return jsonWithCors(
        { error: "Failed to stop tracking" },
        { status: 500 }
      );
    }
  } catch (error) {
    return jsonWithCors({ error: "Failed to stop tracking" }, { status: 500 });
  }
}

async function stopPolling(
  faFlightId: string,
  serverShutdown: boolean = false
) {
  try {
    logger.info({ faFlightId, serverShutdown }, "Stopping polling");

    // Clear polling interval
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    // If this is a server shutdown, don't perform redundant database updates
    if (serverShutdown) {
      logger.info(
        "Server shutdown detected, only clearing interval and setting currentFlightId"
      );
      return true;
    }

    // Get the current flight data
    const flight = await db
      .collection("flights")
      .findOne({ fa_flight_id: faFlightId });
    if (!flight) {
      logger.warn(
        { faFlightId },
        "Flight not found when stopping, may have been deleted"
      );
      return false; // Return false since flight doesn't exist.
    }

    // Get the latest flight status from the API
    logger.info({ faFlightId }, "Fetching final flight data from API");
    let finalStatus = "completed"; // Default fallback status
    let finalFlightData = null;
    let finalPositionData = null;

    try {
      [finalFlightData, finalPositionData] = await Promise.all([
        getFlightInfo(faFlightId),
        getFlightPosition(faFlightId),
      ]);

      if (finalFlightData?.flights?.[0]) {
        const apiStatus = finalFlightData.flights[0].status;
        logger.info({ apiStatus }, "API reports flight status as");
        finalStatus = apiStatus || finalStatus;
      } else {
        logger.info(
          { faFlightId },
          "No flight status available from API, using default"
        );
      }
    } catch (error) {
      logger.error(
        { err: error },
        "Error fetching final flight status from API"
      );
      logger.info({ faFlightId }, "Using default status");
    }

    // Standardize the status
    const standardizedStatus = standardizeFlightStatus(finalStatus);

    // Determine the reason for stopping based on existing fields
    let trackingEndedReason = serverShutdown
      ? "server_shutdown"
      : "manual_stop";
    if (finalFlightData?.flights?.[0]?.cancelled) {
      trackingEndedReason = "cancelled";
    } else if (standardizedStatus === "completed") {
      trackingEndedReason = "completed";
    }

    // Update flight status and set is_tracking to false with all relevant data
    logger.info({ faFlightId, finalStatus }, "Updating flight status to");
    const updateFields: Partial<FlightMetadata> = {
      // Use Partial for type safety
      status: finalStatus,
      standardized_status: standardizedStatus,
      is_tracking: false,
    };

    // If we have final flight data from the API, update relevant fields
    if (finalFlightData?.flights?.[0]) {
      const apiFlightData = finalFlightData.flights[0];

      // Only update these fields if they're provided in the API response (avoid null overwrite)
      if (apiFlightData?.actual_off)
        updateFields.actual_off = apiFlightData.actual_off;
      if (apiFlightData?.actual_on)
        updateFields.actual_on = apiFlightData.actual_on;
      if (apiFlightData?.actual_in)
        updateFields.actual_in = apiFlightData.actual_in;
      if (apiFlightData?.actual_out)
        updateFields.actual_out = apiFlightData.actual_out;
      if (apiFlightData?.arrival_delay)
        updateFields.arrival_delay = apiFlightData.arrival_delay;
      if (apiFlightData?.departure_delay)
        updateFields.departure_delay = apiFlightData.departure_delay;
      if (apiFlightData?.diverted !== undefined)
        updateFields.diverted = apiFlightData.diverted;
      if (apiFlightData?.cancelled !== undefined)
        updateFields.cancelled = apiFlightData.cancelled;
      if (apiFlightData?.progress_percent !== undefined)
        updateFields.progress_percent = apiFlightData.progress_percent;
    }

    // Include final position data, especially actual_on
    if (finalPositionData?.actual_on) {
      updateFields.actual_on = finalPositionData.actual_on;
    }

    // Perform the update
    await db.collection("flights").updateOne(
      { fa_flight_id: faFlightId },
      {
        $set: updateFields,
      }
    );

    // Broadcast final update
    logger.info({ faFlightId }, "Broadcasting flight completion");
    broadcastUpdate("flight_completed", {
      fa_flight_id: faFlightId,
      status: finalStatus,
      standardized_status: standardizedStatus,
      completion_time: new Date().toISOString(),
      forced: false,
      reason: trackingEndedReason,
    });

    return true;
  } catch (error) {
    logger.error({ err: error, faFlightId }, "Error stopping flight tracking");
    return false;
  }
}

// Function to cleanup server resources without affecting tracking state
async function cleanupServerResources() {
  if (isShuttingDown) {
    logger.info("Cleanup already in progress, skipping");
    return;
  }

  isShuttingDown = true;
  logger.info("Starting server cleanup...");

  try {
    // Clear cleanup interval
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
    }

    // Clear any active polling intervals
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    // Close all WebSocket connections gracefully
    for (const [ws, connection] of clientConnections.entries()) {
      try {
        logger.info(
          {
            clientId: connection.clientId,
            connected: connection.connected,
            readyState: ws.readyState,
          },
          "Closing WebSocket connection during cleanup"
        );
        ws.close();
      } catch (error) {
        logger.error(
          {
            err: error,
            clientId: connection.clientId,
          },
          "Error closing WebSocket connection"
        );
      }
    }

    // Clear all collections
    clientConnections.clear();

    logger.info(
      {
        closedConnections: clientConnections.size,
        timestamp: new Date().toISOString(),
      },
      "Server resources cleaned up successfully"
    );
  } catch (error) {
    logger.error({ err: error }, "Error during server cleanup");
  } finally {
    isShuttingDown = false;
  }
}

// Simple shutdown handler
process.once("SIGTERM", async () => {
  logger.warn("SIGTERM received, performing graceful shutdown");
  await cleanupServerResources();
});

process.once("SIGINT", async () => {
  logger.warn("SIGINT received, performing graceful shutdown");
  await cleanupServerResources();
});
