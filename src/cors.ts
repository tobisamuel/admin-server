// CORS configuration
// Add Vercel domain to the allowed origins
const CORS_ORIGIN = process.env.ALLOWED_ORIGIN || "http://localhost:3000";
const CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const CORS_HEADERS = "Content-Type, Authorization";

/**
 * Extended Response type that preserves the type of the contained data
 */
export interface TypedResponse<T> extends Response {
  json(): Promise<T>;
}

/**
 * Creates a JSON response with CORS headers while preserving type information
 * @param data The data to send in the response
 * @param options Response options (status, headers, etc.)
 * @returns A typed Response with CORS headers that preserves the data type
 */
export function jsonWithCors<T>(
  data: T,
  options: Bun.ResponseInit | number = {}
) {
  // Create a JSON response with the provided data and options
  const response = Response.json(data, options);

  // Add CORS headers directly in this function
  response.headers.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  response.headers.set("Access-Control-Allow-Methods", CORS_METHODS);
  response.headers.set("Access-Control-Allow-Headers", CORS_HEADERS);

  // Cast the response to our typed interface
  const typedResponse = response as TypedResponse<T>;

  return typedResponse;
}

/**
 * Handles OPTIONS preflight requests
 * @returns A Response with appropriate CORS headers for preflight requests
 */
export function handleCorsOptions(): Response {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": CORS_ORIGIN,
      "Access-Control-Allow-Methods": CORS_METHODS,
      "Access-Control-Allow-Headers": CORS_HEADERS,
    },
  });
}
