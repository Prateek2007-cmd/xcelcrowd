import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  promoteNext,
  checkAndDecayExpiredAcknowledgments,
} from "../services/pipeline";

// ── Mock database layer ──────────────────────────────────────────────────────
vi.mock("@workspace/db", () => ({
  db: {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
    transaction: vi.fn(),
  },
  applicationsTable: {},
  queuePositionsTable: {},
  auditLogsTable: {},
}));

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Factories ────────────────────────────────────────────────────────────────

function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    applicantId: 100,
    jobId: 10,
    status: "WAITLIST" as string,
    createdAt: new Date("2025-01-01"),
    promotedAt: null as Date | null,
    acknowledgeDeadline: null as Date | null,
    penaltyCount: 0,
    ...overrides,
  };
}

/**
 * Build a mock `tx` object that mirrors Drizzle's chainable API.
 *
 * - `executeResults`:  consumed sequentially by `tx.execute()`
 * - `selectResults`:   consumed sequentially by `tx.select().from().where()`
 * - `captureUpdate`:   callback receives the payload passed to `.set()`
 * - `captureInsert`:   callback receives the payload passed to `.values()`
 * - `trackOps`:        array that records operation names in call order
 */
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
    select: vi.fn().mockImplementation(() => ({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockImplementation(() => {
          const res = opts.selectResults?.[selIdx] ?? [];
          selIdx++;
          return Promise.resolve(res);
        }),
      }),
    })),
    update: vi.fn().mockImplementation(() => {
      ops?.push("update");
      return {
        set: vi.fn().mockImplementation((val: unknown) => {
          opts.captureUpdate?.(val);
          return { where: vi.fn().mockResolvedValue(undefined) };
        }),
      };
    }),
    delete: vi.fn().mockImplementation(() => {
      ops?.push("delete");
      return { where: vi.fn().mockResolvedValue(undefined) };
    }),
    insert: vi.fn().mockImplementation(() => {
      ops?.push("insert");
      return {
        values: vi.fn().mockImplementation((val: unknown) => {
          opts.captureInsert?.(val);
          return Promise.resolve(undefined);
        }),
      };
    }),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
//  promoteNext()  —  CORE PROMOTION LOGIC
// ═══════════════════════════════════════════════════════════════════════════════

