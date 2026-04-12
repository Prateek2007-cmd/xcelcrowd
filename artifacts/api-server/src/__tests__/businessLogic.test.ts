/**
 * Business logic tests — directly call the core service/pipeline functions.
 *
 * Uses vi.hoisted() + vi.mock() to safely mock database access.
 * Mocks match Drizzle ORM's two query patterns:
 *   Pattern A:  db.select().from(table).where(cond)  →  Row[]
 *   Pattern B:  db.select({...}).from(sql`...`)       →  Row[]  (no .where())
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoisted mocks — safe to reference inside vi.mock() factories ──
const mocks = vi.hoisted(() => ({
  mockSelect: vi.fn(),
  mockInsert: vi.fn(),
  mockUpdate: vi.fn(),
  mockDelete: vi.fn(),
  mockTransaction: vi.fn(),
  mockExecute: vi.fn(),
}));

/**
 * Create a select chain where .from() returns an object that:
 *   1. Is a Promise (resolves to rows when awaited directly — Pattern B)
 *   2. Has .where() → Promise<rows>  (for Pattern A)
 *
 * This handles BOTH: `await tx.select().from(sql)` and `await tx.select().from(table).where(eq(...))`
 */
function selectChain(rows: unknown[] = []) {
  // Object.assign merges { where } onto a real Promise
  // So `await fromResult` → rows,  AND  `fromResult.where(...)` → rows
  const fromResult = Object.assign(
    Promise.resolve(rows),
    {
      where: vi.fn().mockResolvedValue(rows),
      orderBy: vi.fn().mockReturnValue(
        Object.assign(Promise.resolve(rows), {
          limit: vi.fn().mockResolvedValue(rows),
        })
      ),
    }
  );
  return {
    from: vi.fn().mockReturnValue(fromResult),
  };
}

function mutationChain() {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.set = vi.fn().mockReturnValue(chain);
  chain.values = vi.fn().mockReturnValue(chain);
  chain.where = vi.fn().mockResolvedValue([]);
  chain.returning = vi.fn().mockResolvedValue([]);
  return chain;
}

function deleteChain() {
  return { where: vi.fn().mockResolvedValue([]) };
}

// ── Mock @workspace/db ──
vi.mock("@workspace/db", () => ({
  db: {
    select: mocks.mockSelect,
    insert: mocks.mockInsert,
    update: mocks.mockUpdate,
    delete: mocks.mockDelete,
    transaction: mocks.mockTransaction,
    execute: mocks.mockExecute,
  },
  applicationsTable: { id: "id", jobId: "job_id", applicantId: "applicant_id", status: "status", penaltyCount: "penalty_count", promotedAt: "promoted_at", acknowledgeDeadline: "acknowledge_deadline", acknowledgedAt: "acknowledged_at", withdrawnAt: "withdrawn_at", createdAt: "created_at", updatedAt: "updated_at" },
  applicantsTable: { id: "id", name: "name", email: "email", createdAt: "created_at" },
  jobsTable: { id: "id", title: "title", capacity: "capacity", createdAt: "created_at" },
  queuePositionsTable: { id: "id", jobId: "job_id", applicationId: "application_id", position: "position" },
  auditLogsTable: { id: "id", applicationId: "application_id", eventType: "event_type", fromStatus: "from_status", toStatus: "to_status", metadata: "metadata", createdAt: "created_at" },
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// ── Import service functions (uses mocked db) ──
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

// ────────────────────────────────────────────────────────────────────
// applyToJob
// ────────────────────────────────────────────────────────────────────
describe("Business Logic — applyToJob", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NotFoundError if applicant does not exist", async () => {
    mocks.mockSelect.mockReturnValueOnce(selectChain([]));
    await expect(applyToJob(999, 1)).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError with applicant id in message", async () => {
    mocks.mockSelect.mockReturnValueOnce(selectChain([]));
    await expect(applyToJob(999, 1)).rejects.toThrow(/999/);
  });

  it("throws NotFoundError if job does not exist", async () => {
    mocks.mockSelect
      .mockReturnValueOnce(selectChain([{ id: 1, name: "Alice" }]))
      .mockReturnValueOnce(selectChain([]));
    await expect(applyToJob(1, 999)).rejects.toThrow(NotFoundError);
  });

  it("throws DuplicateSubmissionError if active application exists", async () => {
    mocks.mockSelect
      .mockReturnValueOnce(selectChain([{ id: 1, name: "Alice" }]))
      .mockReturnValueOnce(selectChain([{ id: 1, title: "Engineer", capacity: 3 }]))
      .mockReturnValueOnce(selectChain([{ id: 10, status: "ACTIVE" }]));
    await expect(applyToJob(1, 1)).rejects.toThrow(DuplicateSubmissionError);
  });
});

