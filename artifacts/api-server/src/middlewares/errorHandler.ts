/**
 * Global Express error handling middleware.
 *
 * UNIFIED API ERROR CONTRACT:
 *   Every error response follows the same structure:
 *
 *   {
 *     error: {
 *       code: string,           // machine-readable error code
 *       message: string,        // human-readable message
 *       details?: unknown       // optional structured details (Zod issues, etc.)
 *     }
 *   }
 *
 * Handles:
 *   1. AppError subclasses — known application errors
 *   2. PostgreSQL constraint violations — via centralized classifyDbError
 *   3. ZodError — validation failures with field-level details
 *   4. Unknown errors — 500 with generic message (no leaking internals)
 */
import type { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";
import { AppError } from "../lib/errors";
import { classifyDbError } from "../lib/errorUtils";
import { logger } from "../lib/logger";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction
): void {
  // ── 1. Known application errors ──────────────────────────────────────────
  if (err instanceof AppError) {
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: null,
      },
    });
    return;
  }

  // ── 2. PostgreSQL constraint violations ──────────────────────────────────
  const pgMapped = classifyDbError(err);
  if (pgMapped) {
    logger.warn({ err, mapped: pgMapped.code }, "Database constraint violation");
    res.status(pgMapped.statusCode).json({
      error: {
        code: pgMapped.code,
        message: pgMapped.message,
        details: null,
      },
    });
    return;
  }

  // ── 3. Zod validation errors ─────────────────────────────────────────────
  if (err instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        message: "Invalid request data",
        details: err.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
    return;
  }

  // ── 4. Unknown / unhandled errors ────────────────────────────────────────
  logger.error({ err }, "Unhandled error");

  res.status(500).json({
    error: {
      code: "INTERNAL_SERVER_ERROR",
      message: "Something went wrong",
      details: null,
    },
  });
}