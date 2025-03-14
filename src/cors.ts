// CORS configuration
const CORS_ORIGIN = "http://localhost:3000";
const CORS_METHODS = "GET, POST, PUT, DELETE, OPTIONS";
const CORS_HEADERS = "Content-Type, Authorization";

/**
 * Wraps a Response with CORS headers
 * @param response The original response to wrap
 * @returns A new Response with CORS headers added
 */
export function withCors(response: Response): Response {
  // Create a new response with the same body and status
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
  });

  // Copy all original headers
  response.headers.forEach((value, key) => {
    newResponse.headers.set(key, value);
  });

  // Add CORS headers
  newResponse.headers.set("Access-Control-Allow-Origin", CORS_ORIGIN);
  newResponse.headers.set("Access-Control-Allow-Methods", CORS_METHODS);
  newResponse.headers.set("Access-Control-Allow-Headers", CORS_HEADERS);

  return newResponse;
}

/**
 * Creates a JSON response with CORS headers
 * @param data The data to send in the response
 * @param options Response options (status, headers, etc.)
 * @returns A Response with CORS headers
 */
export function jsonWithCors(
  data: unknown,
  options: Bun.ResponseInit = {}
): Response {
  return withCors(Response.json(data, options));
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
