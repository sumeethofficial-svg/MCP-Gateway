/** A failure that is safe to show to the caller, carrying the HTTP status it maps to. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const badRequest = (message: string, code = "bad_request") => new AppError(400, code, message);
export const unauthorized = (message = "Authentication required", code = "unauthorized") => new AppError(401, code, message);
export const forbidden = (message = "You do not have permission to do that", code = "forbidden") => new AppError(403, code, message);
export const notFound = (message = "Not found", code = "not_found") => new AppError(404, code, message);
export const conflict = (message: string, code = "conflict") => new AppError(409, code, message);
export const tooMany = (message: string, retryAfterMs: number) => {
  const err = new AppError(429, "rate_limited", message);
  (err as AppError & { retryAfterMs?: number }).retryAfterMs = retryAfterMs;
  return err;
};
