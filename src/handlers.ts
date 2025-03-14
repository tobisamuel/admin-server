import { jsonWithCors } from "./cors";
import { db } from "./utils";
import {
  type FlightData,
  type FlightSearchResponse,
  type DirectFlightResponse,
  type FlightMetadata,
  type WebSocketEventType,
} from "./types";
import { getAirportInfo, getFlightInfo, getFlightRouteData } from "./aeroapi";

type Headers = Record<string, string>;

interface AeroApiError {
  title: string;
  reason: string;
  detail: string;
  status: number;
}

interface FlightSearchParams {
  startDate?: string;
  endDate?: string;
  origin?: string;
  destination?: string;
  airline?: string;
  flightNumber?: string;
}

const AERO_API_KEY = process.env.AERO_API_KEY;
const AERO_API_BASE = "https://aeroapi.flightaware.com/aeroapi";
const WS_SERVER_URL = process.env.WS_SERVER_URL || "http://localhost:3002";

export const searchScheduledFlights = async (req: Request) => {
  try {
    const { startDate, endDate, origin, destination, airline, flightNumber } =
      (await req.json()) as FlightSearchParams;

    // If we have a flight number, use the direct flight endpoint
    if (flightNumber) {
      const params = new URLSearchParams();
      if (startDate) params.set("start", startDate);
      if (endDate) params.set("end", endDate);

      const url = `${AERO_API_BASE}/flights/${flightNumber}?${params.toString()}`;

      const response = await fetch(url, {
        headers: {
          "x-apikey": AERO_API_KEY!,
        } as Headers,
      });

      if (!response.ok) {
        const errorData = (await response.json()) as AeroApiError;
        return jsonWithCors(
          {
            error: errorData.detail || "Failed to search flights",
            title: errorData.title,
            reason: errorData.reason,
          },
          { status: response.status }
        );
      }

      const data = (await response.json()) as DirectFlightResponse;
      return jsonWithCors({
        flights: data.flights,
      });
    }

    // Otherwise, use the schedules endpoint
    if (!startDate || !endDate) {
      return jsonWithCors(
        {
          error: "startDate and endDate are required for schedule searches",
        },
        { status: 400 }
      );
    }

    const params = new URLSearchParams();
    if (origin) params.set("origin", origin);
    if (destination) params.set("destination", destination);
    if (airline) params.set("airline", airline);

    const url = `${AERO_API_BASE}/schedules/${startDate}/${endDate}?${params.toString()}`;

    const response = await fetch(url, {
      headers: {
        "x-apikey": AERO_API_KEY!,
      } as Headers,
    });

    if (!response.ok) {
      const errorData = (await response.json()) as AeroApiError;
      return jsonWithCors(
        {
          error: errorData.detail || "Failed to search flights",
          title: errorData.title,
          reason: errorData.reason,
        },
        { status: response.status }
      );
    }

    const data = (await response.json()) as FlightSearchResponse;

    return jsonWithCors({
      flights: data.scheduled,
    });
  } catch (error) {
    console.error("Error searching flights:", error);

    return jsonWithCors(
      {
        error: "Failed to search flights",
      },
      { status: 500 }
    );
  }
};

export const generateFlightMetadataAndSave = async (req: Request) => {
  try {
    const { fa_flight_id, origin, destination } =
      (await req.json()) as FlightData;

    console.log("origin", origin);
    console.log("destination", destination);
    const [
      originAirportInfo,
      destinationAirportInfo,
      flightInfo,
      { route_distance, fixes },
    ] = await Promise.all([
      getAirportInfo(origin),
      getAirportInfo(destination),
      getFlightInfo(fa_flight_id),
      getFlightRouteData(fa_flight_id),
    ]);

    // Check if flightInfo.flights is empty or undefined
    if (!flightInfo?.flights || flightInfo.flights.length === 0) {
      return jsonWithCors(
        {
          error: "Flight information not found for the provided fa_flight_id",
        },
        { status: 404 } // Return a 404 Not Found status
      );
    }

    const flight = flightInfo.flights[0];
    // We've already checked that flight exists
    const flightMetadata = {
      fa_flight_id,
      flightInfo: flight,
      route_distance,
      coordinates: fixes,
      status: "scheduled",
      flightTrack: [],
      statusHistory: [{ status: "scheduled", timestamp: new Date() }],
      manualUpdates: [],
      realtimeData: {
        last_update: new Date(),
        flight_status: "scheduled",
        departure_delay: flight?.departure_delay || 0,
        arrival_delay: flight?.arrival_delay || 0,
      },
    };

    await db.collection("flights").insertOne(flightMetadata);

    // If you have a broadcastUpdate function
    // broadcastUpdate("flight_added", flightMetadata);

    return jsonWithCors({
      message: "Flight metadata generated and saved",
    });
  } catch (error) {
    console.error("Error generating flight metadata:", error);

    return jsonWithCors(
      {
        error: "Failed to generate flight metadata",
      },
      { status: 500 }
    );
  }
};

