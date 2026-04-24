/**
 * errorHandler middleware tests — validates the unified API error contract.
 *
 * Every error response must follow:
 *   { error: { code: string, message: string, details?: unknown } }
 */
import { describe, it, expect, vi } from "vitest";
import { errorHandler } from "../middlewares/errorHandler";
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
} from "../lib/errors";
import { ZodError } from "zod";
import type { Request, Response } from "express";

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = data;
      return res;
    },
  } as unknown as Response;
  return res;
}

const mockReq = {} as Request;
const mockNext = vi.fn();

// Helper: assert the unified { error: { code, message } } shape
function expectUnifiedShape(body: unknown) {
  expect(body).toHaveProperty("error");
  const err = (body as any).error;
  expect(err).toHaveProperty("code");
  expect(err).toHaveProperty("message");
  expect(typeof err.code).toBe("string");
  expect(typeof err.message).toBe("string");
}

describe("errorHandler middleware — unified API contract", () => {
  // ── AppError subclasses ──

  it("handles NotFoundError with unified shape", () => {
    const err = new NotFoundError("Job", 42);
    const res = createMockRes();

    errorHandler(err, mockReq, res, mockNext);

    expect(res.statusCode).toBe(404);
    expectUnifiedShape(res.body);
    expect((res.body as any).error.code).toBe("NOT_FOUND");
    expect((res.body as any).error.message).toBe("Job with id 42 not found");
    expect((res.body as any).error.details).toBeNull();
  });

  it("handles ValidationError with unified shape", () => {
    const err = new ValidationError("missing field");
    const res = createMockRes();

    errorHandler(err, mockReq, res, mockNext);

    expect(res.statusCode).toBe(400);
    expectUnifiedShape(res.body);
    expect((res.body as any).error.code).toBe("VALIDATION_ERROR");
    expect((res.body as any).error.message).toBe("missing field");
  });

  it("handles ConflictError with unified shape", () => {
    const err = new ConflictError("already exists");
    const res = createMockRes();

    errorHandler(err, mockReq, res, mockNext);

    expect(res.statusCode).toBe(409);
    expectUnifiedShape(res.body);
    expect((res.body as any).error.code).toBe("CONFLICT");
  });

  // ── PostgreSQL constraint errors ──

  it("maps Postgres 23505 (unique_violation) → 409 CONFLICT", () => {
    const pgErr = { code: "23505", detail: "Key (email)=(a@b.com) already exists." };
    const res = createMockRes();

    errorHandler(pgErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(409);
    expectUnifiedShape(res.body);
    expect((res.body as any).error.code).toBe("CONFLICT");
  });

  it("maps Postgres 23503 (foreign_key_violation) → 400 VALIDATION_ERROR", () => {
    const pgErr = { code: "23503", detail: "Key (job_id)=(999) not present." };
    const res = createMockRes();

    errorHandler(pgErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(400);
    expectUnifiedShape(res.body);
    expect((res.body as any).error.code).toBe("VALIDATION_ERROR");
  });

  it("maps Postgres 23502 (not_null_violation) → 400", () => {
    const pgErr = { code: "23502", detail: "null value in column." };
    const res = createMockRes();

    errorHandler(pgErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(400);
    expectUnifiedShape(res.body);
  });

  it("maps Postgres 23514 (check_violation) → 400", () => {
    const pgErr = { code: "23514", detail: "violates check constraint." };
    const res = createMockRes();

    errorHandler(pgErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(400);
    expectUnifiedShape(res.body);
  });

  it("handles unknown Postgres error codes as 500 DATABASE_ERROR", () => {
    const pgErr = { code: "42601", detail: "syntax error" };
    const res = createMockRes();

    errorHandler(pgErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(500);
    expectUnifiedShape(res.body);
    expect((res.body as any).error.code).toBe("DATABASE_ERROR");
  });

  // ── ZodError — unified with field-level details ──

  it("handles ZodError with code, message, and field details", () => {
    const zodErr = new ZodError([
      {
        code: "invalid_type",
        expected: "string",
        received: "undefined",
        path: ["name"],
        message: "Required",
      },
      {
        code: "invalid_type",
        expected: "number",
        received: "undefined",
        path: ["jobId"],
        message: "Required",
      },
    ]);
    const res = createMockRes();

    errorHandler(zodErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(400);
    expectUnifiedShape(res.body);
    expect((res.body as any).error.code).toBe("VALIDATION_ERROR");
    expect((res.body as any).error.message).toBe("Invalid request data");
    expect((res.body as any).error.details).toEqual([
      { field: "name", message: "Required" },
      { field: "jobId", message: "Required" },
    ]);
  });

  // ── Unknown errors — no internal leaking ──

  it("handles unknown Error objects as 500 INTERNAL_SERVER_ERROR", () => {
    const err = new Error("something broke");
    const res = createMockRes();

    errorHandler(err, mockReq, res, mockNext);

    expect(res.statusCode).toBe(500);
    expectUnifiedShape(res.body);
    expect((res.body as any).error.code).toBe("INTERNAL_SERVER_ERROR");
    expect((res.body as any).error.message).toBe("Something went wrong");
    // Must NOT leak internal error details
    expect((res.body as any).error.message).not.toContain("something broke");
  });

  it("handles non-Error objects (strings, etc.) as 500", () => {
    const err = "string error";
    const res = createMockRes();

    errorHandler(err, mockReq, res, mockNext);

    expect(res.statusCode).toBe(500);
    expectUnifiedShape(res.body);
    expect((res.body as any).error.code).toBe("INTERNAL_SERVER_ERROR");
  });
});
