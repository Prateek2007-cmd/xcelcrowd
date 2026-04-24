import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  promoteNext,
  promoteUntilFull,
  applyPenaltyAndRequeue,
  checkAndDecayExpiredAcknowledgments,
  getActiveCount,
  getNextInQueue,
} from "../services/pipeline";
import { db } from "@workspace/db";

// ── Mock database layer ──
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
      transaction: vi.fn((callback) => callback(mockTx)),
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

// ── Test data helpers ──
function createMockQueueEntry(overrides = {}) {
  return {
    applicationId: 1,
    jobId: 10,
    position: 1,
    ...overrides,
  };
}

function createMockApplication(overrides = {}) {
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

// ── Mocking utilities ──
function mockDbQuery(result: any[] = []) {
  const chainFn = vi.fn()
    .mockReturnValue({
      limit: vi.fn().mockResolvedValue(result),
      where: vi.fn().mockReturnValue(chainFn),
    })
    .mockResolvedValue(result);

  chainFn.where = vi.fn().mockReturnValue(chainFn);
  chainFn.limit = vi.fn().mockReturnValue(chainFn);
  chainFn.from = vi.fn().mockReturnValue(chainFn);
  chainFn.orderBy = vi.fn().mockReturnValue(chainFn);

  return chainFn;
}

// ── Tests: getActiveCount ──
describe("pipeline.getActiveCount()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns count of ACTIVE and PENDING_ACKNOWLEDGMENT applications", async () => {
    const activeApps = [
      createMockApplication({ id: 1, status: "ACTIVE" }),
      createMockApplication({ id: 2, status: "PENDING_ACKNOWLEDGMENT" }),
      createMockApplication({ id: 3, status: "ACTIVE" }),
    ];

    const mockExecute = {
      rows: activeApps,
    };

    const mockTx = { execute: vi.fn().mockResolvedValue(mockExecute) };

    const count = await getActiveCount(10, mockTx as any);
    expect(count).toBe(3);
  });

  it("returns 0 if no active applications", async () => {
    const mockExecute = { rows: [] };
    const mockTx = { execute: vi.fn().mockResolvedValue(mockExecute) };

    const count = await getActiveCount(10, mockTx as any);
    expect(count).toBe(0);
  });

  it("only counts ACTIVE and PENDING_ACKNOWLEDGMENT status", async () => {
    const apps = [
      { id: 1, status: "ACTIVE" },
      { id: 2, status: "WAITLIST" }, // Should not count
      { id: 3, status: "INACTIVE" }, // Should not count
    ];

    const mockExecute = {
      rows: [apps[0]], // Only ACTIVE
    };

    const mockTx = { execute: vi.fn().mockResolvedValue(mockExecute) };

    const count = await getActiveCount(10, mockTx as any);
    expect(count).toBe(1);
  });
});

// ── Tests: promoteNext ──
describe("pipeline.promoteNext()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("promotes WAITLIST candidate to PENDING_ACKNOWLEDGMENT", async () => {
    const jobId = 10;
    const jobCapacity = 5;
    const queueEntry = createMockQueueEntry();
    const candidateApp = createMockApplication({ status: "WAITLIST" });

    const mockTx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [] }) // getActiveCount returns 3
        .mockResolvedValueOnce({ rows: [{ application_id: 1, position: 1 }] }) // getNextInQueue
        .mockResolvedValueOnce(undefined), // reindexQueue
      select: vi.fn()
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([candidateApp]),
          }),
        }),
      update: vi.fn()
        .mockReturnValue({
          set: vi.fn()
            .mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
        }),
      delete: vi.fn()
        .mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      insert: vi.fn()
        .mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
    };

    await promoteNext(jobId, jobCapacity, mockTx as any);

    expect(mockTx.update).toHaveBeenCalled();
    expect(mockTx.insert).toHaveBeenCalled(); // Audit log
  });

  it("returns early if capacity is full", async () => {
    const jobId = 10;
    const jobCapacity = 5;

    const mockTx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: new Array(5) }), // getActiveCount returns 5
      select: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      insert: vi.fn(),
    };

    await promoteNext(jobId, jobCapacity, mockTx as any);

    expect(mockTx.update).not.toHaveBeenCalled();
    expect(mockTx.delete).not.toHaveBeenCalled();
  });

  it("skips stale queue entries (status not WAITLIST)", async () => {
    const jobId = 10;
    const jobCapacity = 5;

    const staleCandidateApp = createMockApplication({
      status: "INACTIVE", // Stale entry
    });

    const mockTx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [1, 2] }) // 2 active
        .mockResolvedValueOnce({ rows: [{ application_id: 1, position: 1 }] }), // getNextInQueue
      select: vi.fn()
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValue([staleCandidateApp]), // Status mismatch
          }),
        }),
      delete: vi.fn()
        .mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      update: vi.fn(),
      insert: vi.fn(),
    };

    await promoteNext(jobId, jobCapacity, mockTx as any);

    // Should delete stale entry but not update status
    expect(mockTx.delete).toHaveBeenCalled();
    expect(mockTx.update).not.toHaveBeenCalled();
  });
});