describe("promoteNext() — core promotion logic", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── CASE 1: Successful promotion ─────────────────────────────────────────

  it("promotes WAITLIST → PENDING_ACKNOWLEDGMENT with correct fields", async () => {
    const candidate = makeApp({ id: 5, status: "WAITLIST" });
    let statusUpdate: any = null;

    const tx = makeTx({
      executeResults: [
        { rows: [] },                                        // getActiveCount → 0
        { rows: [{ application_id: 5, position: 1 }] },     // getNextInQueue
        { rows: [] },                                        // reindexQueue CTE
      ],
      selectResults: [[candidate]],                          // app lookup
      captureUpdate: (val) => { statusUpdate = val; },
    });

    await promoteNext(10, 5, tx as any);

    expect(statusUpdate).not.toBeNull();
    expect(statusUpdate.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(statusUpdate.promotedAt).toBeInstanceOf(Date);
    expect(statusUpdate.acknowledgeDeadline).toBeInstanceOf(Date);
    // Deadline should be ~5 min in the future
    const deadlineMs = statusUpdate.acknowledgeDeadline.getTime() - Date.now();
    expect(deadlineMs).toBeGreaterThan(200_000);   // > 3 min
    expect(deadlineMs).toBeLessThanOrEqual(310_000); // ≤ ~5 min + buffer
  });

  it("deletes queue entry after promotion", async () => {
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

  it("writes PROMOTED audit log with correct from/to statuses", async () => {
    const candidate = makeApp({ id: 5, status: "WAITLIST" });
    const inserts: any[] = [];

    const tx = makeTx({
      executeResults: [
        { rows: [] },
        { rows: [{ application_id: 5, position: 1 }] },
        { rows: [] },
      ],
      selectResults: [[candidate]],
      captureInsert: (val) => inserts.push(val),
    });

    await promoteNext(10, 5, tx as any);

    // The audit log insert (after queue position delete)
    const auditEntry = inserts.find((i) => i.eventType === "PROMOTED");
    expect(auditEntry).toBeDefined();
    expect(auditEntry.fromStatus).toBe("WAITLIST");
    expect(auditEntry.toStatus).toBe("PENDING_ACKNOWLEDGMENT");
    expect(auditEntry.applicationId).toBe(5);
  });

  it("calls reindexQueue after removing queue entry", async () => {
    const candidate = makeApp({ id: 5, status: "WAITLIST" });
    const ops: string[] = [];

    const tx = makeTx({
      executeResults: [
        { rows: [] },
        { rows: [{ application_id: 5, position: 1 }] },
        { rows: [] },   // reindexQueue CTE
      ],
      selectResults: [[candidate]],
      trackOps: ops,
    });

    await promoteNext(10, 5, tx as any);

    // tx.execute is called 3 times: getActiveCount, getNextInQueue, reindexQueue
    expect(tx.execute).toHaveBeenCalledTimes(3);
  });

  // ── CASE 2: No candidate ────────────────────────────────────────────────

  it("makes no writes when queue is empty", async () => {
    const tx = makeTx({
      executeResults: [
        { rows: [{}] },  // 1 active (below cap)
        { rows: [] },    // empty queue
      ],
    });

    await promoteNext(10, 5, tx as any);

    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("makes no writes when capacity is already full", async () => {
    const tx = makeTx({
      executeResults: [{ rows: new Array(5) }],  // 5 active = full
    });

    await promoteNext(10, 5, tx as any);

    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    // Should NOT even query the queue
    expect(tx.execute).toHaveBeenCalledTimes(1);
  });

  it("makes no writes when activeCount equals capacity exactly", async () => {
    const tx = makeTx({
      executeResults: [{ rows: new Array(3) }],  // 3 active, cap = 3
    });

    await promoteNext(10, 3, tx as any);

    expect(tx.update).not.toHaveBeenCalled();
  });

  // ── CASE 3: Stale entry skipped ──────────────────────────────────────────

  it("prunes queue entry when application status is INACTIVE (not WAITLIST)", async () => {
    const staleApp = makeApp({ id: 7, status: "INACTIVE" });

    const tx = makeTx({
      executeResults: [
        { rows: [{}] },                                      // 1 active
        { rows: [{ application_id: 7, position: 1 }] },     // queue entry exists
      ],
      selectResults: [[staleApp]],
    });

    await promoteNext(10, 5, tx as any);

    // Stale entry cleaned up
    expect(tx.delete).toHaveBeenCalled();
    // No promotion performed
    expect(tx.update).not.toHaveBeenCalled();
    // No audit log written
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("prunes queue entry when application status is ACTIVE (already promoted)", async () => {
    const alreadyActive = makeApp({ id: 8, status: "ACTIVE" });

    const tx = makeTx({
      executeResults: [
        { rows: [{}] },
        { rows: [{ application_id: 8, position: 2 }] },
      ],
      selectResults: [[alreadyActive]],
    });

    await promoteNext(10, 5, tx as any);

    expect(tx.delete).toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("prunes queue entry when application row is missing entirely", async () => {
    const tx = makeTx({
      executeResults: [
        { rows: [{}] },
        { rows: [{ application_id: 99, position: 1 }] },
      ],
      selectResults: [[]],  // empty → destructured as undefined
    });

    await promoteNext(10, 5, tx as any);

    expect(tx.delete).toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  // ── CASE 4: Edge — capacity = 1 with exactly 0 active ───────────────────

  it("promotes when capacity is 1 and there are 0 active", async () => {
    const candidate = makeApp({ id: 1, status: "WAITLIST" });
    let captured: any = null;

    const tx = makeTx({
      executeResults: [
        { rows: [] },                                     // 0 active
        { rows: [{ application_id: 1, position: 1 }] },  // one candidate
        { rows: [] },                                     // reindex
      ],
      selectResults: [[candidate]],
      captureUpdate: (val) => { captured = val; },
    });

    await promoteNext(10, 1, tx as any);

    expect(captured).not.toBeNull();
    expect(captured.status).toBe("PENDING_ACKNOWLEDGMENT");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  checkAndDecayExpiredAcknowledgments()  —  EXPIRY HANDLING
// ═══════════════════════════════════════════════════════════════════════════════

describe("checkAndDecayExpiredAcknowledgments() — expiry handling", () => {
  beforeEach(() => vi.clearAllMocks());

  // ── CASE 1: Single expired application ───────────────────────────────────

  it("decays an expired PENDING_ACKNOWLEDGMENT app and returns count 1", async () => {
    const expired = makeApp({
      id: 1,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 60_000),
      penaltyCount: 0,
    });

    const tx = makeTx({
      selectResults: [
        [expired],          // find expired
        [expired],          // applyPenaltyAndRequeue → fetch app
        [{ maxPos: 3 }],   // applyPenaltyAndRequeue → MAX(position)
      ],
      executeResults: [
        { rows: [1, 2] },  // promoteUntilFull → getActiveCount
        { rows: [] },      // promoteUntilFull → getNextCandidates (none)
      ],
    });

    const decayed = await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    expect(decayed).toBe(1);
    // update called → status changed to WAITLIST
    expect(tx.update).toHaveBeenCalled();
    // insert called → queue position + audit log
    expect(tx.insert).toHaveBeenCalled();
    // delete called → stale queue cleanup
    expect(tx.delete).toHaveBeenCalled();
  });

  it("sets status to WAITLIST and increments penaltyCount on decay", async () => {
    const expired = makeApp({
      id: 1,
      status: "PENDING_ACKNOWLEDGMENT",
      penaltyCount: 2,
      acknowledgeDeadline: new Date(Date.now() - 10_000),
    });
    let statusUpdate: any = null;

    const tx = makeTx({
      selectResults: [
        [expired],
        [expired],
        [{ maxPos: 5 }],
      ],
      executeResults: [
        { rows: [1] },
        { rows: [] },
      ],
      captureUpdate: (val) => { statusUpdate = val; },
    });

    await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    expect(statusUpdate).not.toBeNull();
    expect(statusUpdate.status).toBe("WAITLIST");
    expect(statusUpdate.penaltyCount).toBe(3);
    expect(statusUpdate.acknowledgeDeadline).toBeNull();
    expect(statusUpdate.promotedAt).toBeNull();
  });

  // ── CASE 2: Not expired — no action ──────────────────────────────────────

  it("returns 0 and makes no writes when no apps are expired", async () => {
    const tx = makeTx({
      selectResults: [[]],  // no expired apps found
    });

    const decayed = await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    expect(decayed).toBe(0);
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
    // Should NOT call promoteUntilFull (no execute calls)
    expect(tx.execute).not.toHaveBeenCalled();
  });

  // ── CASE 3: Multiple expired ─────────────────────────────────────────────

  it("decays all expired apps and returns correct count", async () => {
    const expired1 = makeApp({
      id: 1,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 60_000),
    });
    const expired2 = makeApp({
      id: 2,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 30_000),
      penaltyCount: 1,
    });
    const expired3 = makeApp({
      id: 3,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 5_000),
      penaltyCount: 3,
    });

    const tx = makeTx({
      selectResults: [
        [expired1, expired2, expired3],   // find all expired
        [expired1], [{ maxPos: 0 }],      // requeue app 1
        [expired2], [{ maxPos: 1 }],      // requeue app 2
        [expired3], [{ maxPos: 2 }],      // requeue app 3
      ],
      executeResults: [
        { rows: [1] },  // promoteUntilFull → getActiveCount
        { rows: [] },   // promoteUntilFull → no candidates
      ],
    });

    const decayed = await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    expect(decayed).toBe(3);
  });

  it("calls applyPenaltyAndRequeue once per expired app", async () => {
    const expired1 = makeApp({ id: 10, status: "PENDING_ACKNOWLEDGMENT", acknowledgeDeadline: new Date(Date.now() - 1000) });
    const expired2 = makeApp({ id: 20, status: "PENDING_ACKNOWLEDGMENT", acknowledgeDeadline: new Date(Date.now() - 2000) });

    const ops: string[] = [];
    const tx = makeTx({
      selectResults: [
        [expired1, expired2],
        [expired1], [{ maxPos: 0 }],
        [expired2], [{ maxPos: 1 }],
      ],
      executeResults: [
        { rows: [] },
        { rows: [] },
      ],
      trackOps: ops,
    });

    await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    // Each requeue does: delete + insert(queue) + update + insert(audit) = 4 ops
    // 2 expired × 4 = 8 ops
    const deleteCount = ops.filter((o) => o === "delete").length;
    const insertCount = ops.filter((o) => o === "insert").length;
    const updateCount = ops.filter((o) => o === "update").length;

    expect(deleteCount).toBe(2);  // one cleanup per expired
    expect(updateCount).toBe(2);  // one status update per expired
    expect(insertCount).toBe(4);  // queue pos + audit log per expired
  });

  // ── CASE 4: Triggers promoteUntilFull after decay ────────────────────────

  it("calls promoteUntilFull after decaying (tx.execute invoked)", async () => {
    const expired = makeApp({
      id: 1,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 10_000),
    });

    const tx = makeTx({
      selectResults: [
        [expired],
        [expired],
        [{ maxPos: 0 }],
      ],
      executeResults: [
        { rows: [1, 2] },  // promoteUntilFull → getActiveCount: 2
        { rows: [] },      // promoteUntilFull → no candidates
      ],
    });

    await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    // promoteUntilFull calls tx.execute for getActiveCount + getNextCandidates
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it("does NOT call promoteUntilFull when nothing was decayed", async () => {
    const tx = makeTx({ selectResults: [[]] });

    await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    expect(tx.execute).not.toHaveBeenCalled();
  });

  // ── EDGE CASES ───────────────────────────────────────────────────────────

  it("handles empty queue gracefully (no candidates to promote after decay)", async () => {
    const expired = makeApp({
      id: 1,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 10_000),
    });

    const tx = makeTx({
      selectResults: [
        [expired],
        [expired],
        [{ maxPos: 0 }],
      ],
      executeResults: [
        { rows: [] },  // promoteUntilFull → 0 active
        { rows: [] },  // promoteUntilFull → 0 candidates
      ],
    });

    const decayed = await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    expect(decayed).toBe(1);
    // promoteUntilFull ran but found nothing
    expect(tx.execute).toHaveBeenCalledTimes(2);
  });

  it("correctly places decayed app at end of queue (MAX + 1)", async () => {
    const expired = makeApp({
      id: 1,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 10_000),
    });
    const inserts: any[] = [];

    const tx = makeTx({
      selectResults: [
        [expired],
        [expired],
        [{ maxPos: 7 }],  // current max position is 7
      ],
      executeResults: [
        { rows: [] },
        { rows: [] },
      ],
      captureInsert: (val) => inserts.push(val),
    });

    await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    // First insert is the queue position
    const queueInsert = inserts.find((i) => i.position !== undefined);
    expect(queueInsert).toBeDefined();
    expect(queueInsert.position).toBe(8); // MAX(7) + 1
  });

  it("writes DECAY_TRIGGERED audit log for each expired app", async () => {
    const expired = makeApp({
      id: 5,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 10_000),
    });
    const inserts: any[] = [];

    const tx = makeTx({
      selectResults: [
        [expired],
        [expired],
        [{ maxPos: 0 }],
      ],
      executeResults: [
        { rows: [] },
        { rows: [] },
      ],
      captureInsert: (val) => inserts.push(val),
    });

    await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    const auditLog = inserts.find((i) => i.eventType === "DECAY_TRIGGERED");
    expect(auditLog).toBeDefined();
    expect(auditLog.applicationId).toBe(5);
    expect(auditLog.fromStatus).toBe("PENDING_ACKNOWLEDGMENT");
    expect(auditLog.toStatus).toBe("WAITLIST");
  });

  // ── SIDE EFFECTS: operation ordering ─────────────────────────────────────

  it("decay performs operations in order: delete → insert(queue) → update → insert(audit)", async () => {
    const expired = makeApp({
      id: 1,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 10_000),
    });
    const ops: string[] = [];

    const tx = makeTx({
      selectResults: [
        [expired],
        [expired],
        [{ maxPos: 0 }],
      ],
      executeResults: [
        { rows: [1] },
        { rows: [] },
      ],
      trackOps: ops,
    });

    await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    // applyPenaltyAndRequeue ordering
    expect(ops[0]).toBe("delete");   // defensive queue cleanup
    expect(ops[1]).toBe("insert");   // new queue position at end
    expect(ops[2]).toBe("update");   // status → WAITLIST
    expect(ops[3]).toBe("insert");   // audit log
  });
});
