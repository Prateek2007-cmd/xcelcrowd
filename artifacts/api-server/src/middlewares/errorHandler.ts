/**
 * Global Express error handling middleware.
 *
 * - Catches AppError subclasses and returns structured JSON
 * - Maps PostgreSQL constraint violation codes to proper API responses
 *   via the centralized classifyDbError utility (single source of truth)
 * - Handles Zod validation errors explicitly
 * - Catches unknown errors and returns 500 with generic message
 */
import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import {
  AppError,
  ValidationError,
  DatabaseError,
} from "../lib/errors";
import { classifyDbError } from "../lib/errorUtils";
import { logger } from "../lib/logger";

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

  // 2. PostgreSQL constraint errors (centralized classification)
  const pgMapped = classifyDbError(err);
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