import { MongoClient } from "mongodb";

import type {
  AirportResponse,
  DetailedFlight,
  FlightMetadata,
  FlightTrackResponse,
} from "./types";

let MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error(
    "Please define the MONGODB_URI environment variable inside .env"
  );
}

const client: MongoClient = await MongoClient.connect(MONGODB_URI);

const db = client.db("alma-db");

export { db };

/**
 * Formats flight and airport data into a standardized structure
 * @param flight The detailed flight information from the API
 * @param originAirportInfo Information about the origin airport
 * @param destinationAirportInfo Information about the destination airport
 * @returns A formatted flight data object with all necessary fields
 */
export function formatFlightData(
  flight: DetailedFlight,
  originAirportInfo: AirportResponse,
  destinationAirportInfo: AirportResponse,
  flightTrack: FlightTrackResponse["positions"]
): FlightMetadata {
  return {
    ident: flight.ident,
    ident_icao: flight.ident_icao,
    ident_iata: flight.ident_iata,
    actual_runway_off: flight.actual_runway_off,
    actual_runway_on: flight.actual_runway_on,
    fa_flight_id: flight.fa_flight_id,
    operator: flight.operator,
    operator_icao: flight.operator_icao,
    operator_iata: flight.operator_iata,
    flight_number: flight.flight_number,
    registration: flight.registration,
    atc_ident: flight.atc_ident,
    blocked: flight.blocked,
    diverted: flight.diverted,
    cancelled: flight.cancelled,
    origin: originAirportInfo,
    destination: destinationAirportInfo,
    departure_delay: flight.departure_delay,
    arrival_delay: flight.arrival_delay,
    filed_ete: flight.filed_ete,
    scheduled_out: flight.scheduled_out,
    estimated_out: flight.estimated_out,
    actual_out: flight.actual_out,
    scheduled_off: flight.scheduled_off,
    estimated_off: flight.estimated_off,
    actual_off: flight.actual_off,
    scheduled_on: flight.scheduled_on,
    estimated_on: flight.estimated_on,
    actual_on: flight.actual_on,
    scheduled_in: flight.scheduled_in,
    estimated_in: flight.estimated_in,
    actual_in: flight.actual_in,
    progress_percent: flight.progress_percent,
    status: flight.status,
    standardized_status: standardizeFlightStatus(flight.status),
    aircraft_type: flight.aircraft_type,
    route_distance: flight.route_distance,
    filed_airspeed: flight.filed_airspeed,
    filed_altitude: flight.filed_altitude,
    route: flight.route,
    is_tracking: false,
    waypoints: [],
    flightTrack: flightTrack,
  };
}

export function getCountriesVisited(flights: FlightMetadata[]) {
  if (flights.length === 0) return [];

  // Using Set to automatically handle duplicates
  const visitedCountries = new Set<string>();

  const firstCountry = flights[0]?.origin.country_code;
  // Always include the starting point (origin of first flight) regardless of completion status
  visitedCountries.add(firstCountry!);

  // Process flights in order
  flights.forEach((flight) => {
    // Only count countries from completed flights
    if (flight.standardized_status === "completed") {
      // Add both origin and destination countries for all flights
      visitedCountries.add(flight.origin!.country_code);
      visitedCountries.add(flight.destination!.country_code);
    }
  });

  // Return array of visited countries
  return Array.from(visitedCountries);
}

/**
 * Standardizes AeroAPI flight status into main states: scheduled, taxiing, active, or completed
 * @param status The status string from AeroAPI response
 * @returns A standardized status string
 */
export function standardizeFlightStatus(
  status: string | null | undefined
): "scheduled" | "taxiing" | "active" | "completed" | "unknown" {
  if (!status) return "unknown";

  console.log(`Standardizing flight status: "${status}"`);

  // Get the primary status (before the "/"), defaulting to the entire string if no "/" is found
  const primaryStatus =
    status.split("/")[0]?.trim().toLowerCase() || status.trim().toLowerCase();
  console.log(`Primary status: "${primaryStatus}"`);

  // Define status mappings with clear hierarchical preference
  const statusMap = {
    // Completed states
    arrived: "completed",
    landed: "completed",
    completed: "completed",

    // Active states (in air)
    "en route": "active",
    "in-air": "active",
    "in air": "active",
    departed: "active",
    takeoff: "active",

    // Taxiing states (on ground, engines running)
    taxi: "taxiing",
    taxiing: "taxiing",

    // Scheduled states
    scheduled: "scheduled",
    "not departed": "scheduled",
  } as const;

  // Look up the status in our map
  const standardizedStatus = statusMap[primaryStatus as keyof typeof statusMap];

  if (standardizedStatus) {
    console.log(
      `Mapped primary status "${primaryStatus}" to "${standardizedStatus}"`
    );
    return standardizedStatus;
  }

  // If we can't determine the state, log it and return unknown
  console.log(
    `Could not classify primary status "${primaryStatus}", defaulting to: "unknown"`
  );
  return "unknown";
}
