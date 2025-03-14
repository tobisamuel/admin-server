import { type ServerWebSocket, type Server } from "bun";

import { getFlightPosition, getFlightInfo } from "./src/aeroapi";
import { jsonWithCors, handleCorsOptions } from "./src/cors";
import {
  searchScheduledFlights,
  generateFlightMetadataAndSave,
  getSavedFlights,
  deleteFlight,
} from "./src/handlers";
import { type FlightMetadata, type WebSocketEvent, type WebSocketEventType } from "./src/types";
import { calculateCountriesVisited, db } from "./src/utils";

const clients = new Set<ServerWebSocket>();
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let currentFlightId: string | null = null;

const server = Bun.serve({
  port: process.env.PORT || 3001,
  routes: {
    // Flight management endpoints
    "/api/flights/search": {
      POST: searchScheduledFlights,
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
    // Tracking control endpoints
    "/api/tracking/start": {
      POST: handleStartTracking,
      OPTIONS: handleCorsOptions,
    },
    "/api/tracking/stop": {
      POST: handleStopTracking,
      OPTIONS: handleCorsOptions,
    },
    // Manual update endpoint
    "/api/flights/manual-update": {
      POST: handleManualUpdate,
      OPTIONS: handleCorsOptions,
    },
    // Status endpoint
    "/api/status": {
      GET: async (_req: Request): Promise<Response> => {
        const status = await getInitialState();
        return jsonWithCors(status);
      },
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
      broadcastUpdate("client_count", clients.size);
    },
    message(ws: ServerWebSocket, message: string | Buffer) {
      console.log("Received message:", message.toString());
    },
    close(ws: ServerWebSocket) {
      clients.delete(ws);
      ws.unsubscribe("flight-updates");
      broadcastUpdate("client_count", clients.size);
    },
  },
});

console.log(`Admin server running at ${server.hostname}:${server.port}`);

// hard coded for now
const initialLocation = {
  country: "Antartica",
  latitude: -79.777778,
  longitude: -83.320833,
  heading: 0,
  timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
};

async function startPolling(faFlightId: string) {
  try {
    // First check if flight exists
    const flight = await db.collection("flights").findOne({
      fa_flight_id: faFlightId,
    });

    if (!flight) {
      throw new Error("Flight not found");
    }

    // Initialize flightTrack with empty array and set status to active
    await db.collection("flights").updateOne(
      { fa_flight_id: faFlightId },
      {
        $set: {
          status: "active",
          flightTrack: [],
          "realtimeData.last_update": new Date(),
        },
      }
    );

    // Clear any existing polling
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }

    currentFlightId = faFlightId;

    // Start polling FlightAware API for comprehensive flight data
    pollingInterval = setInterval(async () => {
      try {
        // Fetch both flight info and position data
        const [flightData, positionData] = await Promise.all([
          getFlightInfo(faFlightId),
          getFlightPosition(faFlightId),
        ]);

        const flight = flightData?.flights?.[0];
        if (!flight) {
          console.warn(`No flight data received for flight ${faFlightId}`);
          return;
        }

        // Prepare position update if available
        const newCoordinate = positionData
          ? {
              latitude: positionData.latitude,
              longitude: positionData.longitude,
              heading: positionData.heading,
              timestamp: positionData.timestamp,
            }
          : null;

        // Determine flight status
        const flightStatus = flight.status.toLowerCase().includes("delayed")
          ? "delayed"
          : flight.status === "Scheduled"
          ? "scheduled"
          : flight.status === "En Route" || flight.status === "In-Air"
          ? "in_air"
          : flight.status === "Landed" || flight.status === "Arrived"
          ? "landed"
          : flight.status === "Cancelled"
          ? "cancelled"
          : flight.status === "Diverted"
          ? "diverted"
          : "unknown";

        // Get the current flight from the database to check if status has changed
        const currentFlight = await db
          .collection("flights")
          .findOne({ fa_flight_id: faFlightId });
        const currentStatus = currentFlight?.realtimeData?.flight_status;

        // Update flight data in database
        const updateOperation: any = {
          $set: {
            "realtimeData.last_update": new Date(),
            "flightInfo.status": flight.status,
            "realtimeData.flight_status": flightStatus,
            "realtimeData.departure_delay": flight.departure_delay,
            "realtimeData.arrival_delay": flight.arrival_delay,
          },
        };

        // Add position update if available
        if (newCoordinate) {
          updateOperation.$set["realtimeData.current_position"] = newCoordinate;
          updateOperation.$push = { flightTrack: newCoordinate };
        }

        // Add status change to history if needed
        if (currentStatus !== flightStatus) {
          if (!updateOperation.$push) {
            updateOperation.$push = {};
          }
          updateOperation.$push.statusHistory = {
            status: flightStatus,
            timestamp: new Date(),
          };
        }

        await db
          .collection("flights")
          .updateOne({ fa_flight_id: faFlightId }, updateOperation);

        // Broadcast position update if available
        if (newCoordinate) {
          broadcastUpdate("position_update", {
            flight_id: faFlightId,
            position: newCoordinate,
          });
        }

        // Broadcast status update if changed
        if (currentStatus !== flightStatus) {
          broadcastUpdate("flight_status_update", {
            flight_id: faFlightId,
            status: flightStatus,
            departure_delay: flight.departure_delay,
            arrival_delay: flight.arrival_delay,
          });
        }

        // Check if flight is completed or cancelled
        if (
          ["Landed", "Arrived", "Completed", "Cancelled"].includes(
            flight.status
          )
        ) {
          await stopPolling(faFlightId);
        }
      } catch (error) {
        console.error("Error polling flight data:", error);
        // Don't stop polling on temporary errors
      }
    }, 60000); // Poll every 60 seconds to respect API rate limits

    return true;
  } catch (error) {
    console.error("Error starting flight tracking:", error);
    return false;
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

    // Update flight status to completed
    await db.collection("flights").updateOne(
      { fa_flight_id: faFlightId },
      {
        $set: {
          status: "completed",
          "realtimeData.last_update": new Date(),
          "realtimeData.flight_status": "landed",
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

async function getInitialState() {
  const flights = await db.collection<FlightMetadata>("flights").find({}).toArray();
  const completedFlights = flights.filter((f) => f.status === "completed");
  const activeFlightData = flights.find((f) => f.status === "active") || null;

  return {
    stats: {
      total_miles: completedFlights.reduce((acc, f) => acc + f.flightInfo.route_distance, 0),
      total_countries: calculateCountriesVisited(completedFlights),
      total_flights: completedFlights.length,
      last_updated: new Date(),
    },
    client_count: clients.size,
    current_location: initialLocation,
    current_flight: activeFlightData,
    flights: flights.map((f) => ({
      ...f,
      flightTrack: f.flightTrack || [],
      statusHistory: f.statusHistory || [],
      manualUpdates: f.manualUpdates || [],
    })),
  };
}

function broadcastUpdate<T>(event: WebSocketEventType, data: T) {
  const update: WebSocketEvent<T> = { event, data };
  server.publish("flight-updates", JSON.stringify(update));
}

// Modified route handlers for tracking
async function handleStartTracking(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as { fa_flight_id: string };

    if (!body.fa_flight_id) {
      return jsonWithCors({ error: "Missing flight ID" }, { status: 400 });
    }

    const success = await startPolling(body.fa_flight_id);

    if (success) {
      return jsonWithCors({ message: "Tracking started successfully" });
    } else {
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

async function handleManualUpdate(req: Request): Promise<Response> {
  try {
    const { fa_flight_id, message } = (await req.json()) as {
      fa_flight_id: string;
      message: string;
    };

    if (!fa_flight_id || !message) {
      return jsonWithCors(
        { error: "Missing flight ID or message" },
        { status: 400 }
      );
    }

    const flight = await db.collection("flights").findOne({ fa_flight_id });
    if (!flight) {
      return jsonWithCors({ error: "Flight not found" }, { status: 404 });
    }

    await db
      .collection("flights")
      .updateOne(
        { fa_flight_id },
        { $push: { manualUpdates: { message, timestamp: new Date() } } as any }
      );

    broadcastUpdate("manual_update", {
      flight_id: fa_flight_id,
      message,
      timestamp: new Date(),
    });
    return jsonWithCors({ message: "Manual update sent" });
  } catch (error) {
    console.error("Error sending manual update:", error);
    return jsonWithCors(
      { error: "Failed to send manual update" },
      { status: 500 }
    );
  }
}




