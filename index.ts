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
import {
  type FlightMetadata,
  type FlightPositionResponse,
  type FlightInfoResponse,
  type FlightTrackObject,
  type WebSocketEvent,
  type WebSocketEventType,
} from "./src/types";
import { getCountriesVisited, db, standardizeFlightStatus } from "./src/utils";

const clients = new Set<ServerWebSocket>();
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let currentFlightId: string | null = null;

// Add cleanup logic for server shutdown at the top level
process.once("SIGTERM", async () => {
  console.log("SIGTERM received, cleaning up flight tracking");
  if (currentFlightId) {
    await stopPolling(currentFlightId, true);
  }
});

process.once("SIGINT", async () => {
  console.log("SIGINT received, cleaning up flight tracking");
  if (currentFlightId) {
    await stopPolling(currentFlightId, true);
  }
});

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
    console.error("Server error:", error);
    return new Response(`Internal Server Error: ${error.message}`, {
      status: 500,
    });
  },
  websocket: {
    open(ws: ServerWebSocket) {
      clients.add(ws);
      ws.subscribe("flight-updates");

      // Send initial state to the new client
      getInitialState().then((state) => {
        ws.send(
          JSON.stringify({
            event: "initial_state",
            data: state,
          })
        );
      });

      // Broadcast updated client count to all clients
      broadcastUpdate("client_added", clients.size);
    },
    message(ws: ServerWebSocket, message: string | Buffer) {
      console.log("Received message:", message.toString());
    },
    close(ws: ServerWebSocket) {
      clients.delete(ws);
      ws.unsubscribe("flight-updates");
      broadcastUpdate("client_removed", clients.size);
    },
  },
});

console.log(`Admin server running at ${server.hostname}:${server.port}`);

// Restore tracking state after server is initialized
restoreTrackingState().catch((error) => {
  console.error("Failed to restore tracking state:", error);
});