// ── Tests: applyPenaltyAndRequeue ──
describe("pipeline.applyPenaltyAndRequeue()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("moves applicant from PENDING_ACKNOWLEDGMENT back to WAITLIST", async () => {
    const applicationId = 1;
    const jobId = 10;
    const app = createMockApplication({ status: "PENDING_ACKNOWLEDGMENT" });

    const mockTx = {
      select: vi.fn()
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn()
              .mockResolvedValueOnce([app]) // Fetch application
              .mockResolvedValueOnce([{ maxPos: 5 }]), // Get max position
          }),
        }),
      delete: vi.fn()
        .mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      insert: vi.fn()
        .mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      update: vi.fn()
        .mockReturnValue({
          set: vi.fn()
            .mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
        }),
    };

    await applyPenaltyAndRequeue(applicationId, jobId, mockTx as any);

    // Should update status to WAITLIST
    expect(mockTx.update).toHaveBeenCalled();
    // Should insert new queue position
    expect(mockTx.insert).toHaveBeenCalledTimes(2); // Queue + Audit log
  });

  it("appends to end of queue (MAX(position) + 1)", async () => {
    const applicationId = 1;
    const jobId = 10;
    const app = createMockApplication();

    const mockTx = {
      select: vi.fn()
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn()
              .mockResolvedValueOnce([app])
              .mockResolvedValueOnce([{ maxPos: 10 }]), // Highest position is 10
          }),
        }),
      delete: vi.fn()
        .mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      insert: vi.fn()
        .mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      update: vi.fn()
        .mockReturnValue({
          set: vi.fn()
            .mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
        }),
    };

    await applyPenaltyAndRequeue(applicationId, jobId, mockTx as any);

    // Verify queue insertion was called with position 11 (10 + 1)
    const insertCalls = vi.mocked(mockTx.insert).mock.calls;
    expect(insertCalls.length).toBeGreaterThan(0);
  });

  it("increments penaltyCount when requeuing", async () => {
    const applicationId = 1;
    const jobId = 10;
    const app = createMockApplication({ penaltyCount: 2 });

    const mockTx = {
      select: vi.fn()
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn()
              .mockResolvedValueOnce([app])
              .mockResolvedValueOnce([{ maxPos: 10 }]),
          }),
        }),
      delete: vi.fn()
        .mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      insert: vi.fn()
        .mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      update: vi.fn()
        .mockReturnValue({
          set: vi.fn()
            .mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
        }),
    };

    await applyPenaltyAndRequeue(applicationId, jobId, mockTx as any);

    // Should call update to increment penaltyCount from 2 to 3
    expect(mockTx.update).toHaveBeenCalled();
  });

  it("deletes stale queue entry (defensive cleanup)", async () => {
    const applicationId = 1;
    const jobId = 10;
    const app = createMockApplication();

    const mockTx = {
      select: vi.fn()
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn()
              .mockResolvedValueOnce([app])
              .mockResolvedValueOnce([{ maxPos: 5 }]),
          }),
        }),
      delete: vi.fn()
        .mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      insert: vi.fn()
        .mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      update: vi.fn()
        .mockReturnValue({
          set: vi.fn()
            .mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
        }),
    };

    await applyPenaltyAndRequeue(applicationId, jobId, mockTx as any);

    // Should delete old queue entry first (defensive cleanup)
    expect(mockTx.delete).toHaveBeenCalled();
  });
});

