/**
 * Global Express error handling middleware.
 *
 * - Catches AppError subclasses and returns structured JSON
 * - Maps PostgreSQL constraint violation codes to proper API responses
 * - Catches unknown errors and returns 500 with generic message
 */
import type { Request, Response, NextFunction } from "express";
import { AppError, ConflictError, ValidationError, DatabaseError } from "../lib/errors";
import { logger } from "../lib/logger";

/**
 * PostgreSQL error code mapping.
 * See: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
function mapPostgresError(err: unknown): AppError | null {
  if (!err || typeof err !== "object") return null;

  const pgErr = err as { code?: string; constraint?: string; detail?: string };

  switch (pgErr.code) {
    case "23505": // unique_violation
      return new ConflictError(
        pgErr.detail
          ? `Duplicate entry: ${pgErr.detail}`
          : "A record with this value already exists"
      );

    case "23503": // foreign_key_violation
      return new ValidationError(
        pgErr.detail
          ? `Referenced record not found: ${pgErr.detail}`
          : "Referenced record does not exist"
      );

    case "23502": // not_null_violation
      return new ValidationError(
        pgErr.detail
          ? `Missing required field: ${pgErr.detail}`
          : "A required field is missing"
      );

    case "23514": // check_violation
      return new ValidationError(
        pgErr.detail
          ? `Constraint violation: ${pgErr.detail}`
          : "A value constraint was violated"
      );

    default:
      return null;
  }
}

// Express error handler must have exactly 4 parameters
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  // 1. Known application errors
  if (err instanceof AppError) {
    res.status(err.statusCode).json(err.toJSON());
    return;
  }

  // 2. PostgreSQL constraint errors
  const pgMapped = mapPostgresError(err);
  if (pgMapped) {
    logger.warn({ err, mapped: pgMapped.code }, "Database constraint violation");
    res.status(pgMapped.statusCode).json(pgMapped.toJSON());
    return;
  }

  // 3. Zod validation errors (from safeParse used incorrectly)
  if (err && typeof err === "object" && "issues" in err) {
    const zodErr = err as { issues: Array<{ message: string }> };
    const messages = zodErr.issues.map((i) => i.message).join(", ");
    const mapped = new ValidationError(messages);
    res.status(mapped.statusCode).json(mapped.toJSON());
    return;
  }

  // 4. Unknown errors — log full details, return generic message
  logger.error({ err }, "Unhandled error");
  const fallback = new DatabaseError("An unexpected error occurred");
  res.status(500).json(fallback.toJSON());
}
