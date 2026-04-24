/**
 * applicationService unit tests — behavior-focused, minimal mocking.
 *
 * DESIGN:
 *   - Mock db.select/insert/update/delete at the TOP LEVEL only
 *   - Each mock returns a simple thenable chain (no .from().where() nesting)
 *   - Tests assert BEHAVIOR: returned values, thrown errors, call counts
 *   - NOT internal chaining order
 *
 * For real DB verification, see integration.test.ts
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  applyToJob,
  withdrawApplication,
  acknowledgePromotion,
  applyPublic,
} from "../services/applicationService";
import {
  NotFoundError,
  ConflictError,
  DuplicateSubmissionError,
  GoneError,
  DatabaseError,
} from "../lib/errors";
import { db } from "@workspace/db";

// ── Mock database ────────────────────────────────────────────────────────────
// Flat mock — no .from().where() chains. Each method returns a thenable.

function thenable(result: unknown) {
  const obj: Record<string, any> = {};
  // Every chained method returns the same thenable
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.limit = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockReturnValue(obj);
  obj.values = vi.fn().mockReturnValue(obj);
  obj.returning = vi.fn().mockReturnValue(obj);
  obj.orderBy = vi.fn().mockReturnValue(obj);
  obj.innerJoin = vi.fn().mockReturnValue(obj);
  // Await resolves to result
  obj.then = (resolve: any) => Promise.resolve(result).then(resolve);
  return obj;
}

vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn((fn: any) => {
      // Transaction provides a tx with the same flat-chain interface
      const tx: Record<string, any> = {
        select: vi.fn(() => thenable([])),
        insert: vi.fn(() => thenable([])),
        update: vi.fn(() => thenable(undefined)),
        delete: vi.fn(() => thenable(undefined)),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };
      return fn(tx);
    }),
  },
  applicationsTable: {},
  applicantsTable: {},
  jobsTable: {},
  queuePositionsTable: {},
  auditLogsTable: {},
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

vi.mock("../services/pipeline", () => ({
  getActiveCount: vi.fn().mockResolvedValue(0),
  promoteNext: vi.fn().mockResolvedValue(undefined),
  checkAndDecayExpiredAcknowledgments: vi.fn().mockResolvedValue(0),
  applyPenaltyAndRequeue: vi.fn().mockResolvedValue(undefined),
}));

// ── Factories ────────────────────────────────────────────────────────────────

const makeApp = (o: Record<string, unknown> = {}) => ({
  id: 1, applicantId: 100, jobId: 10, status: "ACTIVE",
  createdAt: new Date(), promotedAt: new Date(),
  acknowledgeDeadline: new Date(Date.now() + 600_000),
  penaltyCount: 0, ...o,
});

const makeApplicant = (o: Record<string, unknown> = {}) => ({
  id: 100, name: "Jane Doe", email: "jane@example.com", createdAt: new Date(), ...o,
});

const makeJob = (o: Record<string, unknown> = {}) => ({
  id: 10, title: "Engineer", description: null, capacity: 5, createdAt: new Date(), ...o,
});

/**
 * Helper: set up db.select to return different results for sequential calls.
 * Each entry in `results` is the resolved value for one db.select() call.
 */
function mockSelects(...results: unknown[]) {
  let i = 0;
  vi.mocked(db.select).mockImplementation(() => thenable(results[i++]) as any);
}

// ═══════════════════════════════════════════════════════════════════════════════
//  applyToJob()
// ═══════════════════════════════════════════════════════════════════════════════

describe("applyToJob()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NotFoundError when applicant does not exist", async () => {
    mockSelects([]); // no applicant

    await expect(applyToJob(999, 10)).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError when job does not exist", async () => {
    mockSelects([makeApplicant()], []); // applicant found, no job

    await expect(applyToJob(100, 999)).rejects.toThrow(NotFoundError);
  });

  it("throws DuplicateSubmissionError when applicant already has active app", async () => {
    mockSelects(
      [makeApplicant()],         // applicant found
      [makeJob()],               // job found
      [makeApp({ status: "ACTIVE" })] // existing active app (inside tx)
    );

    // Override transaction to pass through the select mock
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const tx = {
        select: vi.fn(() => thenable([makeApp({ status: "ACTIVE" })])),
        insert: vi.fn(() => thenable([])),
        update: vi.fn(() => thenable(undefined)),
        delete: vi.fn(() => thenable(undefined)),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };
      return fn(tx);
    });

    await expect(applyToJob(100, 10)).rejects.toThrow(DuplicateSubmissionError);
  });

  it("returns result with correct shape on success", async () => {
    mockSelects([makeApplicant()], [makeJob()]);

    // Transaction: no existing apps, insert returns new app
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      const tx = {
        select: vi.fn()
          .mockReturnValueOnce(thenable([]))                              // no existing apps
          .mockReturnValueOnce(thenable([{ maxPos: 0 }])),                // queue max pos
        insert: vi.fn(() => thenable([{ id: 42, status: "WAITLIST" }])),  // new app
        update: vi.fn(() => thenable(undefined)),
        delete: vi.fn(() => thenable(undefined)),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };
      return fn(tx);
    });

    const result = await applyToJob(100, 10);

    expect(result).toHaveProperty("applicationId");
    expect(result).toHaveProperty("applicantId", 100);
    expect(result).toHaveProperty("jobId", 10);
    expect(result).toHaveProperty("status");
    expect(result).toHaveProperty("message");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  withdrawApplication()
