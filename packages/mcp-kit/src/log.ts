import { pino, type Logger } from "pino";

/**
 * Structured JSON logger. Secrets must never be logged; the redact list is a
 * safety net for accidental logging of request headers or config objects.
 */
export function createLogger(name: string): Logger {
  return pino({
    name,
    level: process.env.LOG_LEVEL ?? "info",
    redact: {
      paths: [
        "req.headers.authorization",
        "headers.authorization",
        "*.authorization",
        "*.token",
        "*.password",
        "*.secret",
        "*.consumerSecret",
        "*.apiKey",
      ],
      censor: "[redacted]",
    },
  });
}
