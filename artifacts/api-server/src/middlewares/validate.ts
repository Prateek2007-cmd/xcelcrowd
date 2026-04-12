/**
 * Reusable Zod validation middleware.
 * Replaces repeated safeParse boilerplate in routes.
 */
import type { Request, Response, NextFunction } from "express";
import type { ZodType } from "zod";
import { ValidationError } from "../lib/errors";

/**
 * Validates req.body against a Zod schema.
 * On success, attaches parsed data to req.body (replacing raw input).
 * On failure, throws ValidationError → caught by global error handler.
 */
export function validateBody<T>(schema: ZodType<T>) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      next(new ValidationError(parsed.error.message));
      return;
    }
    req.body = parsed.data;
    next();
  };
}

/**
 * Validates req.params against a Zod schema.
 * On success, attaches parsed data to res.locals.params.
 * On failure, throws ValidationError → caught by global error handler.
 */
export function validateParams<T>(schema: ZodType<T>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed = schema.safeParse(req.params);
    if (!parsed.success) {
      next(new ValidationError(parsed.error.message));
      return;
    }
    res.locals.params = parsed.data;
    next();
  };
}
