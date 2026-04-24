/**
 * Centralized database error classification utilities.
 *
 * Single source of truth for mapping raw database errors (especially
 * PostgreSQL constraint violations) into structured AppError subclasses.
 *
 * Used by:
 *   - applicationService.ts  (catch blocks around DB operations)
 *   - errorHandler.ts        (global Express error middleware)
 */
import {
  AppError,
  ConflictError,
  ValidationError,
  DatabaseError,
} from "./errors";

// ── PostgreSQL error code extraction ─────────────────────────────────────────

/**
 * Extract PostgreSQL error code from various error structures.
 *
 * PostgreSQL errors can appear in multiple shapes depending on the driver
 * and whether the error bubbled through a transaction wrapper:
 *   - `err.code`        (node-pg direct)
 *   - `err.cause.code`  (Drizzle wraps the original PG error as `cause`)
 */
export function getPgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;

  const errObj = err as Record<string, unknown>;
  return (
    (errObj.code as string) ||
    (errObj.cause as Record<string, unknown>)?.code as string
  );
}

// ── Error formatting ─────────────────────────────────────────────────────────

/** Type guard: is this value an Error instance? */
export function isError(err: unknown): err is Error {
  return err instanceof Error;
}

/** Safely extract a human-readable message from any thrown value. */
export function formatErrorMessage(err: unknown): string {
  if (isError(err)) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as Record<string, unknown>).message);
  }
  return String(err);
}

// ── Error classification ─────────────────────────────────────────────────────

/**
 * Classify a raw database error into the appropriate AppError subclass.
 *
 * Handles all known PostgreSQL constraint violation codes:
 *   - 23505  unique_violation  → ConflictError  (409)
 *   - 23503  foreign_key       → ValidationError (400)
 *   - 23502  not_null          → ValidationError (400)
 *   - 23514  check_violation   → ValidationError (400)
 *
 * Returns `null` if the error doesn't match any known PG code,
 * so callers can decide whether to fall through to a generic handler.
 */
export function classifyDbError(err: unknown): AppError | null {
  if (!err || typeof err !== "object") return null;

  const pgCode = getPgErrorCode(err);
  const detail = (err as Record<string, unknown>).detail as string | undefined;

  switch (pgCode) {
    case "23505":
      return new ConflictError(
        detail
          ? `Duplicate entry: ${detail}`
          : "A record with this value already exists"
      );

    case "23503":
      return new ValidationError(
        detail
          ? `Referenced record not found: ${detail}`
          : "Referenced record does not exist"
      );

    case "23502":
      return new ValidationError(
        detail
          ? `Missing required field: ${detail}`
          : "A required field is missing"
      );

    case "23514":
      return new ValidationError(
        detail
          ? `Constraint violation: ${detail}`
          : "A value constraint was violated"
      );

    default:
      return null;
  }
}

/**
 * Classify a raw error into an AppError, with a guaranteed non-null fallback.
 *
 * Convenience wrapper: tries classifyDbError first, then wraps anything
 * unrecognized in a generic DatabaseError. Useful in catch blocks where
 * you always want to throw an AppError.
 */
export function classifyDbErrorOrDefault(
  err: unknown,
  fallbackMessage = "Database operation failed"
): AppError {
  // If it's already an AppError, pass through
  if (err instanceof AppError) return err;

  const classified = classifyDbError(err);
  if (classified) return classified;

  return new DatabaseError(fallbackMessage);
}
