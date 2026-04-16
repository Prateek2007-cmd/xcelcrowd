/**
 * Business logic tests — simplified and readable.
 * Directly mocks DB methods without complex helper chains.
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
      .mockResolvedValueOnce([{ id: 1 }]) // applicant exists
      .mockResolvedValueOnce([]); // job not found

    await expect(applyToJob(1, 999)).rejects.toThrow(NotFoundError);
  });

  it("throws DuplicateSubmissionError if active application exists", async () => {
    (db.select as any)
      .mockResolvedValueOnce([{ id: 1 }]) // applicant
      .mockResolvedValueOnce([{ id: 1, capacity: 3 }]) // job
      .mockResolvedValueOnce([{ id: 10, status: "ACTIVE" }]); // existing app

    await expect(applyToJob(1, 1)).rejects.toThrow(DuplicateSubmissionError);
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
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      });
    });

    await expect(acknowledgePromotion(1)).rejects.toThrow(GoneError);
  });
});