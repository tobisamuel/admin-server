import {
  type AirportResponse,
  type FlightInfoResponse,
  type FlightPositionResponse,
  type FlightRouteResponse,
  type FlightTrackResponse,
} from "./types";

const AERO_API_KEY = process.env.AERO_API_KEY;
const AERO_API_BASE = "https://aeroapi.flightaware.com/aeroapi";

export async function getFlightInfo(faFlightId: string) {
  const data = await fetch(`${AERO_API_BASE}/flights/${faFlightId}`, {
    headers: {
      "x-apikey": AERO_API_KEY!,
    },
  });

  const flightData = (await data.json()) as FlightInfoResponse;

  return flightData;
}

export async function getAirportInfo(code: string) {
  const data = await fetch(`${AERO_API_BASE}/airports/${code}`, {
    headers: {
      "x-apikey": AERO_API_KEY!,
    },
  });

  const airportData = (await data.json()) as AirportResponse;

  return airportData;
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
): Promise<FlightPositionResponse> {
  const data = await fetch(`${AERO_API_BASE}/flights/${faFlightId}/position`, {
    headers: {
      "x-apikey": AERO_API_KEY!,
    },
  });

  const positionData = (await data.json()) as FlightPositionResponse;

  return positionData;
}

export async function getFlightTrack(faFlightId: string) {
  const data = await fetch(`${AERO_API_BASE}/flights/${faFlightId}/track`, {
    headers: {
      "x-apikey": AERO_API_KEY!,
    },
  });

  const trackData = (await data.json()) as FlightTrackResponse;

  return trackData;
}
