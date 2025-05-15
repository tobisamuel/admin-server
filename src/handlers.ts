import {
  getAirportInfo,
  getFlightInfo,
  getFlightPosition,
  getFlightTrack,
} from "./aeroapi";
import { jsonWithCors } from "./cors";
import {
  type AeroApiError,
  type FlightCreationData,
  type FlightSearchParams,
  type FlightSearchResponse,
  type DirectFlightResponse,
  type FlightMetadata,
  type FlightTrackObject,
} from "./types";
import { db, formatFlightData } from "./utils";
import logger from "./logger";

type Headers = Record<string, string>;

const AERO_API_KEY = process.env.AERO_API_KEY;
const AERO_API_BASE = "https://aeroapi.flightaware.com/aeroapi";

export const searchFlights = async (req: Request) => {
  try {
    const { startDate, endDate, origin, destination, airline, flightNumber } =
      (await req.json()) as FlightSearchParams;

    logger.info(
      { startDate, endDate, origin, destination, airline, flightNumber },
      "Searching flights"
    );

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
        logger.error(
          { error: errorData, status: response.status },
          "Failed to search flights by number"
        );
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
      logger.info({ count: data.flights.length }, "Found flights by number");

      return jsonWithCors<{ flights: DirectFlightResponse["flights"] }>({
        flights: data.flights,
      });
    }

    // Otherwise, use the schedules endpoint
    if (!startDate || !endDate) {
      logger.warn(
        { startDate, endDate },
        "Missing required dates for schedule search"
      );
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
      logger.error(
        { error: errorData, status: response.status },
        "Failed to search flights by schedule"
      );
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
    logger.info({ count: data.scheduled.length }, "Found flights by schedule");

    return jsonWithCors<{
      flights: FlightSearchResponse["scheduled"];
    }>({
      flights: data.scheduled,
    });
  } catch (error) {
    logger.error({ err: error }, "Error searching flights");
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
    const { fa_flight_id, origin, destination, is_last_flight } =
      (await req.json()) as FlightCreationData;

    logger.info(
      { fa_flight_id, origin, destination, is_last_flight },
      "Generating flight metadata"
    );

    // Check for existing flight
    const existingFlight = await db
      .collection<FlightMetadata>("flights")
      .findOne({ fa_flight_id });

    if (existingFlight) {
      logger.info({ fa_flight_id }, "Flight already exists in database");
      return jsonWithCors(
        {
          error: "Flight already exists in database",
        },
        { status: 409 }
      );
    }

    const [
      originAirportInfo,
      destinationAirportInfo,
      flightResponse,
      flightTrack,
    ] = await Promise.all([
      getAirportInfo(origin),
      getAirportInfo(destination),
      getFlightInfo(fa_flight_id),
      getFlightTrack(fa_flight_id),
    ]);

    if (!flightResponse?.flights || flightResponse.flights.length === 0) {
      logger.warn({ fa_flight_id }, "Flight information not found in AeroAPI");
      return jsonWithCors(
        {
          error: "Flight information not found for the provided fa_flight_id",
        },
        { status: 404 }
      );
    }

    const flight = flightResponse.flights[0]!;
    const flightMetadata = formatFlightData(
      flight,
      originAirportInfo,
      destinationAirportInfo,
      flightTrack.positions
    );

    flightMetadata.is_last_flight = is_last_flight;

    await db.collection("flights").insertOne(flightMetadata);

    logger.info(
      { fa_flight_id },
      "Flight metadata generated and saved successfully"
    );

    return jsonWithCors({
      message: "Flight metadata generated and saved",
    });
  } catch (error) {
    logger.error({ err: error }, "Error generating flight metadata");

    return jsonWithCors(
      {
        error: "Failed to generate flight metadata",
      },
      { status: 500 }
    );
  }
};

export const getSavedFlights = async (req: Request) => {
  const flights = await db
    .collection<FlightMetadata>("flights")
    .find({})
    .toArray();

  return jsonWithCors<typeof flights>(flights);
};

export const deleteFlight = async (req: Request) => {
  try {
    const { id } = (await req.json()) as { id: string };

    logger.info({ fa_flight_id: id }, "Attempting to delete flight");

    // Check if flight exists and is not being tracked
    const flight = await db
      .collection<FlightMetadata>("flights")
      .findOne({ fa_flight_id: id });

    if (!flight) {
      logger.warn({ fa_flight_id: id }, "Flight not found for deletion");
      return jsonWithCors(
        {
          error: "Flight not found",
        },
        { status: 404 }
      );
    }

    if (flight.is_tracking) {
      logger.warn(
        { fa_flight_id: id },
        "Cannot delete flight that is currently being tracked"
      );
      return jsonWithCors(
        {
          error: "Cannot delete flight that is currently being tracked",
        },
        { status: 400 }
      );
    }

    const result = await db
      .collection("flights")
      .deleteOne({ fa_flight_id: id });

    if (result.deletedCount === 0) {
      logger.error({ fa_flight_id: id }, "Failed to delete flight");
      return jsonWithCors(
        {
          error: "Failed to delete flight",
        },
        { status: 500 }
      );
    }

    logger.info({ fa_flight_id: id }, "Flight deleted successfully");

    return jsonWithCors({ message: "Flight deleted" });
  } catch (error) {
    logger.error({ err: error }, "Error deleting flight");
    return jsonWithCors(
      {
        error: "Failed to delete flight",
      },
      { status: 500 }
    );
  }
};

export const updateWaypoints = async (req: Request) => {
  const { fa_flight_id } = (await req.json()) as {
    fa_flight_id: string;
  };

  const flight = await db.collection<FlightMetadata>("flights").findOne({
    fa_flight_id,
  });

  if (!flight) {
    return jsonWithCors(
      {
        error: "Flight not found",
      },
      { status: 404 }
    );
  }

  const data = await getFlightPosition(fa_flight_id);

  if (!data.waypoints || data.waypoints.length === 0) {
    return jsonWithCors(
      { message: "No waypoints available for this flight" },
      { status: 200 }
    );
  }

  try {
    // Only reaches here if we have valid waypoints
    await db.collection("flights").updateOne(
      { fa_flight_id },
      {
        $set: {
          waypoints: data.waypoints,
        },
      }
    );

    return jsonWithCors({
      status: "success",
      message: "Waypoints updated successfully",
      waypoints_count: data.waypoints.length,
    });
  } catch (error) {
    console.error("Error updating waypoints:", error);
    return jsonWithCors(
      {
        status: "error",
        message: "Failed to update waypoints in database",
        error: error instanceof Error ? error.message : "Unknown error",
      },
      { status: 500 }
    );
  }
};
export const updateFlightPath = async (req: Request) => {
  const { fa_flight_id, flightTrack } = (await req.json()) as {
    fa_flight_id: string;
    flightTrack: FlightTrackObject[];
  };

  const flight = await db.collection<FlightMetadata>("flights").findOne({
    fa_flight_id,
  });

  if (!flight) {
    return jsonWithCors({ error: "Flight not found" }, { status: 404 });
  }

  await db.collection("flights").updateOne(
    { fa_flight_id },
    {
      $set: {
        flightTrack: flightTrack,
      },
    }
  );

  return jsonWithCors({
    status: "success",
    message: "Flight path updated successfully",
  });
};
