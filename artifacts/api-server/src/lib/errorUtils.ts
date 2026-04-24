/**
 * Centralized database error classification utilities.
 *
 * Uses the semantic DbErrorMapper layer internally — no raw PG codes
 * in the classification logic. The mapper is the single source of truth
 * for PG code → semantic type translation.
 *
 * Used by:
 *   - applicationService (catch blocks around DB operations)
 *   - errorHandler.ts    (global Express error middleware)
 *   - pipeline/decay.ts  (structured decay error handling)
 */
import {
  AppError,
  ConflictError,
  ValidationError,
  DatabaseError,
} from "./errors";
import {
  mapDbError,
  extractPgCode,
  DbErrorType,
} from "./dbErrorMapper";

// Re-export for consumers that still import from errorUtils
export { extractPgCode as getPgErrorCode } from "./dbErrorMapper";

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
 * Uses the semantic DbErrorMapper — no raw PG code string comparisons here.
 *
 * Returns `null` if the error doesn't match any known DB error type,
 * so callers can decide whether to fall through to a generic handler.
 */
export function classifyDbError(err: unknown): AppError | null {
  const dbErr = mapDbError(err);
  if (!dbErr) return null;

  const detail = dbErr.detail;

  switch (dbErr.type) {
    case DbErrorType.UNIQUE_VIOLATION:
      return new ConflictError(
        detail ? `Duplicate entry: ${detail}` : "A record with this value already exists"
      );

    case DbErrorType.FOREIGN_KEY_VIOLATION:
      return new ValidationError(
        detail ? `Referenced record not found: ${detail}` : "Referenced record does not exist"
      );

    case DbErrorType.NOT_NULL_VIOLATION:
      return new ValidationError(
        detail ? `Missing required field: ${detail}` : "A required field is missing"
      );

    case DbErrorType.CHECK_VIOLATION:
      return new ValidationError(
        detail ? `Constraint violation: ${detail}` : "A value constraint was violated"
      );

    case DbErrorType.SERIALIZATION_FAILURE:
      return new DatabaseError(
        "Transaction serialization failure — please retry"
      );

    case DbErrorType.CONNECTION_ERROR:
      return new DatabaseError(
        "Database connection error — please try again later"
      );

    case DbErrorType.UNKNOWN:
      return new DatabaseError(
        detail ? `Database error: ${detail}` : "An unexpected database error occurred"
      );

    default:
      return null;
  }
}

/**
 * Classify a raw error into an AppError, with a guaranteed non-null fallback.
 */
export function classifyDbErrorOrDefault(
  err: unknown,
  fallbackMessage = "Database operation failed"
): AppError {
  if (err instanceof AppError) return err;

  const classified = classifyDbError(err);
  if (classified) return classified;

  return new DatabaseError(fallbackMessage);
}
