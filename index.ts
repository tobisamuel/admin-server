import { type ServerWebSocket, type Server } from "bun";

import { getFlightPosition } from "./src/aeroapi";
import { jsonWithCors, handleCorsOptions } from "./src/cors";
import {
  searchScheduledFlights,
  generateFlightMetadataAndSave,
  getSavedFlights,
  deleteFlight,
} from "./src/handlers";
import { type WebSocketEvent } from "./src/types";
import { db } from "./src/utils";

const clients = new Set<ServerWebSocket>();
let pollingInterval: ReturnType<typeof setInterval> | null = null;
let currentFlightId: string | null = null;

// hard coded for now
const initialLocation = {
  latitude: -79.777778,
  longitude: -83.320833,
  heading: 0,
  timestamp: new Date().toISOString(),
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

    // Initialize flightTrack with empty array
    await db.collection("flights").updateOne(
      { fa_flight_id: faFlightId },
      {
        $set: {
          status: "active",
          flightTrack: [],
          last_update: new Date(),
        },
      }
    );

    // Clear any existing polling
    if (pollingInterval) {
      clearInterval(pollingInterval);
    }

    currentFlightId = faFlightId;

    // Start polling FlightAware API
    pollingInterval = setInterval(async () => {
      try {
        const positionData = await getFlightPosition(faFlightId);

        if (!positionData) {
          console.warn(`No position data received for flight ${faFlightId}`);
          return;
        }

        const newCoordinate = {
          latitude: positionData.latitude,
          longitude: positionData.longitude,
          heading: positionData.heading,
          timestamp: positionData.timestamp,
        };

        // Update flight data in database
        await db.collection("flights").updateOne(
          { fa_flight_id: faFlightId },
          {
            $set: {
              last_update: new Date(),
            },
            $push: { flightTrack: newCoordinate } as any,
          }
        );

        // Broadcast update to all clients
        broadcastUpdate("position_update", {
          flight_id: faFlightId,
          position: newCoordinate,
        });
      } catch (error) {
        console.error("Error polling flight position:", error);
        // Don't stop polling on temporary errors
      }
    }, 45000); // Poll every 45 seconds to respect API rate limits

    return true;
  } catch (error) {
    console.error("Error starting flight tracking:", error);
    return false;
  }
}

async function stopPolling(faFlightId: string) {
  try {
    // Check if this is the currently tracked flight
    if (currentFlightId !== faFlightId) {
      throw new Error("This flight is not currently being tracked");
    }

    // Update last update time
    await db.collection("flights").updateOne(
      { fa_flight_id: faFlightId },
      {
        $set: {
          last_update: new Date(),
        },
      }
    );

    // Stop polling
    if (pollingInterval) {
      clearInterval(pollingInterval);
      pollingInterval = null;
    }
    currentFlightId = null;

    // Broadcast final update
    broadcastUpdate("flight_completed", { fa_flight_id: faFlightId });

    return true;
  } catch (error) {
    console.error("Error stopping flight tracking:", error);
    return false;
  }
}

async function getInitialState() {
  const activeFlightData = await db
    .collection("flights")
    .findOne({ status: "active" });

  return {
    initial_location: initialLocation,
    client_count: clients.size,
    current_flight: activeFlightData,
  };
}

function broadcastUpdate<T>(event: string, data: T) {
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

      // Send initial state as a structured event
      getInitialState().then((state) => {
        const initialStateEvent = {
          event: "initial_state",
          data: state,
        };
        ws.send(JSON.stringify(initialStateEvent));
      });

      broadcastUpdate("client_count", clients.size);
      console.log(`Client connected. Total clients: ${clients.size}`);
    },
    message(ws: ServerWebSocket, message: string | Buffer) {
      console.log("Received message:", message.toString());
    },
    close(ws: ServerWebSocket) {
      clients.delete(ws);
      ws.unsubscribe("flight-updates");
      broadcastUpdate("client_count", clients.size);
      console.log(`Client disconnected. Total clients: ${clients.size}`);
    },
  },
});

console.log(`Admin server running at ${server.hostname}:${server.port}`);
