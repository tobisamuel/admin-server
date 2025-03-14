import { MongoClient } from "mongodb";
import type { FlightMetadata } from "./types";

let MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  throw new Error(
    "Please define the MONGODB_URI environment variable inside .env"
  );
}

const client: MongoClient = await MongoClient.connect(MONGODB_URI);

const db = client.db("alma-db");

export { db };

export function calculateCountriesVisited(flights: FlightMetadata[]): string[] {
  if (flights.length === 0) return [];
  
  // Using Set to automatically handle duplicates
  const visitedCountries = new Set<string>();
  
  // Process flights in order
  flights.forEach((flight, index) => {
    // Only count countries from completed flights
    if (flight.status === "completed") {
      // Add destination country for all flights
      const destinationCountry = flight.flightInfo.destination.country_code;
      visitedCountries.add(destinationCountry);
      
      // For flights after the first one, also add the origin country
      // (We skip the first origin country as it's the home country)
      if (index > 0) {
        const originCountry = flight.flightInfo.origin.country_code;
        visitedCountries.add(originCountry);
      }
    }
  });
  
  // Return array of visited countries
  return Array.from(visitedCountries);
}
