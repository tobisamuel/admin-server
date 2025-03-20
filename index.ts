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

// Simplified connection tracking
const clientConnections = new Set<ServerWebSocket>();

// Start cleanup interval
let pollingInterval: ReturnType<typeof setInterval> | null = null;

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
      clientConnections.add(ws);
      ws.subscribe("flight-updates");

      logger.info(
        {
          clientCount: clientConnections.size,
          timestamp: new Date().toISOString(),
          readyState: ws.readyState,
        },
        "New WebSocket connection"
      );

      // Send initial state to the new client
      getInitialState().then((state) => {
        if (ws.readyState === WebSocket.OPEN) {
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
    },

    message(ws: ServerWebSocket, message: string | Buffer) {
      try {
        const data = JSON.parse(message.toString());
        logger.debug(
          {
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
          },
          "Failed to parse WebSocket message"
        );
      }
    },

    close(ws: ServerWebSocket) {
      clientConnections.delete(ws);
      ws.unsubscribe("flight-updates");

      logger.info(
        {
          clientCount: clientConnections.size,
          timestamp: new Date().toISOString(),
          readyState: ws.readyState,
        },
        "WebSocket connection closed"
      );

      broadcastUpdate("client_removed", clientConnections.size);
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

// Simplified broadcast function
function broadcastUpdate<T>(event: WebSocketEventType, data: T) {
  const update: WebSocketEvent<T> = { event, data };
  const message = JSON.stringify(update);

  for (const ws of clientConnections) {
    if (ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(message);
      } catch (error) {
        logger.error({ err: error, event }, "Failed to broadcast message");
      }
    }
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
  const firstScheduledFlight = flights[0];
  const lastCompletedFlight = completedFlights[completedFlights.length - 1];
  const lastFlight = flights.find((f) => f.is_last_flight);

  const activeFlightData = flights.find((f) => f.is_tracking) || null;
  const lastPosition =
    activeFlightData?.flightTrack?.[activeFlightData.flightTrack.length - 1] ||
    null;

  const currentPosition = activeFlightData
    ? activeFlightData.actual_off &&
      activeFlightData.flightTrack &&
      activeFlightData.flightTrack.length > 0
      ? {
          latitude: lastPosition?.latitude,
          longitude: lastPosition?.longitude,
          heading: lastPosition?.heading,
          timestamp: lastPosition?.timestamp,
        }
      : {
          latitude: activeFlightData.origin.latitude,
          longitude: activeFlightData.origin.longitude,
          heading: 0,
          timestamp:
            activeFlightData.actual_off || activeFlightData.scheduled_off,
        }
    : null;

  const currentLocation = lastCompletedFlight
    ? {
        country: lastCompletedFlight.destination.country_code,
        name: lastCompletedFlight.destination.city,
        latitude: lastCompletedFlight.destination.latitude,
        longitude: lastCompletedFlight.destination.longitude,
        heading: 0,
        timestamp: lastCompletedFlight.actual_on,
      }
    : firstScheduledFlight
    ? {
        country: firstScheduledFlight.origin.country_code,
        name: firstScheduledFlight.origin.city,
        latitude: firstScheduledFlight.origin.latitude,
        longitude: firstScheduledFlight.origin.longitude,
        heading: 0,
        timestamp: firstScheduledFlight.scheduled_off,
      }
    : null;

  return {
    start_time: firstScheduledFlight?.scheduled_off,
    end_time: lastFlight?.actual_on ?? null,
    client_count: clientConnections.size,
    active_flight: activeFlightData,
    current_location: currentLocation,
    current_position: currentPosition,
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
  flightPositionState: FlightPositionResponse,
  initialFlightData: FlightInfoResponse,
  existingPositions: FlightTrackObject[]
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

  if (!existingFlight) {
    logger.error({ faFlightId }, "Flight not found in database");
    return;
  }

  // Merge existing track data with new positions to avoid data loss
  let mergedTrackData: FlightTrackObject[] = [];

  if (existingFlight.flightTrack && existingFlight.flightTrack.length > 0) {
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
    for (const pos of existingPositions) {
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
    mergedTrackData = existingPositions;
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
          standardized_status: flightPositionState.actual_off
            ? standardizeFlightStatus(
                initialFlightData?.flights?.[0]?.status || "active"
              )
            : "taxiing",
          is_tracking: true,
          waypoints: flightPositionState.waypoints,
          flightTrack: flightPositionState.actual_off ? mergedTrackData : [],
        },
      },
      { returnDocument: "after" }
    );

  const currentPosition = flightPositionState.actual_off
    ? {
        latitude: flightPositionState.last_position.latitude,
        longitude: flightPositionState.last_position.longitude,
        heading: flightPositionState.last_position.heading,
        timestamp: flightPositionState.last_position.timestamp,
      }
    : {
        latitude: existingFlight.origin.latitude,
        longitude: existingFlight.origin.longitude,
        heading: 0,
        timestamp: existingFlight.scheduled_off,
      };

  broadcastUpdate("start_flight", {
    flight: updatedFlight,
    current_position: currentPosition,
  });

  // Variables for retry mechanism
  let consecutiveErrors = 0;
  const MAX_CONSECUTIVE_ERRORS = 5;

  // Start polling FlightAware API for position updates only
  pollingInterval = setInterval(async () => {
    try {
      // Check if the flight is still being tracked in the database
      logger.debug({ faFlightId }, "Starting polling interval");
      const flightData = await db
        .collection<FlightMetadata>("flights")
        .findOne({
          fa_flight_id: faFlightId,
          is_tracking: true,
        });

      if (!flightData) {
        logger.info(
          { faFlightId },
          "Flight is no longer being tracked in the database, stopping polling"
        );
        await stopPolling(faFlightId);
        return;
      }

      // Fetch latest position data from API
      logger.debug(
        { faFlightId, currentTime: new Date().toISOString() },
        "Fetching position data from API"
      );
      const newPositionData = await getFlightPosition(faFlightId);

      // Check if we received a valid API response with position data
      // This handles both API failures and cases where the flight has completed
      if (!newPositionData?.last_position) {
        logger.warn(
          {
            faFlightId,
            responseReceived: !!newPositionData,
          },
          "No valid position data received from API"
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
        return;
      }

      // Reset error counter on successful data fetch
      consecutiveErrors = 0;

      const lastPosition = newPositionData.last_position;

      // Check for landing first
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

      // First handle the case where we have actual_off
      if (newPositionData.actual_off) {
        // Calculate derived flight status data
        const progress = calculateProgressFromPositions(
          flightData.flightTrack,
          lastPosition,
          flightData.origin,
          flightData.destination,
          flightData.filed_ete
        );

        const departureDelay = calculateDepartureDelay(
          newPositionData.actual_off,
          flightData.scheduled_off
        );

        const estimatedArrival = calculateEstimatedArrival(
          newPositionData.actual_off,
          flightData.filed_ete
        );

        // Calculate arrival delay based on estimated arrival
        const arrivalDelay = estimatedArrival
          ? calculateArrivalDelay(estimatedArrival, flightData.scheduled_on)
          : flightData.arrival_delay || 0;

        // Check if this is the first time we're seeing actual_off (transition from taxiing to active)
        const isTransitioningToActive =
          flightData.standardized_status === "taxiing";

        // Update actual_off in database and transition to active state
        await db.collection<FlightMetadata>("flights").updateOne(
          { fa_flight_id: faFlightId },
          {
            $set: {
              actual_off: newPositionData.actual_off,
              departure_delay: departureDelay,
              arrival_delay: arrivalDelay,
              progress_percent: progress,
              estimated_on: estimatedArrival || undefined,
              standardized_status: "active",
            },
          }
        );

        if (isTransitioningToActive) {
          logger.info(
            {
              faFlightId,
              previous_status: flightData.standardized_status,
              new_status: "active",
              actual_off: newPositionData.actual_off,
            },
            "Flight transitioned from taxiing to active state with actual_off"
          );
        }

        // Check for duplicate position
        const positionExists = await db
          .collection<FlightMetadata>("flights")
          .findOne({
            fa_flight_id: faFlightId,
            "flightTrack.timestamp": lastPosition.timestamp,
          });

        if (!positionExists) {
          logger.info(
            {
              faFlightId,
              position: {
                altitude: lastPosition.altitude,
                groundspeed: lastPosition.groundspeed,
                heading: lastPosition.heading,
                coordinates: `${lastPosition.latitude},${lastPosition.longitude}`,
                timestamp: lastPosition.timestamp,
              },
              progress,
              departure_delay: departureDelay,
              arrival_delay: arrivalDelay,
            },
            "Recording and broadcasting new position after takeoff"
          );

          // Update flight track
          await db.collection<FlightMetadata>("flights").updateOne(
            { fa_flight_id: faFlightId },
            {
              $push: { flightTrack: lastPosition },
            }
          );

          // Enhanced broadcast with flight status
          broadcastUpdate("position_update", {
            flight_id: faFlightId,
            position: lastPosition,
            flight_status: {
              actual_off: newPositionData.actual_off,
              actual_on: newPositionData.actual_on,
              progress_percent: progress,
              departure_delay: departureDelay,
              arrival_delay: arrivalDelay,
              estimated_on: estimatedArrival,
              standardized_status: "active",
            },
          });
        } else {
          logger.debug(
            {
              faFlightId,
              timestamp: lastPosition.timestamp,
            },
            "Position already recorded, skipping update"
          );
        }
      } else {
        logger.debug(
          { faFlightId, position: lastPosition },
          "Taxiing state continues (no actual_off yet)"
        );
      }
    } catch (error) {
      logger.error(
        {
          err: error,
          faFlightId,
          stack: error instanceof Error ? error.stack : undefined,
        },
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

      // Check if plane has started moving (at least (1 position) even within the airport (taxiing))
      if (!positionData.last_position || !positionData.first_position_time) {
        logger.info(
          {
            flightId: faFlightId,
            hasLastPosition: !!positionData.last_position,
            hasFirstPositionTime: !!positionData.first_position_time,
            origin: positionData.origin,
            destination: positionData.destination,
            aircraft_type: positionData.aircraft_type,
          },
          "Flight has not started yet"
        );
        return jsonWithCors(
          {
            error: "Flight has not started yet",
            details: {
              scheduled_origin: positionData.origin,
              scheduled_destination: positionData.destination,
              aircraft_type: positionData.aircraft_type,
            },
          },
          { status: 400 }
        );
      }

      // Determine if we need historical track data
      const currentTime = new Date();
      const firstPositionTime = new Date(positionData.first_position_time);
      const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
      let existingPositions: FlightTrackObject[] = [];

      if (currentTime.getTime() > firstPositionTime.getTime() + bufferTime) {
        // We need historical data if we're starting tracking after first position time
        const res = await getFlightTrack(faFlightId);
        existingPositions = res.positions;
      }

      await startPolling(
        faFlightId,
        positionData,
        flightData,
        existingPositions
      );
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
    let existingPositions: FlightTrackObject[] = [];

    if (currentTime.getTime() > firstPositionTime.getTime() + bufferTime) {
      // We need historical data if we're starting tracking after first position time
      logger.info("Fetching historical track data from API...");
      const res = await getFlightTrack(flight.fa_flight_id);
      existingPositions = res.positions;
      logger.info(
        { count: existingPositions.length },
        "Retrieved historical positions from API"
      );

      if (existingPositions && existingPositions.length > 0) {
        logger.info(
          {
            firstTimestamp: existingPositions[0]?.timestamp || "unknown",
            lastTimestamp:
              existingPositions[existingPositions.length - 1]?.timestamp ||
              "unknown",
          },
          "API track data range"
        );
      }
    }

    await startPolling(
      flight.fa_flight_id,
      positionData,
      flightData,
      existingPositions
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
    const updatedFlight = await db
      .collection<FlightMetadata>("flights")
      .findOneAndUpdate(
        { fa_flight_id: faFlightId },
        {
          $set: updateFields,
        },
        { returnDocument: "after" }
      );

    // Broadcast final update
    logger.info({ faFlightId }, "Broadcasting flight completion");
    broadcastUpdate("flight_completed", updatedFlight);

    return true;
  } catch (error) {
    logger.error({ err: error, faFlightId }, "Error stopping flight tracking");
    return false;
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

// Add utility functions for calculating flight status data
function calculateProgressFromPositions(
  flightTrack: FlightTrackObject[],
  lastPosition: FlightTrackObject,
  origin: any,
  destination: any,
  filedEte: number
): number {
  // If no track data or no actual_off, calculate based on scheduled times
  if (!flightTrack.length || flightTrack.length < 2) {
    return 0;
  }

  // Calculate total distance
  const totalDistance = calculateDistance(
    origin.latitude,
    origin.longitude,
    destination.latitude,
    destination.longitude
  );

  // Calculate distance traveled
  const distanceTraveled = calculateDistance(
    origin.latitude,
    origin.longitude,
    lastPosition.latitude,
    lastPosition.longitude
  );

  // Calculate progress percentage
  const progress = Math.min(
    100,
    Math.max(0, (distanceTraveled / totalDistance) * 100)
  );

  return Number(progress.toFixed(1));
}

function calculateDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  // Skip calculation if coordinates are invalid
  if (lat1 === 0 && lon1 === 0) return 0;
  if (lat2 === 0 && lon2 === 0) return 0;

  // Simple haversine formula to calculate distance between two points
  const R = 6371; // Radius of the earth in km
  const dLat = deg2rad(lat2 - lat1);
  const dLon = deg2rad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(deg2rad(lat1)) *
      Math.cos(deg2rad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c; // Distance in km
}

function deg2rad(deg: number): number {
  return deg * (Math.PI / 180);
}

function calculateDepartureDelay(
  actualOff: string | null,
  scheduledOff: string | null
): number {
  if (!actualOff || !scheduledOff) return 0;

  const actualTime = new Date(actualOff).getTime();
  const scheduledTime = new Date(scheduledOff).getTime();

  return Math.round((actualTime - scheduledTime) / 1000); // Delay in seconds
}

function calculateArrivalDelay(
  actualOn: string | null,
  scheduledOn: string | null
): number {
  if (!actualOn || !scheduledOn) return 0;

  const actualTime = new Date(actualOn).getTime();
  const scheduledTime = new Date(scheduledOn).getTime();

  return Math.round((actualTime - scheduledTime) / 1000); // Delay in seconds
}

// Add an estimated arrival time calculation
function calculateEstimatedArrival(actualOff: string | null, filedEte: number) {
  if (!actualOff) return null;

  const actualOffTime = new Date(actualOff).getTime();
  // Calculate ETA by adding filed ETE to actual takeoff time
  const estimatedArrival = new Date(actualOffTime + filedEte * 1000);
  return estimatedArrival.toISOString();
}
