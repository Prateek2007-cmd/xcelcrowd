import { describe, it, expect, vi } from "vitest";
import { validateBody, validateParams } from "../middlewares/validate";
import { z } from "zod";
import type { Request, Response, NextFunction } from "express";
import { ValidationError } from "../lib/errors";

const TestBodySchema = z.object({
  name: z.string().min(1),
  age: z.number().int().positive(),
});

const TestParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
});

function createMocks(body?: unknown, params?: unknown) {
  const req = { body, params } as Request;
  const res = { locals: {} } as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next: next as NextFunction & ReturnType<typeof vi.fn> };
}

describe("validateBody middleware", () => {
  const middleware = validateBody(TestBodySchema);

  it("calls next() and sets parsed body on valid input", () => {
    const { req, res, next } = createMocks({ name: "Alice", age: 25 });
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(req.body).toEqual({ name: "Alice", age: 25 });
  });

  it("calls next(ValidationError) on invalid input", () => {
    const { req, res, next } = createMocks({ name: "", age: -1 });
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });

  it("calls next(ValidationError) on missing body", () => {
    const { req, res, next } = createMocks(undefined);
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });
});

describe("validateParams middleware", () => {
  const middleware = validateParams(TestParamsSchema);

  it("calls next() and sets parsed params on valid input", () => {
    const { req, res, next } = createMocks(undefined, { id: "42" });
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.locals.params).toEqual({ id: 42 });
  });

  it("calls next(ValidationError) on invalid params", () => {
    const { req, res, next } = createMocks(undefined, { id: "abc" });
    middleware(req, res, next);

    expect(next).toHaveBeenCalledWith(expect.any(ValidationError));
  });
});
