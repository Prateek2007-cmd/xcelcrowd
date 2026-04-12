import { describe, it, expect, vi } from "vitest";
import { errorHandler } from "../middlewares/errorHandler";
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
} from "../lib/errors";
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

describe("errorHandler middleware", () => {
  it("handles AppError subclasses with structured JSON", () => {
    const err = new NotFoundError("Job", 42);
    const res = createMockRes();

    errorHandler(err, mockReq, res, mockNext);

    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({
      error: { message: "Job with id 42 not found", code: "NOT_FOUND" },
    });
  });

  it("handles ValidationError", () => {
    const err = new ValidationError("missing field");
    const res = createMockRes();

    errorHandler(err, mockReq, res, mockNext);

    expect(res.statusCode).toBe(400);
    expect(res.body).toEqual({
      error: { message: "missing field", code: "VALIDATION_ERROR" },
    });
  });

  it("handles ConflictError", () => {
    const err = new ConflictError("already exists");
    const res = createMockRes();

    errorHandler(err, mockReq, res, mockNext);

    expect(res.statusCode).toBe(409);
  });

  // ── PostgreSQL constraint error mapping ──

  it("maps Postgres 23505 (unique_violation) to 409 ConflictError", () => {
    const pgErr = { code: "23505", detail: "Key (email)=(alice@example.com) already exists." };
    const res = createMockRes();

    errorHandler(pgErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(409);
    expect((res.body as { error: { code: string } }).error.code).toBe("CONFLICT");
  });

  it("maps Postgres 23503 (foreign_key_violation) to 400 ValidationError", () => {
    const pgErr = { code: "23503", detail: "Key (job_id)=(999) is not present in table \"jobs\"." };
    const res = createMockRes();

    errorHandler(pgErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(400);
    expect((res.body as { error: { code: string } }).error.code).toBe("VALIDATION_ERROR");
  });

  it("maps Postgres 23502 (not_null_violation) to 400 ValidationError", () => {
    const pgErr = { code: "23502", detail: "null value in column \"title\"." };
    const res = createMockRes();

    errorHandler(pgErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(400);
  });

  it("maps Postgres 23514 (check_violation) to 400 ValidationError", () => {
    const pgErr = { code: "23514", detail: "violates check constraint." };
    const res = createMockRes();

    errorHandler(pgErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(400);
  });

  it("handles unknown Postgres error codes as 500", () => {
    const pgErr = { code: "42601", detail: "syntax error" };
    const res = createMockRes();

    errorHandler(pgErr, mockReq, res, mockNext);

    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("DATABASE_ERROR");
  });

  // ── Unknown errors ──

  it("handles unknown errors as 500", () => {
    const err = new Error("something broke");
    const res = createMockRes();

    errorHandler(err, mockReq, res, mockNext);

    expect(res.statusCode).toBe(500);
    expect((res.body as { error: { code: string } }).error.code).toBe("DATABASE_ERROR");
  });

  it("handles non-Error objects as 500", () => {
    const err = "string error";
    const res = createMockRes();

    errorHandler(err, mockReq, res, mockNext);

    expect(res.statusCode).toBe(500);
  });
});
