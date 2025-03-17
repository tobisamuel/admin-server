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
  type WebSocketEvent,
  type WebSocketEventType,
} from "./src/types";
import { getCountriesVisited, db, standardizeFlightStatus } from "./src/utils";

const clients = new Set<ServerWebSocket>();
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let currentFlightId: string | null = null;

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
      const flight = await db.collection("flights").findOne({
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
      let trackData: {
        positions: Array<{
          fa_flight_id: string | null;
          altitude: number;
          altitude_change: string;
          groundspeed: number;
          heading: number;
          latitude: number;
          longitude: number;
          timestamp: string;
          update_type: string;
        }>;
      } = { positions: [] };

      if (currentTime.getTime() > firstPositionTime.getTime() + bufferTime) {
        // We need historical data if we're starting tracking after first position time
        trackData = await getFlightTrack(faFlightId);
      }

      // update the flight with the new data
      const updatedFlight = await db
        .collection<FlightMetadata>("flights")
        .findOneAndUpdate(
          { fa_flight_id: faFlightId },
          {
            $set: {
              status: flightData?.flights?.[0]?.status,
              standardized_status: flightData?.flights?.[0]?.status
                ? standardizeFlightStatus(flightData?.flights?.[0]?.status)
                : "unknown",
              is_tracking: true,
              waypoints: positionData.waypoints,
              flightTrack: trackData.positions,
            },
          },
          { returnDocument: "after" }
        );

      // Clear any existing polling
      if (pollingInterval) {
        clearInterval(pollingInterval);
      }

      currentFlightId = faFlightId;

      broadcastUpdate("start_flight", {
        flight: updatedFlight,
        current_position: {
          latitude: positionData.last_position.latitude,
          longitude: positionData.last_position.longitude,
          heading: positionData.last_position.heading,
          timestamp: positionData.last_position.timestamp,
        },
      });

      // Variables for retry mechanism
      let consecutiveErrors = 0;
      const MAX_CONSECUTIVE_ERRORS = 3;
      const RETRY_DELAY_BASE = 5000; // 5 seconds base delay

      // Start polling FlightAware API for position updates only
      pollingInterval = setInterval(async () => {
        try {
          // Only fetch position data during polling
          const newPositionData = await getFlightPosition(faFlightId);

          if (!newPositionData || !newPositionData.last_position) {
            console.warn(`No position data received for flight ${faFlightId}`);
            consecutiveErrors++;

            if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
              console.error(
                `Too many consecutive errors for flight ${faFlightId}, stopping polling`
              );
              await stopPolling(faFlightId);
              return;
            }

            return;
          }

          // Reset error counter on successful data fetch
          consecutiveErrors = 0;

          // Update flight track data in database with new position
          await db.collection<FlightMetadata>("flights").updateOne(
            { fa_flight_id: faFlightId },
            {
              $push: { flightTrack: newPositionData.last_position },
            }
          );

          // Broadcast position update
          broadcastUpdate("position_update", {
            flight_id: faFlightId,
            position: newPositionData.last_position,
          });

          // Periodically check flight status (less frequently)
          // This could be implemented as a separate interval if needed
        } catch (error) {
          console.error("Error polling flight position data:", error);

          consecutiveErrors++;

          // Implement exponential backoff for retries
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
            console.error(
              `Too many consecutive errors for flight ${faFlightId}, stopping polling`
            );
            await stopPolling(faFlightId);
            return;
          }

          // Don't stop polling on temporary errors, but log them
        }
      }, 60000); // Poll every 60 seconds to respect API rate limits

      // Add cleanup logic for server shutdown
      process.once("SIGTERM", async () => {
        console.log("SIGTERM received, cleaning up flight tracking");
        if (currentFlightId) {
          await stopPolling(currentFlightId);
        }
      });

      process.once("SIGINT", async () => {
        console.log("SIGINT received, cleaning up flight tracking");
        if (currentFlightId) {
          await stopPolling(currentFlightId);
        }
      });

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

async function handleStopTracking(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { fa_flight_id: string };

    if (!body.fa_flight_id) {
      return jsonWithCors({ error: "Missing flight ID" }, { status: 400 });
    }

    const success = await stopPolling(body.fa_flight_id);

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

async function stopPolling(faFlightId: string) {
  try {
    // Clear polling interval
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }

    // Check if this is the currently tracked flight
    if (currentFlightId !== faFlightId) {
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

    // Update flight status to completed and set is_tracking to false
    await db.collection("flights").updateOne(
      { fa_flight_id: faFlightId },
      {
        $set: {
          status: "completed",
          is_tracking: false,
        },
        $push: {
          statusHistory: {
            status: "completed",
            timestamp: new Date(),
          },
        } as any,
      }
    );

    // Broadcast final update
    broadcastUpdate("flight_completed", {
      fa_flight_id: faFlightId,
      completion_time: new Date().toISOString(),
    });

    return true;
  } catch (error) {
    console.error("Error stopping flight tracking:", error);
    return false;
  }
}
