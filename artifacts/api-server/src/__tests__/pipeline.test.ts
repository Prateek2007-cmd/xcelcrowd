import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  promoteNext,
  promoteUntilFull,
  applyPenaltyAndRequeue,
  checkAndDecayExpiredAcknowledgments,
  getActiveCount,
  getNextInQueue,
  runDecayForJob,
} from "../services/pipeline";
import { db } from "@workspace/db";

// ── Mock database layer ──────────────────────────────────────────────────────
vi.mock("@workspace/db", () => {
  const mockTx = {
    select: vi.fn(),
    insert: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  };

  return {
    db: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
      transaction: vi.fn((callback: any) => callback(mockTx)),
    },
    applicationsTable: {},
    queuePositionsTable: {},
    auditLogsTable: {},
  };
});

vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

// ── Test data factories ──────────────────────────────────────────────────────
function makeApp(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    applicantId: 100,
    jobId: 10,
    status: "WAITLIST",
    createdAt: new Date(),
    promotedAt: null,
    acknowledgeDeadline: null,
    penaltyCount: 0,
    ...overrides,
  };
}

/** Build a mock tx with chainable Drizzle methods */
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

  const tx: Record<string, any> = {
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
  return tx;
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. getActiveCount
// ═══════════════════════════════════════════════════════════════════════════════
describe("getActiveCount()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns row count of ACTIVE + PENDING_ACKNOWLEDGMENT rows", async () => {
    const tx = makeTx({ executeResults: [{ rows: [{}, {}, {}] }] });
    expect(await getActiveCount(10, tx as any)).toBe(3);
  });

  it("returns 0 when no active applications exist", async () => {
    const tx = makeTx({ executeResults: [{ rows: [] }] });
    expect(await getActiveCount(10, tx as any)).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. promoteNext
// ═══════════════════════════════════════════════════════════════════════════════
describe("promoteNext()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("promotes WAITLIST → PENDING_ACKNOWLEDGMENT and writes audit log", async () => {
    const candidate = makeApp({ id: 5, status: "WAITLIST" });
    let captured: any = null;

    const tx = makeTx({
      // exec 1: getActiveCount → 0 active
      // exec 2: getNextInQueue → one candidate
      // exec 3: reindexQueue CTE
      executeResults: [
        { rows: [] },
        { rows: [{ application_id: 5, position: 1 }] },
        { rows: [] },
      ],
      selectResults: [[candidate]],
      captureUpdate: (val) => { captured = val; },
    });

    await promoteNext(10, 5, tx as any);

    // Status changed
    expect(captured).not.toBeNull();
    expect(captured.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(captured.acknowledgeDeadline).toBeInstanceOf(Date);
    expect(captured.promotedAt).toBeInstanceOf(Date);

    // Queue entry deleted
    expect(tx.delete).toHaveBeenCalled();

    // Audit log inserted
    expect(tx.insert).toHaveBeenCalled();
  });

  it("returns immediately when capacity is full (no writes)", async () => {
    const tx = makeTx({
      executeResults: [{ rows: new Array(5) }], // 5 active = full
    });

    await promoteNext(10, 5, tx as any);

    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("returns immediately when no candidate in queue", async () => {
    const tx = makeTx({
      executeResults: [
        { rows: [{}] },   // 1 active (below cap)
        { rows: [] },     // no candidates
      ],
    });

    await promoteNext(10, 5, tx as any);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("prunes stale queue entry when app status is not WAITLIST", async () => {
    const staleApp = makeApp({ id: 7, status: "INACTIVE" });

    const tx = makeTx({
      executeResults: [
        { rows: [{}] },
        { rows: [{ application_id: 7, position: 1 }] },
      ],
      selectResults: [[staleApp]],
    });

    await promoteNext(10, 5, tx as any);

    // Stale entry deleted
    expect(tx.delete).toHaveBeenCalled();
    // No promotion update
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("prunes stale queue entry when app row is missing", async () => {
    const tx = makeTx({
      executeResults: [
        { rows: [{}] },
        { rows: [{ application_id: 99, position: 1 }] },
      ],
      selectResults: [[]], // app not found → undefined
    });

    await promoteNext(10, 5, tx as any);
    expect(tx.delete).toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. applyPenaltyAndRequeue
// ═══════════════════════════════════════════════════════════════════════════════
describe("applyPenaltyAndRequeue()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("moves app to WAITLIST, inserts queue position, writes audit log", async () => {
    const app = makeApp({ id: 3, status: "PENDING_ACKNOWLEDGMENT", penaltyCount: 0 });
    const ops: string[] = [];
    let statusUpdate: any = null;

    const tx = makeTx({
      selectResults: [
        [app],               // fetch application
        [{ maxPos: 4 }],     // MAX(position)
      ],
      trackOps: ops,
      captureUpdate: (val) => { statusUpdate = val; },
    });

    await applyPenaltyAndRequeue(3, 10, tx as any);

    // delete → old queue entry cleanup
    expect(ops).toContain("delete");
    // insert called twice: queue position + audit log
    expect(ops.filter((o) => o === "insert").length).toBe(2);
    // update → status back to WAITLIST
    expect(statusUpdate).not.toBeNull();
    expect(statusUpdate.status).toBe("WAITLIST");
    expect(statusUpdate.penaltyCount).toBe(1);
    expect(statusUpdate.acknowledgeDeadline).toBeNull();
    expect(statusUpdate.promotedAt).toBeNull();
  });

  it("places requeued applicant at END of queue (MAX + 1)", async () => {
    const app = makeApp({ penaltyCount: 2 });
    let queueInsert: any = null;

    const tx = makeTx({
      selectResults: [
        [app],
        [{ maxPos: 7 }],
      ],
      captureInsert: (val) => {
        // First insert is the queue position
        if (!queueInsert && (val as any)?.position !== undefined) {
          queueInsert = val;
        }
      },
    });

    await applyPenaltyAndRequeue(1, 10, tx as any);

    expect(queueInsert).not.toBeNull();
    expect(queueInsert.position).toBe(8); // 7 + 1
  });

  it("increments penaltyCount correctly", async () => {
    const app = makeApp({ penaltyCount: 3 });
    let captured: any = null;

    const tx = makeTx({
      selectResults: [[app], [{ maxPos: 1 }]],
      captureUpdate: (val) => { captured = val; },
    });

    await applyPenaltyAndRequeue(1, 10, tx as any);
    expect(captured.penaltyCount).toBe(4);
  });

  it("returns early without writes when application not found", async () => {
    const tx = makeTx({ selectResults: [[]] });

    await applyPenaltyAndRequeue(999, 10, tx as any);

    expect(tx.delete).not.toHaveBeenCalled();
    expect(tx.update).not.toHaveBeenCalled();
    expect(tx.insert).not.toHaveBeenCalled();
  });

  it("writes DECAY_TRIGGERED audit log entry", async () => {
    const app = makeApp({ penaltyCount: 0 });
    let auditPayload: any = null;
    let insertCount = 0;

    const tx = makeTx({
      selectResults: [[app], [{ maxPos: 0 }]],
      captureInsert: (val) => {
        insertCount++;
        // Second insert is the audit log
        if (insertCount === 2) auditPayload = val;
      },
    });

    await applyPenaltyAndRequeue(1, 10, tx as any);

    expect(auditPayload).not.toBeNull();
    expect(auditPayload.eventType).toBe("DECAY_TRIGGERED");
    expect(auditPayload.fromStatus).toBe("PENDING_ACKNOWLEDGMENT");
    expect(auditPayload.toStatus).toBe("WAITLIST");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. promoteUntilFull
// ═══════════════════════════════════════════════════════════════════════════════
describe("promoteUntilFull()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns 0 immediately when capacity is already full", async () => {
    const tx = makeTx({
      executeResults: [{ rows: new Array(5) }], // 5 active = full
    });

    const promoted = await promoteUntilFull(10, 5, tx as any);

    expect(promoted).toBe(0);
    expect(tx.update).not.toHaveBeenCalled();
  });

  it("returns 0 when queue has no candidates", async () => {
    const tx = makeTx({
      executeResults: [
        { rows: [{}] },  // 1 active, 4 slots open
        { rows: [] },    // no candidates
      ],
    });

    const promoted = await promoteUntilFull(10, 5, tx as any);
    expect(promoted).toBe(0);
  });

  it("promotes candidates up to available slots", async () => {
    // 3 active → 2 slots available → fetch 2 candidates
    let execIdx = 0;
    const tx = makeTx({
      selectResults: [
        [makeApp({ status: "WAITLIST" })],
        [makeApp({ status: "WAITLIST" })],
      ],
    });
    // Override execute for the complex multi-call scenario
    tx.execute = vi.fn().mockImplementation(() => {
      execIdx++;
      if (execIdx === 1) return Promise.resolve({ rows: [1, 2, 3] });        // getActiveCount: 3
      if (execIdx === 2) return Promise.resolve({                             // getNextCandidates: 2
        rows: [
          { application_id: 1, position: 1 },
          { application_id: 2, position: 2 },
        ],
      });
      return Promise.resolve({ rows: [1, 2, 3] }); // subsequent getActiveCount calls
    });

    const promoted = await promoteUntilFull(10, 5, tx as any);

    expect(promoted).toBe(2);
    expect(tx.update).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. checkAndDecayExpiredAcknowledgments
// ═══════════════════════════════════════════════════════════════════════════════
describe("checkAndDecayExpiredAcknowledgments()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("decays expired apps and returns count", async () => {
    const expired1 = makeApp({
      id: 1,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 60_000),
    });
    const expired2 = makeApp({
      id: 2,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 30_000),
    });

    const tx = makeTx({
      selectResults: [
        [expired1, expired2],  // find expired
        [expired1],            // fetch app 1 for requeue
        [{ maxPos: 3 }],      // max pos for app 1
        [expired2],            // fetch app 2 for requeue
        [{ maxPos: 4 }],      // max pos for app 2
      ],
      executeResults: [
        { rows: [1, 2] },     // promoteUntilFull → getActiveCount
        { rows: [] },         // promoteUntilFull → getNextCandidates (none)
      ],
    });

    const decayed = await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    expect(decayed).toBe(2);
    expect(tx.update).toHaveBeenCalled();
    expect(tx.insert).toHaveBeenCalled();
  });

  it("returns 0 and skips promotion when nothing is expired", async () => {
    const tx = makeTx({ selectResults: [[]] });

    const decayed = await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    expect(decayed).toBe(0);
    expect(tx.execute).not.toHaveBeenCalled(); // no promoteUntilFull
  });

  it("calls promoteUntilFull after decay to fill vacated slots", async () => {
    const expired = makeApp({
      id: 1,
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 1000),
    });

    const tx = makeTx({
      selectResults: [
        [expired],           // find expired
        [expired],           // fetch for requeue
        [{ maxPos: 0 }],    // max pos
      ],
      executeResults: [
        { rows: [1, 2] },   // promoteUntilFull → getActiveCount
        { rows: [] },       // no candidates to promote
      ],
    });

    await checkAndDecayExpiredAcknowledgments(10, 5, tx as any);

    // promoteUntilFull calls tx.execute for getActiveCount
    expect(tx.execute).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. runDecayForJob – transaction wrapper
// ═══════════════════════════════════════════════════════════════════════════════
describe("runDecayForJob()", () => {
  beforeEach(() => vi.clearAllMocks());

  it("wraps decay in a database transaction", async () => {
    vi.mocked(db.transaction).mockResolvedValue({ decayed: 0 } as any);

    await runDecayForJob(10, 5);

    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("returns success: true with decayed count on success", async () => {
    vi.mocked(db.transaction).mockImplementation(async (fn: any) => {
      return fn({
        select: vi.fn().mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([]),
          }),
        }),
      });
    });

    const result = await runDecayForJob(10, 5);

    expect(result.success).toBe(true);
    expect(result).toHaveProperty("decayed");
    expect(result).toHaveProperty("promoted");
  });

  it("returns { success: false, decayed: 0, promoted: 0 } on transaction error", async () => {
    vi.mocked(db.transaction).mockRejectedValue(new Error("connection lost"));

    const result = await runDecayForJob(10, 5);

    expect(result).toEqual({ success: false, decayed: 0, promoted: 0 });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. Side-effects verification
// ═══════════════════════════════════════════════════════════════════════════════
describe("Side Effects – operation ordering", () => {
  beforeEach(() => vi.clearAllMocks());

  it("promoteNext: update → delete → reindex → insert(audit) sequence", async () => {
    const candidate = makeApp({ status: "WAITLIST" });
    const ops: string[] = [];

    const tx = makeTx({
      executeResults: [
        { rows: [] },
        { rows: [{ application_id: 1, position: 1 }] },
        { rows: [] },
      ],
      selectResults: [[candidate]],
      trackOps: ops,
    });

    await promoteNext(10, 5, tx as any);

    expect(ops).toContain("update");
    expect(ops).toContain("delete");
    expect(ops).toContain("insert");
    // update happens before the audit insert
    expect(ops.indexOf("update")).toBeLessThan(ops.lastIndexOf("insert"));
  });

  it("applyPenaltyAndRequeue: delete → insert(queue) → update → insert(audit)", async () => {
    const app = makeApp({ penaltyCount: 0 });
    const ops: string[] = [];

    const tx = makeTx({
      selectResults: [[app], [{ maxPos: 5 }]],
      trackOps: ops,
    });

    await applyPenaltyAndRequeue(1, 10, tx as any);

    expect(ops[0]).toBe("delete");   // defensive cleanup
    expect(ops[1]).toBe("insert");   // queue position
    expect(ops[2]).toBe("update");   // status → WAITLIST
    expect(ops[3]).toBe("insert");   // audit log
  });
});