export const getSavedFlights = async (req: Request) => {
  const flights = await db.collection("flights").find({}).toArray();

  return jsonWithCors({
    flights,
  });
};

export const deleteFlight = async (req: Request) => {
  const { id } = (await req.json()) as { id: string };

  await db.collection("flights").deleteOne({ fa_flight_id: id });

  return jsonWithCors({ message: "Flight deleted" });
};

export const startTracking = async (req: Request) => {
  try {
    const body = (await req.json()) as { fa_flight_id: string };
    const { fa_flight_id } = body;

    // First check if the flight exists
    const flight = await db.collection("flights").findOne({ fa_flight_id });
    if (!flight) {
      return jsonWithCors({ error: "Flight not found" }, { status: 404 });
    }

    // Update the flight status in the database
    await db.collection("flights").updateOne(
      { fa_flight_id },
      {
        $set: {
          status: "active",
          realtime_data: {
            last_update: new Date(),
            flight_status: "scheduled",
          },
        },
      }
    );

    // Then notify the WebSocket server to start polling
    const wsServerUrl = new URL("/admin/start-polling", WS_SERVER_URL);
    wsServerUrl.searchParams.set("flightId", fa_flight_id);

    const response = await fetch(wsServerUrl);
    if (!response.ok) {
      // If WebSocket server fails, revert the status
      await db.collection("flights").updateOne(
        { fa_flight_id },
        {
          $set: {
            status: "scheduled",
            $unset: { realtime_data: "" },
          },
        }
      );
      throw new Error("Failed to start polling");
    }

    return jsonWithCors({
      message: "Tracking started successfully",
    });
  } catch (error) {
    console.error("Error starting tracking:", error);
    return jsonWithCors(
      {
        error: "Failed to start tracking",
      },
      { status: 500 }
    );
  }
};

export const stopTracking = async (req: Request) => {
  try {
    const body = (await req.json()) as { fa_flight_id: string };
    const { fa_flight_id } = body;

    // First check if the flight exists and is currently active
    const flight = await db.collection("flights").findOne({
      fa_flight_id,
      status: "active",
    });

    if (!flight) {
      return jsonWithCors(
        { error: "Flight not found or not currently active" },
        { status: 404 }
      );
    }

    // Update the flight status in the database
    await db.collection("flights").updateOne(
      { fa_flight_id },
      {
        $set: {
          status: "completed",
          "realtime_data.flight_status": "landed",
          "realtime_data.last_update": new Date(),
        },
      }
    );

    // Then notify the WebSocket server to stop polling
    const wsServerUrl = new URL("/admin/stop-polling", WS_SERVER_URL);
    const response = await fetch(wsServerUrl);
    if (!response.ok) {
      // If WebSocket server fails, revert the status
      await db.collection("flights").updateOne(
        { fa_flight_id },
        {
          $set: {
            status: "active",
            "realtime_data.flight_status": "in_air",
          },
        }
      );
      throw new Error("Failed to stop polling");
    }

    return jsonWithCors({
      message: "Tracking stopped successfully",
    });
  } catch (error) {
    console.error("Error stopping tracking:", error);
    return jsonWithCors(
      {
        error: "Failed to stop tracking",
      },
      { status: 500 }
    );
  }
};