// ────────────────────────────────────────────────────────────────────
// withdrawApplication
// ────────────────────────────────────────────────────────────────────
describe("Business Logic — withdrawApplication", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NotFoundError if application does not exist", async () => {
    mocks.mockSelect.mockReturnValueOnce(selectChain([]));
    await expect(withdrawApplication(999)).rejects.toThrow(NotFoundError);
  });

  it("throws NotFoundError with application id in message", async () => {
    mocks.mockSelect.mockReturnValueOnce(selectChain([]));
    await expect(withdrawApplication(999)).rejects.toThrow(/999/);
  });

  it("throws ConflictError if application is already INACTIVE", async () => {
    mocks.mockSelect.mockReturnValueOnce(selectChain([{
      id: 1, status: "INACTIVE", applicantId: 1, jobId: 1,
    }]));
    await expect(withdrawApplication(1)).rejects.toThrow(ConflictError);
  });

  it("throws ConflictError with 'already inactive' message", async () => {
    mocks.mockSelect.mockReturnValueOnce(selectChain([{
      id: 1, status: "INACTIVE", applicantId: 1, jobId: 1,
    }]));
    await expect(withdrawApplication(1)).rejects.toThrow(/already inactive/);
  });
});

// ────────────────────────────────────────────────────────────────────
// acknowledgePromotion
// ────────────────────────────────────────────────────────────────────
describe("Business Logic — acknowledgePromotion", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws NotFoundError if application does not exist", async () => {
    mocks.mockSelect.mockReturnValueOnce(selectChain([]));
    await expect(acknowledgePromotion(999)).rejects.toThrow(NotFoundError);
  });

  it("throws ConflictError if application is not PENDING_ACKNOWLEDGMENT", async () => {
    mocks.mockSelect.mockReturnValueOnce(selectChain([{
      id: 1, status: "ACTIVE", applicantId: 1, jobId: 1, acknowledgeDeadline: null,
    }]));
    await expect(acknowledgePromotion(1)).rejects.toThrow(ConflictError);
  });

  it("throws ConflictError with descriptive message", async () => {
    mocks.mockSelect.mockReturnValueOnce(selectChain([{
      id: 1, status: "ACTIVE", applicantId: 1, jobId: 1, acknowledgeDeadline: null,
    }]));
    await expect(acknowledgePromotion(1)).rejects.toThrow(/not pending acknowledgment/);
  });

  it("throws GoneError if acknowledgment deadline has passed", async () => {
    const pastDeadline = new Date(Date.now() - 60_000);

    // 1st db.select: find the application
    mocks.mockSelect.mockReturnValueOnce(selectChain([{
      id: 1, status: "PENDING_ACKNOWLEDGMENT", applicantId: 1, jobId: 1,
      acknowledgeDeadline: pastDeadline, penaltyCount: 0,
    }]));
    // 2nd db.select: find the job (for penalty logic)
    mocks.mockSelect.mockReturnValueOnce(selectChain([{ id: 1, capacity: 3 }]));

    /**
     * Transaction callback: applyPenaltyAndRequeue + promoteNext run inside tx.
     * The tx mock must handle BOTH query patterns:
     *   Pattern A: tx.select().from(table).where()  → rows
     *   Pattern B: tx.select({}).from(sql`...`)      → rows  (getActiveCount)
     */
    mocks.mockTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<void>) => {
      const txSelect = vi.fn()
        // applyPenaltyAndRequeue: const [app] = await tx.select().from().where()
        .mockReturnValueOnce(selectChain([{
          id: 1, penaltyCount: 0, status: "PENDING_ACKNOWLEDGMENT",
        }]))
        // applyPenaltyAndRequeue: const [lastRow] = await tx.select({maxPos}).from().where()
        .mockReturnValueOnce(selectChain([{ maxPos: 0 }]))
        // getActiveCount: const [row] = await tx.select({count}).from(sql`...`)
        // → .from() is terminal, resolves directly (Pattern B handled by selectChain)
        .mockReturnValueOnce(selectChain([{ count: 3 }]));

      const tx = {
        select: txSelect,
        insert: vi.fn().mockReturnValue(mutationChain()),
        update: vi.fn().mockReturnValue(mutationChain()),
        delete: vi.fn().mockReturnValue(deleteChain()),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };
      await fn(tx);
    });

    await expect(acknowledgePromotion(1)).rejects.toThrow(GoneError);
  });

  it("GoneError contains 'expired' in the message", async () => {
    const pastDeadline = new Date(Date.now() - 60_000);

    mocks.mockSelect
      .mockReturnValueOnce(selectChain([{
        id: 1, status: "PENDING_ACKNOWLEDGMENT", applicantId: 1, jobId: 1,
        acknowledgeDeadline: pastDeadline, penaltyCount: 0,
      }]))
      .mockReturnValueOnce(selectChain([{ id: 1, capacity: 3 }]));

    mocks.mockTransaction.mockImplementationOnce(async (fn: (tx: unknown) => Promise<void>) => {
      const tx = {
        select: vi.fn()
          .mockReturnValueOnce(selectChain([{
            id: 1, penaltyCount: 0, status: "PENDING_ACKNOWLEDGMENT",
          }]))
          .mockReturnValueOnce(selectChain([{ maxPos: 0 }]))
          .mockReturnValueOnce(selectChain([{ count: 3 }])),
        insert: vi.fn().mockReturnValue(mutationChain()),
        update: vi.fn().mockReturnValue(mutationChain()),
        delete: vi.fn().mockReturnValue(deleteChain()),
        execute: vi.fn().mockResolvedValue({ rows: [] }),
      };
      await fn(tx);
    });

    await expect(acknowledgePromotion(1)).rejects.toThrow(/expired/);
  });
});
