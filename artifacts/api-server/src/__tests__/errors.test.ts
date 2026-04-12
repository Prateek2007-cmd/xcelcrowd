import { describe, it, expect } from "vitest";
import {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  DuplicateSubmissionError,
  GoneError,
  InvalidTransitionError,
  DatabaseError,
} from "../lib/errors";

describe("Error Classes", () => {
  describe("AppError", () => {
    it("has correct properties", () => {
      const err = new AppError("test", 400, "TEST_CODE");
      expect(err.message).toBe("test");
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe("TEST_CODE");
      expect(err.name).toBe("AppError");
    });

    it("returns structured JSON", () => {
      const err = new AppError("test", 400, "TEST_CODE");
      expect(err.toJSON()).toEqual({
        error: { message: "test", code: "TEST_CODE" },
      });
    });

    it("is an instanceof Error", () => {
      const err = new AppError("test", 400, "TEST_CODE");
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(AppError);
    });
  });

  describe("ValidationError", () => {
    it("has status 400 and VALIDATION_ERROR code", () => {
      const err = new ValidationError("bad input");
      expect(err.statusCode).toBe(400);
      expect(err.code).toBe("VALIDATION_ERROR");
      expect(err).toBeInstanceOf(AppError);
    });
  });

  describe("NotFoundError", () => {
    it("has status 404 with resource name and id", () => {
      const err = new NotFoundError("Job", 42);
      expect(err.statusCode).toBe(404);
      expect(err.code).toBe("NOT_FOUND");
      expect(err.message).toContain("Job");
      expect(err.message).toContain("42");
    });

    it("works without id", () => {
      const err = new NotFoundError("Applicant");
      expect(err.message).toBe("Applicant not found");
    });
  });

  describe("ConflictError", () => {
    it("has status 409", () => {
      const err = new ConflictError("already exists");
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe("CONFLICT");
    });
  });

  describe("DuplicateSubmissionError", () => {
    it("has status 409 and DUPLICATE_SUBMISSION code", () => {
      const err = new DuplicateSubmissionError(1, 2);
      expect(err.statusCode).toBe(409);
      expect(err.code).toBe("DUPLICATE_SUBMISSION");
      expect(err.message).toContain("1");
      expect(err.message).toContain("2");
    });
  });

  describe("GoneError", () => {
    it("has status 410", () => {
      const err = new GoneError("window expired");
      expect(err.statusCode).toBe(410);
      expect(err.code).toBe("GONE");
    });
  });

  describe("InvalidTransitionError", () => {
    it("has status 422 and includes from/to in message", () => {
      const err = new InvalidTransitionError("ACTIVE", "WAITLIST");
      expect(err.statusCode).toBe(422);
      expect(err.code).toBe("INVALID_TRANSITION");
      expect(err.message).toContain("ACTIVE");
      expect(err.message).toContain("WAITLIST");
    });
  });

  describe("DatabaseError", () => {
    it("has status 500 with default message", () => {
      const err = new DatabaseError();
      expect(err.statusCode).toBe(500);
      expect(err.code).toBe("DATABASE_ERROR");
      expect(err.message).toBe("A database error occurred");
    });

    it("accepts custom message", () => {
      const err = new DatabaseError("connection failed");
      expect(err.message).toBe("connection failed");
    });
  });
});
