export interface WebSocketEvent<T = any> {
  event: string;
  data: T;
}

export type DetailedFlight = {
  ident: string;
  ident_icao: string;
  ident_iata: string;
  actual_runway_off: string | null;
  actual_runway_on: string | null;
  fa_flight_id: string;
  operator: string;
  operator_icao: string;
  operator_iata: string;
  flight_number: string;
  registration: string;
  atc_ident: string | null;
  inbound_fa_flight_id: string;
  codeshares: string[];
  codeshares_iata: string[];
  blocked: boolean;
  diverted: boolean;
  cancelled: boolean;
  position_only: boolean;
  origin: Airport;
  destination: Airport;
  departure_delay: number;
  arrival_delay: number;
  filed_ete: number;
  foresight_predictions_available: boolean;
  scheduled_out: string;
  estimated_out: string;
  actual_out: string | null;
  scheduled_off: string;
  estimated_off: string;
  actual_off: string | null;
  scheduled_on: string;
  estimated_on: string;
  actual_on: string | null;
  scheduled_in: string;
  estimated_in: string;
  actual_in: string | null;
  progress_percent: number;
  status: string;
  aircraft_type: string;
  route_distance: number;
  filed_airspeed: number;
  filed_altitude: number;
  route: string;
  baggage_claim: string;
  seats_cabin_business: number | null;
  seats_cabin_coach: number | null;
  seats_cabin_first: number | null;
  gate_origin: string;
  gate_destination: string;
  terminal_origin: string;
  terminal_destination: string;
  type: string;
};

type Coordinates = {
  name: string;
  latitude: number;
  longitude: number;
  distance_from_origin: number;
  distance_this_leg: number | null;
  distance_to_destination: number;
  outbound_course: number;
  type: string;
};

export type FlightInfoResponse = {
  flights: DetailedFlight[];
  links: null;
  num_pages: number;
};

export type AirportResponse = {
  airport_code: string;
  code_icao: string;
  code_iata: string;
  code_lid: string;
  name: string;
  type: string;
  elevation: number;
  city: string;
  state: string;
  longitude: number;
  latitude: number;
  timezone: string;
  country_code: string;
  wiki_url: string;
  airport_flights_url: string;
  alternatives: AirportResponse[];
};

export type Airport = {
  airport_code: string;
  code_icao: string;
  code_iata: string;
  code_lid: string;
  name: string;
  type: string;
  elevation: number;
  city: string;
  state: string;
  longitude: number;
  latitude: number;
  timezone: string;
  country_code: string;
};

export type FlightData = {
  fa_flight_id: string;
  origin: string;
  destination: string;
};

export type Flight = {
  ident: string;
  ident_icao: string;
  ident_iata: string;
  actual_ident: string;
  actual_ident_icao: string;
  actual_ident_iata: string;
  aircraft_type: string;
  scheduled_in: string;
  scheduled_out: string;
  origin: string;
  origin_icao: string;
  origin_iata: string;
  origin_lid: string;
  destination: string;
  destination_icao: string;
  destination_iata: string;
  destination_lid: string;
  fa_flight_id: string;
  meal_service: string;
  seats_cabin_business: number;
  seats_cabin_coach: number;
  seats_cabin_first: number;
};

export type DirectFlightResponse = {
  flights: DetailedFlight[];
  links: null;
  num_pages: number;
};

export type FlightSearchResponse = {
  links: {
    next: string;
  };
  num_pages: number;
  scheduled: Flight[];
  flights?: DetailedFlight[]; // For direct flight responses
};

export type FlightRouteResponse = {
  route_distance: string;
  fixes: {
    name: string;
    latitude: number;
    longitude: number;
    distance_from_origin: number;
    distance_this_leg: number;
    distance_to_destination: number;
    outbound_course: number;
    type: string;
  }[];
};

export type FlightPositionResponse = {
  ident: string;
  ident_icao: string;
  ident_iata: string;
  fa_flight_id: string;
  registration: string;
  origin: Airport;
  destination: Airport;
  waypoints: string[];
  first_position_time: string;
  last_position: {
    fa_flight_id: string;
    altitude: number;
    altitude_change: string;
    groundspeed: number;
    heading: number;
    latitude: number;
    longitude: number;
    timestamp: string;
  };
  bounding_box: string[];
  ident_prefix: string;
  aircraft_type: string;
  actual_off: string;
  actual_on: string;
  foresight_predictions_available: boolean;
  predicted_out: string | null;
  predicted_off: string | null;
  predicted_on: string | null;
  predicted_out_source: string | null;
  predicted_off_source: string | null;
  predicted_on_source: string | null;
  predicted_in_source: string | null;
};

/**
 * Represents the status of a flight as returned by the FlightAware AeroAPI.
 * This type is a union of likely string literals, combined with a fallback
 * string type to handle any unexpected status values.
 */
type FlightStatus =
  | "Scheduled"
  | "Delayed (Scheduled)" // Indicates a delay, but still scheduled
  | "Cancelled"
  | "In-Air"
  | "En Route"
  | "Diverted"
  | "Delayed (In-Air)" // Indicates a delay while in the air
  | "Approach"
  | "Approaching" // Followed by airport name/code, e.g., "Approaching KJFK"
  | "Final Approach"
  | "Landed"
  | "Arrived"
  | "Completed"
  | "Unknown"
  | "Result Unknown"
  | "Filed"
  | string; // Fallback for any other human-readable status string

/**
 * Helper function to categorize flight status for more robust handling.
 * This function maps the raw FlightStatus to a broader category.  This
 * allows your application logic to be less brittle to changes in the
 * specific wording used by FlightAware.
 *
 * @param status The raw FlightStatus string.
 * @returns A FlightStatusCategory representing the broader state of the flight.
 */
export function getFlightStatusCategory(
  status: FlightStatus
): FlightStatusCategory {
  switch (status) {
    case "Scheduled":
    case "Delayed (Scheduled)":
    case "Filed":
      return "Scheduled";
    case "Cancelled":
      return "Cancelled";
    case "In-Air":
    case "En Route":
    case "Delayed (In-Air)":
    case "Diverted": // Diverted is still "in-air" from a category perspective
      return "InAir";
    case "Approach":
    case "Approaching":
    case "Final Approach":
      return "Approaching";
    case "Landed":
      return "Landed";
    case "Arrived":
    case "Completed":
      return "Arrived";
    case "Unknown":
    case "Result Unknown":
      return "Unknown";
    default:
      // Handle potentially unknown strings, you could log them for analysis
      console.warn(`Unknown flight status encountered: ${status}`);
      return "Unknown"; // Treat any unrecognized status as "Unknown"
  }
}

/**
 * Represents a broader category of flight status, for more robust
 * programmatic handling than relying solely on the exact string value.
 */
export type FlightStatusCategory =
  | "Scheduled"
  | "Cancelled"
  | "InAir"
  | "Approaching"
  | "Landed"
  | "Arrived"
  | "Unknown";