function broadcastUpdate<T>(event: WebSocketEventType, data: T) {
  const update: WebSocketEvent<T> = { event, data };
  server.publish("flight-updates", JSON.stringify(update));
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
    client_count: clients.size,
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

  currentFlightId = faFlightId;

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
    console.log(
      `Found existing flight track with ${existingFlight.flightTrack.length} positions`
    );

    // Create a map of existing positions by timestamp for quick lookup
    const existingPositionMap = new Map<string, FlightTrackObject>();
    existingFlight.flightTrack.forEach((pos) => {
      existingPositionMap.set(pos.timestamp, pos);
    });

    // Add new positions that don't already exist
    const newPositions = positions.filter(
      (pos) => !existingPositionMap.has(pos.timestamp)
    );
    console.log(`Adding ${newPositions.length} new positions from track data`);

    // Combine existing and new positions
    mergedTrackData = [...existingFlight.flightTrack, ...newPositions];

    // Sort by timestamp to ensure chronological order
    mergedTrackData.sort(
      (a, b) =>
        new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()
    );

    console.log(`Merged track now has ${mergedTrackData.length} positions`);
  } else {
    // No existing track data, just use the new positions
    mergedTrackData = positions;
    console.log(
      `No existing flight track, using ${mergedTrackData.length} positions from API`
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
      console.log(`Verifying tracking status for flight ${faFlightId}`);
      const flightStatus = await db
        .collection<FlightMetadata>("flights")
        .findOne({
          fa_flight_id: faFlightId,
          is_tracking: true,
        });

      if (!flightStatus) {
        console.log(
          `Flight ${faFlightId} is no longer being tracked in the database, stopping polling`
        );
        await stopPolling(faFlightId);
        return;
      }

      // Only fetch position data during polling
      console.log(`Fetching position data for flight ${faFlightId}`);
      const newPositionData = await getFlightPosition(faFlightId);
      console.log(
        `Received position data for flight ${faFlightId}:`,
        newPositionData
          ? JSON.stringify(newPositionData.last_position).substring(0, 200) +
              "..."
          : "null"
      );

      if (!newPositionData || !newPositionData.last_position) {
        console.warn(`No position data received for flight ${faFlightId}`);
        consecutiveErrors++;

        if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          console.error(
            `Too many consecutive errors (${consecutiveErrors}) for flight ${faFlightId}, stopping polling`
          );
          await stopPolling(faFlightId);
          return;
        }

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
        console.log(
          `Position with timestamp ${newPositionData.last_position.timestamp} already exists, skipping update`
        );
        return;
      }

      // Update flight track data in database with new position
      console.log(`Updating flight track in database for flight ${faFlightId}`);
      await db.collection<FlightMetadata>("flights").updateOne(
        { fa_flight_id: faFlightId },
        {
          $push: { flightTrack: newPositionData.last_position },
        }
      );

      // Broadcast position update
      console.log(`Broadcasting position update for flight ${faFlightId}`);
      broadcastUpdate("position_update", {
        flight_id: faFlightId,
        position: newPositionData.last_position,
      });
      console.log(
        `Position update broadcast completed for flight ${faFlightId}`
      );
    } catch (error) {
      console.error(
        `Error polling flight position data for flight ${faFlightId}:`,
        error
      );

      consecutiveErrors++;

      if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
        console.error(
          `Too many consecutive errors (${consecutiveErrors}) for flight ${faFlightId}, stopping polling`
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
        console.log(`Flight ${faFlightId} is already being tracked`);
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
      console.error("Error starting flight tracking:", error);
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
    console.log(
      "Checking for flights that were being tracked before server restart..."
    );
    const trackedFlights = await db
      .collection<FlightMetadata>("flights")
      .find({ is_tracking: true })
      .toArray();

    if (trackedFlights.length === 0) {
      console.log("No flights were being tracked before server restart");
      return;
    }

    if (trackedFlights.length > 1) {
      console.warn(
        `Found ${trackedFlights.length} flights marked as tracking. This should not happen.`
      );
      // Reset all tracking flags as a safety measure
      await db
        .collection("flights")
        .updateMany({ is_tracking: true }, { $set: { is_tracking: false } });
      return;
    }

    const flight = trackedFlights[0];
    if (!flight || !flight.fa_flight_id) {
      console.error("Found invalid flight data during state restoration");
      return;
    }

    console.log(
      `Found flight ${flight.fa_flight_id} that was being tracked. Restarting tracking...`
    );

    // Log existing track data for debugging
    if (flight.flightTrack && flight.flightTrack.length > 0) {
      console.log(
        `Flight has ${flight.flightTrack.length} existing position records`
      );
      console.log(
        `First position timestamp: ${
          flight.flightTrack[0]?.timestamp || "unknown"
        }`
      );
      console.log(
        `Last position timestamp: ${
          flight.flightTrack[flight.flightTrack.length - 1]?.timestamp ||
          "unknown"
        }`
      );
    } else {
      console.log(`Flight has no existing position records`);
    }

    // Fetch initial flight data from multiple sources in parallel
    const [flightData, positionData] = await Promise.all([
      getFlightInfo(flight.fa_flight_id),
      getFlightPosition(flight.fa_flight_id),
    ]);

    if (positionData && positionData.last_position) {
      console.log(
        `Retrieved current position data from API with timestamp: ${positionData.last_position.timestamp}`
      );
    } else {
      console.log(
        `Retrieved position data from API but no last_position available`
      );
    }

    // Determine if we need historical track data
    const currentTime = new Date();
    const firstPositionTime = new Date(positionData.first_position_time);
    const bufferTime = 5 * 60 * 1000; // 5 minutes buffer
    let positions: FlightTrackObject[] = [];

    if (currentTime.getTime() > firstPositionTime.getTime() + bufferTime) {
      // We need historical data if we're starting tracking after first position time
      console.log(`Fetching historical track data from API...`);
      const res = await getFlightTrack(flight.fa_flight_id);
      positions = res.positions;
      console.log(
        `Retrieved ${positions.length} historical positions from API`
      );

      if (positions && positions.length > 0) {
        console.log(
          `API track data range: ${positions[0]?.timestamp || "unknown"} to ${
            positions[positions.length - 1]?.timestamp || "unknown"
          }`
        );
      }
    }

    await startPolling(
      flight.fa_flight_id,
      positionData,
      flightData,
      positions
    );

    console.log(
      `Flight tracking successfully restored for ${flight.fa_flight_id}`
    );
  } catch (error) {
    console.error("Error restoring tracking state:", error);
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

async function stopPolling(faFlightId: string, forceStop: boolean = false) {
  try {
    console.log(`Stopping polling for flight ${faFlightId}`);

    // Clear polling interval
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    // Check if this is the currently tracked flight
    if (currentFlightId !== faFlightId) {
      console.warn(
        `Attempted to stop polling for ${faFlightId} but current flight ID is ${currentFlightId}`
      );
      throw new Error("This flight is not currently being tracked");
    }

    currentFlightId = null;

    // Get the current flight data
    const flight = await db
      .collection("flights")
      .findOne({ fa_flight_id: faFlightId });
    if (!flight) {
      throw new Error("Flight not found");
    }

    // Get the latest flight status from the API
    console.log(`Fetching final flight data from API for ${faFlightId}`);
    let finalStatus = "completed"; // Default fallback status
    let finalFlightData = null;

    try {
      finalFlightData = await getFlightInfo(faFlightId);

      if (finalFlightData?.flights?.[0]) {
        const apiStatus = finalFlightData.flights[0].status;
        console.log(`API reports flight status as: ${apiStatus}`);

        // Determine the appropriate status based on API response and force flag
        if (forceStop) {
          console.log(
            `Force stop requested, marking as completed regardless of API status`
          );
          finalStatus = "completed";
        } else if (apiStatus) {
          finalStatus = apiStatus;
          console.log(`Using API status: ${finalStatus}`);
        }
      } else {
        console.log(
          `No flight status available from API, using default: ${finalStatus}`
        );
      }
    } catch (error) {
      console.error(`Error fetching final flight status from API: ${error}`);
      console.log(`Using default status: ${finalStatus}`);
    }

    // Standardize the status
    const standardizedStatus = standardizeFlightStatus(finalStatus);

    // Update flight status and set is_tracking to false with all relevant data
    console.log(`Updating flight ${faFlightId} status to ${finalStatus}`);
    const updateFields: any = {
      status: finalStatus,
      standardized_status: standardizedStatus,
      is_tracking: false,
      // tracking_ended_at: new Date(),
    };

    // If we have final flight data from the API, update relevant fields
    if (finalFlightData?.flights?.[0]) {
      const apiFlightData = finalFlightData.flights[0];

      // Only update these fields if they're provided in the API response
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

    // Perform the update
    await db.collection("flights").updateOne(
      { fa_flight_id: faFlightId },
      {
        $set: updateFields,
        // $push: {
        //   statusHistory: {
        //     status: finalStatus,
        //     standardized_status: standardizedStatus,
        //     source: forceStop ? "force_stop" : "api",
        //     timestamp: new Date(),
        //   } as any,
        // },
      }
    );

    // Broadcast final update
    console.log(`Broadcasting flight completion for flight ${faFlightId}`);
    broadcastUpdate("flight_completed", {
      fa_flight_id: faFlightId,
      status: finalStatus,
      standardized_status: standardizedStatus,
      completion_time: new Date().toISOString(),
      forced: forceStop,
    });

    return true;
  } catch (error) {
    console.error(
      `Error stopping flight tracking for flight ${faFlightId}:`,
      error
    );
    return false;
  }
}
