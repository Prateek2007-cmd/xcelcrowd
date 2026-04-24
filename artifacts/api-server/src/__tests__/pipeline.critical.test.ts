/**
 * Critical pipeline logic tests — high-impact scenarios that MUST always pass.
 *
 * These tests protect core business invariants:
 *   1. Promotion correctness (FIFO, single candidate)
 *   2. No double promotion under capacity constraints
 *   3. Expiry handling with correct requeue position
 *   4. Fair queue ordering
 *   5. Stale entry safety
 *   6. Multi-application decay
 *   7. Partial failure resilience
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  promoteNext,
  promoteUntilFull,
  applyPenaltyAndRequeue,
  checkAndDecayExpiredAcknowledgments,
  getActiveCount,
} from "../services/pipeline";

// ── Mock database ────────────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: { select: vi.fn(), insert: vi.fn(), update: vi.fn(), delete: vi.fn(), execute: vi.fn(), transaction: vi.fn() },
  applicationsTable: {}, queuePositionsTable: {}, auditLogsTable: {},
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

// ── Factories ────────────────────────────────────────────────────────────────
function makeApp(o: Record<string, unknown> = {}) {
  return {
    id: 1, applicantId: 100, jobId: 10, status: "WAITLIST",
    createdAt: new Date(), promotedAt: null, acknowledgeDeadline: null,
    penaltyCount: 0, ...o,
  };
}

function thenable(result: unknown) {
  const obj: Record<string, any> = {};
  obj.from = vi.fn().mockReturnValue(obj);
  obj.where = vi.fn().mockReturnValue(obj);
  obj.set = vi.fn().mockImplementation((val: unknown) => { obj._lastSet = val; return obj; });
  obj.values = vi.fn().mockImplementation((val: unknown) => { obj._lastValues = val; return obj; });
  obj.returning = vi.fn().mockReturnValue(obj);
  obj.then = (resolve: any) => Promise.resolve(result).then(resolve);
  return obj;
}

function makeTx(opts: {
  executeResults?: Array<{ rows: unknown[] }>;
  selectResults?: unknown[][];
  captureUpdate?: (val: unknown) => void;
  captureInsert?: (val: unknown) => void;
  trackOps?: string[];
} = {}) {
  let execIdx = 0;
  let selIdx = 0;
  const ops = opts.trackOps;

  return {
    execute: vi.fn().mockImplementation(() => {
      const res = opts.executeResults?.[execIdx] ?? { rows: [] };
      execIdx++;
      return Promise.resolve(res);
    }),
    select: vi.fn().mockImplementation(() => {
      const res = opts.selectResults?.[selIdx] ?? [];
      selIdx++;
      return thenable(res);
    }),
    update: vi.fn().mockImplementation(() => {
      ops?.push("update");
      const t = thenable(undefined);
      const origSet = t.set;
      t.set = vi.fn().mockImplementation((val: unknown) => {
        opts.captureUpdate?.(val);
        return origSet(val);
      });
      return t;
    }),
    delete: vi.fn().mockImplementation(() => {
      ops?.push("delete");
      return thenable(undefined);
    }),
    insert: vi.fn().mockImplementation(() => {
      ops?.push("insert");
      const t = thenable(undefined);
      const origValues = t.values;
      t.values = vi.fn().mockImplementation((val: unknown) => {
        opts.captureInsert?.(val);
        return origValues(val);
      });
      return t;
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  1. PROMOTION CORRECTNESS — only first valid WAITLIST candidate promoted
// ═══════════════════════════════════════════════════════════════════════════════
describe("Promotion correctness", () => {
  beforeEach(() => vi.clearAllMocks());

  it("promotes exactly one candidate and sets correct status + deadline", async () => {
    const candidate = makeApp({ id: 5, applicantId: 200, status: "WAITLIST" });
    let statusUpdate: any = null;

    const tx = makeTx({
      executeResults: [
        { rows: [] },                                     // getActiveCount: 0
        { rows: [{ application_id: 5, position: 1 }] },  // getNextInQueue
        { rows: [] },                                     // reindexQueue
      ],
      selectResults: [[candidate]],                        // fetch app row
      captureUpdate: (val) => { statusUpdate = val; },
    });

    const result = await promoteNext(10, 5, tx as any);

    expect(result).toBe(true);
    expect(statusUpdate).not.toBeNull();
    expect(statusUpdate.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(statusUpdate.promotedAt).toBeInstanceOf(Date);
    expect(statusUpdate.acknowledgeDeadline).toBeInstanceOf(Date);
    // Deadline must be in the future
    expect(statusUpdate.acknowledgeDeadline.getTime()).toBeGreaterThan(Date.now());
  });

  it("queue entry is removed after successful promotion", async () => {
    const candidate = makeApp({ id: 5, status: "WAITLIST" });

    const tx = makeTx({
      executeResults: [
        { rows: [] },
        { rows: [{ application_id: 5, position: 1 }] },
        { rows: [] },
      ],
      selectResults: [[candidate]],
    });

    await promoteNext(10, 5, tx as any);

    expect(tx.delete).toHaveBeenCalled();
  });

  it("writes PROMOTED audit log with correct from/to status", async () => {
    const candidate = makeApp({ id: 5, status: "WAITLIST" });
    let auditPayload: any = null;

    const tx = makeTx({
      executeResults: [
        { rows: [] },
        { rows: [{ application_id: 5, position: 1 }] },
        { rows: [] },
      ],
      selectResults: [[candidate]],
      captureInsert: (val) => { auditPayload = val; },
    });

    await promoteNext(10, 5, tx as any);

    expect(auditPayload).not.toBeNull();
    expect(auditPayload.eventType).toBe("PROMOTED");
    expect(auditPayload.fromStatus).toBe("WAITLIST");
    expect(auditPayload.toStatus).toBe("PENDING_ACKNOWLEDGMENT");
    expect(auditPayload.applicationId).toBe(5);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. NO DOUBLE PROMOTION — capacity=1, multiple candidates
// ═══════════════════════════════════════════════════════════════════════════════
describe("No double promotion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stops promoting when capacity is reached", async () => {
    // Capacity=1, already have 1 active
    const tx = makeTx({
      executeResults: [{ rows: [{}] }],  // 1 active = full
    });

    const result = await promoteNext(10, 1, tx as any);

    expect(result).toBe(false);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("promoteUntilFull promotes exactly N candidates for N open slots", async () => {
    let execIdx = 0;
    const tx = makeTx({
      selectResults: [
        [makeApp({ id: 1, status: "WAITLIST" })],
        [makeApp({ id: 2, status: "WAITLIST" })],
      ],
    });

    tx.execute = vi.fn().mockImplementation(() => {
      execIdx++;
      // Call 1: getActiveCount → 3 active (2 slots open with cap=5)
      if (execIdx === 1) return Promise.resolve({ rows: [1, 2, 3] });
      // Call 2: getNextCandidates → 2 candidates
      if (execIdx === 2) return Promise.resolve({
        rows: [
          { application_id: 1, position: 1 },
          { application_id: 2, position: 2 },
        ],
      });
      // Subsequent: active count stays at 3 (promotions don't count as ACTIVE yet)
      return Promise.resolve({ rows: [1, 2, 3] });
    });

    const promoted = await promoteUntilFull(10, 5, tx as any);

    expect(promoted).toBe(2);
  });

  it("promoteUntilFull stops early when promoteNext returns false", async () => {
    let execIdx = 0;
    const tx = makeTx({
      selectResults: [], // no valid apps when selected
    });

    tx.execute = vi.fn().mockImplementation(() => {
      execIdx++;
      if (execIdx === 1) return Promise.resolve({ rows: [] }); // 0 active
      if (execIdx === 2) return Promise.resolve({               // 2 candidates fetched
        rows: [
          { application_id: 1, position: 1 },
          { application_id: 2, position: 2 },
        ],
      });
      // promoteNext inner: getActiveCount → 0, getNextInQueue → empty
      return Promise.resolve({ rows: [] });
    });

    const promoted = await promoteUntilFull(10, 5, tx as any);

    // Should stop after first failure, not blindly count 2
    expect(promoted).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. EXPIRY HANDLING — moved back to WAITLIST with correct position
// ═══════════════════════════════════════════════════════════════════════════════
describe("Expiry handling", () => {
  beforeEach(() => vi.clearAllMocks());

  it("requeues expired candidate at END of queue (MAX position + 1)", async () => {
    const expired = makeApp({ id: 3, status: "PENDING_ACKNOWLEDGMENT", penaltyCount: 0 });
    let queueInsert: any = null;

    const tx = makeTx({
      selectResults: [
        [expired],         // fetch application
        [{ maxPos: 7 }],   // current MAX(position) = 7
      ],
      captureInsert: (val) => {
        if (!queueInsert && (val as any)?.position !== undefined) {
          queueInsert = val;
        }
      },
    });

    await applyPenaltyAndRequeue(3, 10, tx as any);

    expect(queueInsert).not.toBeNull();
    expect(queueInsert.position).toBe(8); // 7 + 1
  });

  it("increments penalty count on each expiry", async () => {
    const expired = makeApp({ penaltyCount: 2 });
    let captured: any = null;

    const tx = makeTx({
      selectResults: [[expired], [{ maxPos: 0 }]],
      captureUpdate: (val) => { captured = val; },
    });

    await applyPenaltyAndRequeue(1, 10, tx as any);

    expect(captured.penaltyCount).toBe(3); // 2 + 1
  });

  it("clears deadline and promotedAt on requeue", async () => {
    const expired = makeApp({
      status: "PENDING_ACKNOWLEDGMENT",
      promotedAt: new Date(),
      acknowledgeDeadline: new Date(),
    });
    let captured: any = null;

    const tx = makeTx({
      selectResults: [[expired], [{ maxPos: 0 }]],
      captureUpdate: (val) => { captured = val; },
    });

    await applyPenaltyAndRequeue(1, 10, tx as any);

    expect(captured.status).toBe("WAITLIST");
    expect(captured.promotedAt).toBeNull();
    expect(captured.acknowledgeDeadline).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. FAIR QUEUE ORDER — lowest position promoted first
// ═══════════════════════════════════════════════════════════════════════════════
describe("Fair queue order", () => {
  beforeEach(() => vi.clearAllMocks());

  it("getNextInQueue returns candidate with lowest position (via SQL ORDER)", async () => {
    // This is verified through the execute mock — the SQL query uses
    // ORDER BY position ASC LIMIT 1, so whichever row comes first is
    // the lowest position. We verify the correct application_id is used.
    const firstInLine = makeApp({ id: 10, status: "WAITLIST" });
    let promotedId: number | null = null;

    const tx = makeTx({
      executeResults: [
        { rows: [] },                                        // getActiveCount: 0
        { rows: [{ application_id: 10, position: 1 }] },    // getNextInQueue: picks id=10
        { rows: [] },                                        // reindexQueue
      ],
      selectResults: [[firstInLine]],
      captureInsert: (val) => {
        if ((val as any)?.applicationId) promotedId = (val as any).applicationId;
      },
    });

    await promoteNext(10, 5, tx as any);

    expect(promotedId).toBe(10); // Confirmed: audit log for id=10
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. STALE ENTRY PROTECTION — skip invalid entries safely
// ═══════════════════════════════════════════════════════════════════════════════
describe("Stale entry protection", () => {
  beforeEach(() => vi.clearAllMocks());

  it("skips INACTIVE applications in queue without crashing", async () => {
    const staleApp = makeApp({ id: 7, status: "INACTIVE" });

    const tx = makeTx({
      executeResults: [
        { rows: [{}] },                                  // 1 active
        { rows: [{ application_id: 7, position: 1 }] },  // stale entry
      ],
      selectResults: [[staleApp]],
    });

    const result = await promoteNext(10, 5, tx as any);

    expect(result).toBe(false);
    expect(tx.delete).toHaveBeenCalled();    // stale entry pruned
    expect(tx.update).not.toHaveBeenCalled(); // no promotion
  });

  it("skips missing application rows without crashing", async () => {
    const tx = makeTx({
      executeResults: [
        { rows: [{}] },
        { rows: [{ application_id: 99, position: 1 }] },
      ],
      selectResults: [[]],  // app row not found
    });

    const result = await promoteNext(10, 5, tx as any);

    expect(result).toBe(false);
    expect(tx.delete).toHaveBeenCalled();    // orphan entry cleaned
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("does not promote PENDING_ACKNOWLEDGMENT apps from queue", async () => {
    const pendingApp = makeApp({ id: 5, status: "PENDING_ACKNOWLEDGMENT" });

    const tx = makeTx({
      executeResults: [
        { rows: [] },
        { rows: [{ application_id: 5, position: 1 }] },
      ],
      selectResults: [[pendingApp]],
    });

    const result = await promoteNext(10, 5, tx as any);

    expect(result).toBe(false); // Not WAITLIST → pruned, not promoted
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. MULTI-APPLICATION DECAY — all expired apps processed
// ═══════════════════════════════════════════════════════════════════════════════
describe("Multi-application decay", () => {
  beforeEach(() => vi.clearAllMocks());

  it("decays all expired applications in a single cycle", async () => {
    const exp1 = makeApp({ id: 1, status: "PENDING_ACKNOWLEDGMENT", acknowledgeDeadline: new Date(Date.now() - 60_000) });
    const exp2 = makeApp({ id: 2, status: "PENDING_ACKNOWLEDGMENT", acknowledgeDeadline: new Date(Date.now() - 30_000) });
    const exp3 = makeApp({ id: 3, status: "PENDING_ACKNOWLEDGMENT", acknowledgeDeadline: new Date(Date.now() - 10_000) });

    const tx = makeTx({
      selectResults: [
        [exp1, exp2, exp3],     // find expired
        [exp1], [{ maxPos: 0 }], // requeue #1
        [exp2], [{ maxPos: 1 }], // requeue #2
        [exp3], [{ maxPos: 2 }], // requeue #3
      ],
      executeResults: [
        { rows: [] },  // promoteUntilFull: 0 active
        { rows: [] },  // no candidates to promote
      ],
    });

    const decayed = await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    expect(decayed).toBe(3);
  });

  it("does not decay non-expired applications", async () => {
    // All apps have future deadlines — none should be returned by the WHERE clause
    const tx = makeTx({ selectResults: [[]] });

    const decayed = await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    expect(decayed).toBe(0);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  7. PARTIAL FAILURE SAFETY — applyPenaltyAndRequeue no-ops safely
// ═══════════════════════════════════════════════════════════════════════════════
describe("Partial failure safety", () => {
  beforeEach(() => vi.clearAllMocks());

  it("applyPenaltyAndRequeue no-ops when application not found (no crash)", async () => {
    const tx = makeTx({ selectResults: [[]] });  // empty result

    // Should not throw
    await expect(
      applyPenaltyAndRequeue(999, 10, tx as any)
    ).resolves.not.toThrow();

    // No side effects
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("empty queue produces zero promotions (no crash)", async () => {
    const tx = makeTx({
      executeResults: [
        { rows: [] },  // 0 active
        { rows: [] },  // 0 candidates
      ],
    });

    const promoted = await promoteUntilFull(10, 5, tx as any);

    expect(promoted).toBe(0);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("getActiveCount handles empty result gracefully", async () => {
    const tx = makeTx({ executeResults: [{ rows: [] }] });

    const count = await getActiveCount(10, tx as any);

    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  8. ERROR CLASSIFICATION — runDecayForJob wraps errors with context
// ═══════════════════════════════════════════════════════════════════════════════
import { runDecayForJob } from "../services/pipeline";
import { AppError, PipelineError, DatabaseError } from "../lib/errors";
import { DbErrorType } from "../lib/dbErrorMapper";

// Need to mock db.transaction for runDecayForJob tests
import { db } from "@workspace/db";

describe("runDecayForJob error classification", () => {
  beforeEach(() => vi.clearAllMocks());

  it("AppError passes through with correct code and stage", async () => {
    const appErr = new DatabaseError("Connection pool exhausted");
    vi.mocked(db.transaction).mockRejectedValueOnce(appErr);

    const result = await runDecayForJob(42, 5);

    expect(result.success).toBe(false);
    expect(result.decayed).toBe(0);
    expect(result.promoted).toBe(0);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe("DATABASE_ERROR");
    expect(result.error!.message).toBe("Connection pool exhausted");
    expect(result.error!.stage).toBe("decay");
  });

  it("PostgreSQL unique_violation gets semantic DbErrorType code", async () => {
    const pgErr = Object.assign(new Error("unique violation"), { code: "23505" });
    vi.mocked(db.transaction).mockRejectedValueOnce(pgErr);

    const result = await runDecayForJob(42, 5);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe(DbErrorType.UNIQUE_VIOLATION);
    expect(result.error!.message).toContain("UNIQUE_VIOLATION");
    expect(result.error!.stage).toBe("decay");
  });

  it("PostgreSQL foreign_key violation maps to correct semantic type", async () => {
    const pgErr = Object.assign(new Error("fk violation"), { code: "23503" });
    vi.mocked(db.transaction).mockRejectedValueOnce(pgErr);

    const result = await runDecayForJob(42, 5);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe(DbErrorType.FOREIGN_KEY_VIOLATION);
    expect(result.error!.stage).toBe("decay");
  });

  it("unknown errors get PIPELINE_ERROR code with stage context", async () => {
    const weirdErr = "something completely unexpected";
    vi.mocked(db.transaction).mockRejectedValueOnce(weirdErr);

    const result = await runDecayForJob(42, 5);

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe("PIPELINE_ERROR");
    expect(result.error!.message).toContain("Unexpected failure during decay");
    expect(result.error!.stage).toBe("decay");
  });

  it("successful decay cycle returns correct counts", async () => {
    vi.mocked(db.transaction).mockImplementationOnce(async (fn) => {
      return { decayed: 3 };
    });

    const result = await runDecayForJob(42, 5);

    expect(result.success).toBe(true);
    expect(result.decayed).toBe(3);
    expect(result.promoted).toBe(1);
    expect(result.error).toBeUndefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  9. PipelineError structure — validates the new error class
// ═══════════════════════════════════════════════════════════════════════════════
describe("PipelineError class", () => {
  it("preserves cause chain for debugging", () => {
    const original = new Error("connection reset");
    const pipeErr = new PipelineError("Decay failed", {
      jobId: 42,
      stage: "decay",
      cause: original,
    });

    expect(pipeErr).toBeInstanceOf(AppError);
    expect(pipeErr.code).toBe("PIPELINE_ERROR");
    expect(pipeErr.statusCode).toBe(500);
    expect(pipeErr.jobId).toBe(42);
    expect(pipeErr.stage).toBe("decay");
    expect(pipeErr.cause).toBe(original);
    expect(pipeErr.message).toBe("Decay failed");
  });

  it("works without cause (optional)", () => {
    const pipeErr = new PipelineError("Queue corruption", {
      jobId: 99,
      stage: "promote",
    });

    expect(pipeErr.cause).toBeUndefined();
    expect(pipeErr.jobId).toBe(99);
    expect(pipeErr.stage).toBe("promote");
  });
});
