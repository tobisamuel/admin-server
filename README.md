# Flight Tracking Admin Server

This server provides a backend for tracking flights in real-time using the FlightAware AeroAPI. It exposes both REST and WebSocket interfaces for clients to receive flight updates.

## Features

- Real-time flight tracking with WebSocket updates
- Flight status monitoring and history
- Support for manual updates during ground activities
- Comprehensive initial state including all flights
- Status change tracking and broadcasting

## Setup

1. Install dependencies:

   ```bash
   bun install
   ```

2. Create a `.env` file with the following variables:

   ```
   AERO_API_KEY=your_flightaware_aeroapi_key
   PORT=3001
   ```

3. Start the server:
   ```bash
   bun run index.ts
   ```

## API Endpoints

### Flight Management

- `POST /api/flights/search` - Search for scheduled flights
- `POST /api/flights/save` - Save flight metadata
- `GET /api/flights` - Get all saved flights
- `DELETE /api/flights` - Delete a flight

### Tracking Control

- `POST /api/tracking/start` - Start tracking a flight
- `POST /api/tracking/stop` - Stop tracking a flight

### Manual Updates

- `POST /api/flights/manual-update` - Send a manual update for a flight

### Status

- `GET /api/status` - Get the current state of all flights

## WebSocket Events

Clients can connect to the WebSocket server to receive real-time updates. The server sends the following events:

- `initial_state` - Sent when a client connects, includes all flights and the current active flight
- `client_count` - Sent when a client connects or disconnects, includes the number of connected clients
- `position_update` - Sent when a flight's position is updated
- `flight_status_update` - Sent when a flight's status changes
- `flight_completed` - Sent when a flight is completed
- `manual_update` - Sent when a manual update is created
- `flight_added` - Sent when a new flight is added

## Data Structure

The server uses the following data structure for flights:

```typescript
type FlightMetadata = {
  _id?: string;
  fa_flight_id: string;
  flightInfo: DetailedFlight; // From /flights/{id}
  route_distance: string; // From /flights/{id}/route
  coordinates: Coordinates[]; // Filed route from /flights/{id}/route
  status: "scheduled" | "active" | "completed" | "cancelled";
  flightTrack: {
    latitude: number;
    longitude: number;
    heading: number;
    timestamp: string;
  }[]; // From /flights/{id}/track
  statusHistory: { status: string; timestamp: Date }[]; // Track status changes
  manualUpdates: { message: string; timestamp: Date }[]; // Ground updates
  realtimeData?: {
    last_update: Date;
    current_position?: { latitude: number; longitude: number; heading: number };
    flight_status?:
      | "scheduled"
      | "boarding"
      | "departed"
      | "in_air"
      | "landed"
      | "cancelled"
      | "diverted";
    departure_delay?: number;
    arrival_delay?: number;
  };
};
```

## Examples

### Start tracking a flight

```bash
curl -X POST http://localhost:3001/api/tracking/start \
  -H "Content-Type: application/json" \
  -d '{"fa_flight_id": "flight_id_from_flightaware"}'
```

### Send a manual update

```bash
curl -X POST http://localhost:3001/api/flights/manual-update \
  -H "Content-Type: application/json" \
  -d '{"fa_flight_id": "flight_id_from_flightaware", "message": "Now boarding at gate 23"}'
```

This project was created using `bun init` in bun v1.2.5. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.
