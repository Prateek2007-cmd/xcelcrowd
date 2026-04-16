/**
 * Global Express error handling middleware.
 *
 * - Catches AppError subclasses and returns structured JSON
 * - Maps PostgreSQL constraint violation codes to proper API responses
 * - Handles Zod validation errors explicitly
 * - Catches unknown errors and returns 500 with generic message
 */
import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import {
  AppError,
  ConflictError,
  ValidationError,
  DatabaseError,
} from "../lib/errors";
import { logger } from "../lib/logger";

/**
 * PostgreSQL error code mapping.
 */
function mapPostgresError(err: unknown): AppError | null {
  if (!err || typeof err !== "object") return null;

  const pgErr = err as { code?: string; constraint?: string; detail?: string };

  switch (pgErr.code) {
    case "23505":
      return new ConflictError(
        pgErr.detail
          ? `Duplicate entry: ${pgErr.detail}`
          : "A record with this value already exists"
      );

    case "23503":
      return new ValidationError(
        pgErr.detail
          ? `Referenced record not found: ${pgErr.detail}`
          : "Referenced record does not exist"
      );

    case "23502":
      return new ValidationError(
        pgErr.detail
          ? `Missing required field: ${pgErr.detail}`
          : "A required field is missing"
      );

    case "23514":
      return new ValidationError(
        pgErr.detail
          ? `Constraint violation: ${pgErr.detail}`
          : "A value constraint was violated"
      );

    default:
      return null;
  }
}

// Express error handler
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
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

  // 3. Zod validation errors (EXPLICIT handling)
  if (err instanceof ZodError) {
    const mapped = new ValidationError(
      err.issues.map((i) => i.message).join(", ")
    );

    res.status(mapped.statusCode).json({
      error: "ValidationError",
      details: err.issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    });
    return;
  }

  // 4. Unknown errors
  logger.error({ err }, "Unhandled error");

  const fallback = new DatabaseError("An unexpected error occurred");
  res.status(500).json(fallback.toJSON());
}