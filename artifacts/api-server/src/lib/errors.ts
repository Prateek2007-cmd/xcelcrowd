/**
 * Custom error hierarchy for structured API error responses.
 * All errors follow the format: { error: { message, code } }
 */

export class AppError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode: number, code: string) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  toJSON() {
    return {
      error: {
        message: this.message,
        code: this.code,
      },
    };
  }
}

/** 400 — Validation failures (Zod parse, bad input) */
export class ValidationError extends AppError {
  constructor(message: string) {
    super(message, 400, "VALIDATION_ERROR");
  }
}

/** 404 — Resource not found */
export class NotFoundError extends AppError {
  constructor(resource: string, id?: number | string) {
    const msg = id != null ? `${resource} with id ${id} not found` : `${resource} not found`;
    super(msg, 404, "NOT_FOUND");
  }
}

/** 409 — Conflict (duplicate submission, already inactive, etc.) */
export class ConflictError extends AppError {
  constructor(message: string) {
    super(message, 409, "CONFLICT");
  }
}

/** 409 — Specifically for duplicate application submissions */
export class DuplicateSubmissionError extends AppError {
  constructor(applicantId: number, jobId: number) {
    super(
      `Applicant ${applicantId} already has an active application for job ${jobId}`,
      409,
      "DUPLICATE_SUBMISSION"
    );
  }
}

/** 410 — Gone (expired acknowledgment window) */
export class GoneError extends AppError {
  constructor(message: string) {
    super(message, 410, "GONE");
  }
}

/** 422 — Invalid state transition */
export class InvalidTransitionError extends AppError {
  constructor(from: string, to: string) {
    super(
      `Invalid state transition from '${from}' to '${to}'`,
      422,
      "INVALID_TRANSITION"
    );
  }
}

/** 500 — Internal / database errors */
export class DatabaseError extends AppError {
  constructor(message: string = "A database error occurred") {
    super(message, 500, "DATABASE_ERROR");
  }
}
