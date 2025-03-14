import {
  type Airport,
  type AirportResponse,
  type FlightInfoResponse,
  type FlightPositionResponse,
  type FlightRouteResponse,
} from "./types";

const AERO_API_KEY = process.env.AERO_API_KEY;
const AERO_API_BASE = "https://aeroapi.flightaware.com/aeroapi";

export async function getFlightInfo(
  faFlightId: string
): Promise<FlightInfoResponse> {
  const data = await fetch(`${AERO_API_BASE}/flights/${faFlightId}`, {
    headers: {
      "x-apikey": AERO_API_KEY!,
    },
  });

  const flightData = (await data.json()) as FlightInfoResponse;

  return flightData;
}

export async function getAirportInfo(code: string): Promise<Airport> {
  const data = await fetch(`${AERO_API_BASE}/airports/${code}`, {
    headers: {
      "x-apikey": AERO_API_KEY!,
    },
  });

  const airportData = (await data.json()) as AirportResponse;

  return {
    airport_code: airportData.airport_code,
    code_icao: airportData.code_icao,
    code_iata: airportData.code_iata,
    code_lid: airportData.code_lid,
    name: airportData.name,
    type: airportData.type,
    elevation: airportData.elevation,
    city: airportData.city,
    state: airportData.state,
    longitude: airportData.longitude,
    latitude: airportData.latitude,
    timezone: airportData.timezone,
    country_code: airportData.country_code,
  };
}

export async function getFlightRouteData(faFlightId: string) {
  const data = await fetch(`${AERO_API_BASE}/flights/${faFlightId}/route`, {
    headers: {
      "x-apikey": AERO_API_KEY!,
    },
  });

  const routeData = (await data.json()) as FlightRouteResponse;

  return routeData;
}

export async function getFlightPosition(
  faFlightId: string
): Promise<FlightPositionResponse["last_position"]> {
  const data = await fetch(`${AERO_API_BASE}/flights/${faFlightId}/position`, {
    headers: {
      "x-apikey": AERO_API_KEY!,
    },
  });

  const positionData = (await data.json()) as FlightPositionResponse;
  // return last position
  return positionData.last_position;
}
