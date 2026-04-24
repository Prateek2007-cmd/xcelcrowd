/**
 * Database Error Mapper — abstract PostgreSQL error codes into semantic types.
 *
 * WHY: Raw PG codes (23505, 23503) are brittle — they couple business logic
 * to the specific database engine. This mapper provides a semantic abstraction
 * layer so services can check `DbErrorType.UNIQUE_VIOLATION` instead of "23505".
 *
 * If the database or ORM changes, only this file needs updating.
 */

// ── Semantic error types ─────────────────────────────────────────────────────

/**
 * Database-agnostic error types.
 * Each maps to one or more PostgreSQL error codes internally.
 */
export enum DbErrorType {
  /** Duplicate key (e.g. unique index on email) — PG 23505 */
  UNIQUE_VIOLATION = "UNIQUE_VIOLATION",

  /** Referenced row doesn't exist (e.g. invalid job_id) — PG 23503 */
  FOREIGN_KEY_VIOLATION = "FOREIGN_KEY_VIOLATION",

  /** Required column is null — PG 23502 */
  NOT_NULL_VIOLATION = "NOT_NULL_VIOLATION",

  /** CHECK constraint failed — PG 23514 */
  CHECK_VIOLATION = "CHECK_VIOLATION",

  /** Serialization / deadlock failure — PG 40001, 40P01 */
  SERIALIZATION_FAILURE = "SERIALIZATION_FAILURE",

  /** Connection lost / unavailable */
  CONNECTION_ERROR = "CONNECTION_ERROR",

  /** Unrecognized database error */
  UNKNOWN = "UNKNOWN",
}

// ── Internal PG code → semantic type mapping ─────────────────────────────────

const PG_CODE_MAP: Record<string, DbErrorType> = {
  // Integrity constraint violations (class 23)
  "23505": DbErrorType.UNIQUE_VIOLATION,
  "23503": DbErrorType.FOREIGN_KEY_VIOLATION,
  "23502": DbErrorType.NOT_NULL_VIOLATION,
  "23514": DbErrorType.CHECK_VIOLATION,

  // Serialization / deadlock (class 40)
  "40001": DbErrorType.SERIALIZATION_FAILURE,
  "40P01": DbErrorType.SERIALIZATION_FAILURE,

  // Connection errors (class 08)
  "08000": DbErrorType.CONNECTION_ERROR,
  "08003": DbErrorType.CONNECTION_ERROR,
  "08006": DbErrorType.CONNECTION_ERROR,
};

// ── Structured result ────────────────────────────────────────────────────────

export interface DbErrorInfo {
  /** Semantic error type (database-agnostic) */
  type: DbErrorType;

  /** Raw PG error code (for logging only — never branch on this in services) */
  rawCode: string | undefined;

  /** Human-readable detail from the database (e.g. "Key (email)=(a@b.com) already exists.") */
  detail: string | undefined;

  /** The original error for stack traces */
  original: unknown;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Extract the raw PostgreSQL error code from any error shape.
 *
 * Handles:
 *   - `err.code`       (node-pg direct)
 *   - `err.cause.code` (Drizzle wraps the original PG error as `cause`)
 */
export function extractPgCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const errObj = err as Record<string, unknown>;
  return (
    (typeof errObj.code === "string" ? errObj.code : undefined) ||
    (typeof (errObj.cause as Record<string, unknown>)?.code === "string"
      ? (errObj.cause as Record<string, unknown>).code as string
      : undefined)
  );
}

/**
 * Map any thrown error to a structured DbErrorInfo.
 *
 * Returns `null` if the error is not a database error (no PG code found).
 * Services should use this instead of raw `getPgErrorCode()` + string comparisons.
 *
 * @example
 * const dbErr = mapDbError(err);
 * if (dbErr?.type === DbErrorType.UNIQUE_VIOLATION) {
 *   // handle duplicate
 * }
 */
export function mapDbError(err: unknown): DbErrorInfo | null {
  const rawCode = extractPgCode(err);
  if (!rawCode) return null;

  const type = PG_CODE_MAP[rawCode] ?? DbErrorType.UNKNOWN;
  const detail = typeof (err as Record<string, unknown>)?.detail === "string"
    ? (err as Record<string, unknown>).detail as string
    : undefined;

  return { type, rawCode, detail, original: err };
}

/**
 * Check if an error matches a specific semantic database error type.
 *
 * @example
 * if (isDbErrorType(err, DbErrorType.UNIQUE_VIOLATION)) {
 *   // handle duplicate — no raw PG codes in business logic!
 * }
 */
export function isDbErrorType(err: unknown, expectedType: DbErrorType): boolean {
  const mapped = mapDbError(err);
  return mapped?.type === expectedType;
}
