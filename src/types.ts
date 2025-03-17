// Application types
export type WebSocketEventType =
  | "client_added"
  | "client_removed"
  | "initial_state"
  | "start_flight"
  | "position_update"
  | "flight_status_update"
  | "flight_completed"
  | "manual_update"
  | "flight_added"
  | "global_stats_update";

export interface WebSocketEvent<T = any> {
  event: WebSocketEventType;
  data: T;
}

export type FlightTrackObject = {
  fa_flight_id: string | null;
  altitude: number;
  altitude_change: string;
  groundspeed: number;
  heading: number;
  latitude: number;
  longitude: number;
  timestamp: string;
  update_type: string;
};

export type FlightMetadata = {
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
  blocked: boolean;
  diverted: boolean;
  cancelled: boolean;
  origin: AirportResponse;
  destination: AirportResponse;
  departure_delay: number;
  arrival_delay: number;
  filed_ete: number;
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
  standardized_status: "scheduled" | "active" | "completed" | "unknown";
  aircraft_type: string;
  route_distance: number;
  filed_airspeed: number;
  filed_altitude: number | null;
  route: string | null;
  is_tracking: boolean;
  waypoints?: string[];
  flightTrack: FlightTrackObject[];
};

export type Stats = {
  total_miles: number;
  total_countries: string[];
  total_flights: number;
  last_updated: string;
};

export type InitialState = {
  client_count: number;
  current_flight: FlightMetadata | null;
  current_location: {
    country: string;
    latitude: number;
    longitude: number;
    heading: number;
    timestamp: string;
  };
  flights: FlightMetadata[];
  stats: Stats;
};

// API Request body types
export type FlightSearchParams = {
  startDate?: string;
  endDate?: string;
  origin?: string;
  destination?: string;
  airline?: string;
  flightNumber?: string;
};

export type FlightCreationData = {
  fa_flight_id: string;
  origin: string;
  destination: string;
};

// AeroAPI types
export type AeroApiError = {
  title: string;
  reason: string;
  detail: string;
  status: number;
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
  origin: {
    code: string;
    code_icao: string;
    code_iata: string;
    code_lid: string;
    timezone: string;
    name: string;
    city: string;
    airport_info_url: string;
  };
  destination: {
    code: string;
    code_icao: string;
    code_iata: string;
    code_lid: string;
    timezone: string;
    name: string;
    city: string;
    airport_info_url: string;
  };
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
  waypoints: string[];
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

export type FlightInfoResponse = {
  flights: DetailedFlight[];
  links: null;
  num_pages: number;
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
  origin: {
    code: string;
    code_icao: string;
    code_iata: string;
    code_lid: string;
    timezone: string;
    name: string;
    city: string;
    airport_info_url: string;
  };
  destination: {
    code: string;
    code_icao: string;
    code_iata: string;
    code_lid: string;
    timezone: string;
    name: string;
    city: string;
    airport_info_url: string;
  };
  waypoints: string[];
  first_position_time: string;
  last_position: FlightTrackObject;
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

export type FlightTrackResponse = {
  actual_distance: number;
  positions: FlightTrackObject[];
};