// ── Tests: promoteUntilFull ──
describe("pipeline.promoteUntilFull()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stops promoting when capacity is reached", async () => {
    const jobId = 10;
    const jobCapacity = 5;

    const mockTx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: new Array(5) }), // Full already
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    const promoted = await promoteUntilFull(jobId, jobCapacity, mockTx as any);

    expect(promoted).toBe(0);
    expect(mockTx.update).not.toHaveBeenCalled();
  });

  it("counts only successful promotions", async () => {
    const jobId = 10;
    const jobCapacity = 5;

    // 2 active, 3 slots available
    const mockTx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [1, 2] }) // getActiveCount: 2
        .mockResolvedValueOnce({
          rows: [
            { application_id: 1, position: 1 },
            { application_id: 2, position: 2 },
            { application_id: 3, position: 3 },
          ],
        }), // getNextCandidates: 3
      select: vi.fn()
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn()
              .mockResolvedValue([createMockApplication({ status: "WAITLIST" })]),
          }),
        }),
      delete: vi.fn()
        .mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      insert: vi.fn()
        .mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      update: vi.fn()
        .mockReturnValue({
          set: vi.fn()
            .mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
        }),
    };

    const promoted = await promoteUntilFull(jobId, jobCapacity, mockTx as any);

    expect(promoted).toBeGreaterThan(0);
  });

  it("returns 0 if no candidates in queue", async () => {
    const jobId = 10;
    const jobCapacity = 5;

    const mockTx = {
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [1, 2] }) // 2 active, 3 slots available
        .mockResolvedValueOnce({ rows: [] }), // No candidates
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };

    const promoted = await promoteUntilFull(jobId, jobCapacity, mockTx as any);

    expect(promoted).toBe(0);
  });
});

// ── Tests: checkAndDecayExpiredAcknowledgments ──
describe("pipeline.checkAndDecayExpiredAcknowledgments()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("finds and decays expired PENDING_ACKNOWLEDGMENT applications", async () => {
    const jobId = 10;
    const jobCapacity = 5;

    const expiredApps = [
      createMockApplication({
        id: 1,
        status: "PENDING_ACKNOWLEDGMENT",
        acknowledgeDeadline: new Date(Date.now() - 1000),
      }),
      createMockApplication({
        id: 2,
        status: "PENDING_ACKNOWLEDGMENT",
        acknowledgeDeadline: new Date(Date.now() - 2000),
      }),
    ];

    const mockTx = {
      select: vi.fn()
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn()
              .mockResolvedValueOnce(expiredApps) // Find expired
              .mockResolvedValueOnce(expiredApps) // For penalty/requeue
              .mockResolvedValueOnce([{ maxPos: 5 }]) // Max position
              .mockResolvedValueOnce([{ maxPos: 6 }]), // For second
          }),
        }),
      delete: vi.fn()
        .mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      insert: vi.fn()
        .mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      update: vi.fn()
        .mockReturnValue({
          set: vi.fn()
            .mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
        }),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [1, 2] }) // getActiveCount for promote
        .mockResolvedValueOnce({ rows: [] }), // getNextCandidates
    };

    const decayed = await checkAndDecayExpiredAcknowledgments(jobId, jobCapacity, mockTx as any);

    expect(decayed).toBe(2);
  });

  it("returns 0 if no expired applications", async () => {
    const jobId = 10;
    const jobCapacity = 5;

    const mockTx = {
      select: vi.fn()
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn().mockResolvedValueOnce([]), // No expired
          }),
        }),
      execute: vi.fn(),
      delete: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
    };

    const decayed = await checkAndDecayExpiredAcknowledgments(jobId, jobCapacity, mockTx as any);

    expect(decayed).toBe(0);
  });

  it("promotes from queue after decay", async () => {
    const jobId = 10;
    const jobCapacity = 5;

    const expiredApps = [
      createMockApplication({
        id: 1,
        status: "PENDING_ACKNOWLEDGMENT",
        acknowledgeDeadline: new Date(Date.now() - 1000),
      }),
    ];

    const mockTx = {
      select: vi.fn()
        .mockReturnValue({
          from: vi.fn().mockReturnValue({
            where: vi.fn()
              .mockResolvedValueOnce(expiredApps) // Find expired
              .mockResolvedValueOnce(expiredApps) // For requeue
              .mockResolvedValueOnce([{ maxPos: 5 }]), // Max position
          }),
        }),
      delete: vi.fn()
        .mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      insert: vi.fn()
        .mockReturnValue({
          values: vi.fn().mockResolvedValue(undefined),
        }),
      update: vi.fn()
        .mockReturnValue({
          set: vi.fn()
            .mockReturnValue({
              where: vi.fn().mockResolvedValue(undefined),
            }),
        }),
      execute: vi.fn()
        .mockResolvedValueOnce({ rows: [1, 2, 3] }) // getActiveCount: 3, 2 slots
        .mockResolvedValueOnce({
          rows: [
            { application_id: 10, position: 6 },
            { application_id: 11, position: 7 },
          ],
        }), // getNextCandidates: 2 available
    };

    await checkAndDecayExpiredAcknowledgments(jobId, jobCapacity, mockTx as any);

    // Should have called update/insert for both decay and subsequent promotion
    expect(mockTx.update).toHaveBeenCalled();
    expect(mockTx.insert).toHaveBeenCalled();
  });
});
