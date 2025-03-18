import pino from "pino";

// Configure the logger with custom settings
const logger = pino({
  // Default to info level, but allow override via environment variable
  level: process.env.LOG_LEVEL || "info",

  // Enable pretty printing in development
  transport:
    process.env.NODE_ENV === "development"
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:standard",
            ignore: "pid,hostname",
          },
        }
      : undefined,

  // Ensure consistent formatting of levels
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
    // Add bindings to all log records
    bindings: (bindings) => {
      return {
        pid: bindings.pid,
        hostname: bindings.hostname,
        node_version: process.version,
      };
    },
  },

  // Add base metadata to all logs
  base: {
    env: process.env.NODE_ENV || "development",
    version: process.env.npm_package_version,
    service: "admin-server",
  },

  // Use Pino's built-in timestamp function
  // In development: human-readable ISO timestamps
  // In production: high-performance epoch timestamps
  timestamp:
    process.env.NODE_ENV === "development"
      ? pino.stdTimeFunctions.isoTime
      : pino.stdTimeFunctions.epochTime,

  // Enable message key for better readability in JSON
  messageKey: "msg",
});

export default logger;