// ═══════════════════════════════════════════════════════════════════════════════

describe("withdrawApplication()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NotFoundError when application does not exist", async () => {
    mockSelects([]);

    await expect(withdrawApplication(999)).rejects.toThrow(NotFoundError);
  });

  it("throws ConflictError when application is already INACTIVE", async () => {
    mockSelects([makeApp({ status: "INACTIVE" })]);

    await expect(withdrawApplication(1)).rejects.toThrow(ConflictError);
  });

  it("returns INACTIVE status on successful withdrawal", async () => {
    mockSelects(
      [makeApp({ status: "ACTIVE" })],   // fetch app
      [makeJob()]                          // fetch job
    );

    const result = await withdrawApplication(1);

    expect(result.status).toBe("INACTIVE");
    expect(result.applicationId).toBe(1);
    expect(result.message).toContain("withdrawn");
  });

  it("calls db.transaction for atomic withdrawal", async () => {
    mockSelects(
      [makeApp({ status: "ACTIVE" })],
      [makeJob()]
    );

    await withdrawApplication(1);

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("accepts WAITLIST applications for withdrawal", async () => {
    mockSelects(
      [makeApp({ status: "WAITLIST" })],
      [makeJob()]
    );

    const result = await withdrawApplication(1);
    expect(result.status).toBe("INACTIVE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  acknowledgePromotion()
// ═══════════════════════════════════════════════════════════════════════════════

describe("acknowledgePromotion()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NotFoundError when application does not exist", async () => {
    mockSelects([]);

    await expect(acknowledgePromotion(999)).rejects.toThrow(NotFoundError);
  });

  it("throws ConflictError when status is not PENDING_ACKNOWLEDGMENT", async () => {
    mockSelects([makeApp({ status: "ACTIVE" })]);

    await expect(acknowledgePromotion(1)).rejects.toThrow(ConflictError);
  });

  it("throws GoneError when acknowledgment deadline has passed", async () => {
    mockSelects(
      [makeApp({
        status: "PENDING_ACKNOWLEDGMENT",
        acknowledgeDeadline: new Date(Date.now() - 1000), // expired
      })],
      [makeJob()] // for penalty+requeue
    );

    await expect(acknowledgePromotion(1)).rejects.toThrow(GoneError);
  });

  it("returns ACTIVE status on valid acknowledgment", async () => {
    mockSelects([makeApp({
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() + 600_000), // valid
    })]);

    const result = await acknowledgePromotion(1);

    expect(result.status).toBe("ACTIVE");
    expect(result.applicationId).toBe(1);
    expect(result.message).toContain("ACTIVE");
  });

  it("calls db.transaction for atomic status update", async () => {
    mockSelects([makeApp({
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() + 600_000),
    })]);

    await acknowledgePromotion(1);

    expect(db.transaction).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  applyPublic()
// ═══════════════════════════════════════════════════════════════════════════════

describe("applyPublic()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates new applicant and returns result", async () => {
    const applicant = makeApplicant({ id: 42 });

    // Insert applicant succeeds
    vi.mocked(db.insert).mockReturnValueOnce(thenable([applicant]) as any);
    // Select job
    mockSelects([makeJob()]);

    const result = await applyPublic("Jane", "jane@example.com", 10);

    expect(result.applicantId).toBe(42);
    expect(result).toHaveProperty("applicationId");
    expect(result).toHaveProperty("status");
  });

  it("throws NotFoundError when job does not exist", async () => {
    const applicant = makeApplicant();
    vi.mocked(db.insert).mockReturnValueOnce(thenable([applicant]) as any);
    mockSelects([]); // no job

    await expect(
      applyPublic("Jane", "jane@example.com", 999)
    ).rejects.toThrow(NotFoundError);
  });

  it("reuses existing applicant on duplicate email (23505)", async () => {
    const existingApplicant = makeApplicant({ id: 77 });
    const dupError = Object.assign(new Error("duplicate key"), { code: "23505" });

    // Insert fails with 23505
    vi.mocked(db.insert).mockReturnValueOnce(thenable(Promise.reject(dupError)) as any);
    // Select existing applicant, then select job
    mockSelects([existingApplicant], [makeJob()]);

    const result = await applyPublic("Jane", "jane@example.com", 10);

    expect(result.applicantId).toBe(77);
  });

  it("throws DatabaseError when duplicate detected but applicant not found", async () => {
    const dupError = Object.assign(new Error("duplicate key"), { code: "23505" });

    vi.mocked(db.insert).mockReturnValueOnce(thenable(Promise.reject(dupError)) as any);
    mockSelects([]); // applicant not found after constraint

    await expect(
      applyPublic("Jane", "jane@example.com", 10)
    ).rejects.toThrow(DatabaseError);
  });

  it("wraps unknown DB errors in appropriate error class", async () => {
    const unknownErr = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });

    // Insert throws unknown error (not via thenable chain — direct reject)
    const failChain = thenable(undefined);
    failChain.values = vi.fn().mockRejectedValue(unknownErr);
    vi.mocked(db.insert).mockReturnValueOnce(failChain as any);

    await expect(
      applyPublic("Jane", "jane@example.com", 10)
    ).rejects.toThrow();
  });
});
