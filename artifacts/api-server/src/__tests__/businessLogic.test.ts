/**
 * Business logic tests — improved with deeper edge-case validation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock DB ─────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    transaction: vi.fn(),
    execute: vi.fn(),
  },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Imports ─────────────────────────────────────────────
import { db } from "@workspace/db";

import {
  applyToJob,
  withdrawApplication,
  acknowledgePromotion,
} from "../services/applicationService";

import {
  NotFoundError,
  ConflictError,
  DuplicateSubmissionError,
  GoneError,
} from "../lib/errors";

// ───────────────────────────────────────────────────────
// applyToJob
// ───────────────────────────────────────────────────────
describe("applyToJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NotFoundError if applicant does not exist", async () => {
    (db.select as any).mockResolvedValueOnce([]);
    await expect(applyToJob(999, 1)).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError if job does not exist", async () => {
    (db.select as any)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([]);

    await expect(applyToJob(1, 999)).rejects.toThrow(NotFoundError);
  });

  it("throws DuplicateSubmissionError if active application exists", async () => {
    (db.select as any)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 1, capacity: 3 }])
      .mockResolvedValueOnce([{ id: 10, status: "ACTIVE" }]);

    await expect(applyToJob(1, 1)).rejects.toThrow(DuplicateSubmissionError);
  });

  it("assigns ACTIVE when capacity is available", async () => {
    (db.select as any)
      .mockResolvedValueOnce([{ id: 1 }]) // applicant
      .mockResolvedValueOnce([{ id: 1, capacity: 3 }]) // job
      .mockResolvedValueOnce([]); // no existing app

    (db.transaction as any).mockImplementation(async (fn: any) => {
      return fn({
        select: vi.fn().mockResolvedValue([{ count: 1 }]), // below capacity
        insert: vi.fn().mockResolvedValue([{ id: 100, status: "ACTIVE" }]),
        update: vi.fn(),
        delete: vi.fn(),
        execute: vi.fn(),
      });
    });

    const result = await applyToJob(1, 1);

    expect(result).toBeDefined();
    expect(result.status).toBe("ACTIVE");
  });

  it("assigns WAITLIST when capacity is full", async () => {
    (db.select as any)
      .mockResolvedValueOnce([{ id: 1 }])
      .mockResolvedValueOnce([{ id: 1, capacity: 1 }])
      .mockResolvedValueOnce([]);

    (db.transaction as any).mockImplementation(async (fn: any) => {
      return fn({
        select: vi.fn().mockResolvedValue([{ count: 1 }]), // at capacity
        insert: vi.fn().mockResolvedValue([{ id: 101, status: "WAITLIST" }]),
        update: vi.fn(),
        delete: vi.fn(),
        execute: vi.fn(),
      });
    });

    const result = await applyToJob(1, 1);

    expect(result.status).toBe("WAITLIST");
  });
});

// ───────────────────────────────────────────────────────
// withdrawApplication
// ───────────────────────────────────────────────────────
describe("withdrawApplication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NotFoundError if application does not exist", async () => {
    (db.select as any).mockResolvedValueOnce([]);
    await expect(withdrawApplication(999)).rejects.toThrow(NotFoundError);
  });

  it("throws ConflictError if already inactive", async () => {
    (db.select as any).mockResolvedValueOnce([
      { id: 1, status: "INACTIVE", applicantId: 1, jobId: 1 },
    ]);

    await expect(withdrawApplication(1)).rejects.toThrow(ConflictError);
  });

  it("successfully withdraws active application", async () => {
    (db.select as any).mockResolvedValueOnce([
      { id: 1, status: "ACTIVE", applicantId: 1, jobId: 1 },
    ]);

    (db.transaction as any).mockImplementation(async (fn: any) => {
      return fn({
        update: vi.fn().mockResolvedValue([{ id: 1, status: "INACTIVE" }]),
        select: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
        execute: vi.fn(),
      });
    });

    const result = await withdrawApplication(1);

    expect(result).toBeDefined();
  });
});

// ───────────────────────────────────────────────────────
// acknowledgePromotion
// ───────────────────────────────────────────────────────
describe("acknowledgePromotion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NotFoundError if application not found", async () => {
    (db.select as any).mockResolvedValueOnce([]);
    await expect(acknowledgePromotion(999)).rejects.toThrow(NotFoundError);
  });

  it("throws ConflictError if not pending acknowledgment", async () => {
    (db.select as any).mockResolvedValueOnce([
      {
        id: 1,
        status: "ACTIVE",
        applicantId: 1,
        jobId: 1,
        acknowledgeDeadline: null,
      },
    ]);

    await expect(acknowledgePromotion(1)).rejects.toThrow(ConflictError);
  });

  it("throws GoneError if acknowledgment expired", async () => {
    const pastDeadline = new Date(Date.now() - 60000);

    (db.select as any)
      .mockResolvedValueOnce([
        {
          id: 1,
          status: "PENDING_ACKNOWLEDGMENT",
          applicantId: 1,
          jobId: 1,
          acknowledgeDeadline: pastDeadline,
        },
      ])
      .mockResolvedValueOnce([{ id: 1, capacity: 3 }]);

    (db.transaction as any).mockImplementation(async (fn: any) => {
      await fn({
        select: vi.fn().mockResolvedValue([{ count: 3 }]),
        insert: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
        execute: vi.fn(),
      });
    });

    await expect(acknowledgePromotion(1)).rejects.toThrow(GoneError);
  });

  it("successfully acknowledges promotion", async () => {
    const futureDeadline = new Date(Date.now() + 60000);

    (db.select as any).mockResolvedValueOnce([
      {
        id: 1,
        status: "PENDING_ACKNOWLEDGMENT",
        applicantId: 1,
        jobId: 1,
        acknowledgeDeadline: futureDeadline,
      },
    ]);

    (db.transaction as any).mockImplementation(async (fn: any) => {
      return fn({
        update: vi.fn().mockResolvedValue([{ id: 1, status: "ACTIVE" }]),
        select: vi.fn(),
        insert: vi.fn(),
        delete: vi.fn(),
        execute: vi.fn(),
      });
    });

    const result = await acknowledgePromotion(1);

    expect(result).toBeDefined();
  });
});