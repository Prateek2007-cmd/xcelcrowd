import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

// ── Mock database layer ──
vi.mock("@workspace/db", () => {
  // Create a function that returns chainable mocks
  const createChainableMock = (result: any[] = []) => {
    const chainObj: any = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
      set: vi.fn(),
      values: vi.fn(),
      returning: vi.fn(),
    };

    // Make all chainable methods return a thenable chain object
    const chain = () => {
      const newChain = Object.create(chainObj);
      return newChain;
    };

    chainObj.from = vi.fn().mockReturnValue(chainObj);
    chainObj.where = vi.fn().mockReturnValue(chainObj);
    chainObj.limit = vi.fn().mockReturnValue(chainObj);
    chainObj.set = vi.fn().mockReturnValue(chainObj);
    chainObj.values = vi.fn().mockReturnValue(chainObj);
    chainObj.returning = vi.fn().mockReturnValue(chainObj);

    // Make it thenable (awaitable) - resolves to result array
    chainObj.then = vi.fn((onFulfilled) => {
      return Promise.resolve(result).then(onFulfilled);
    });

    return chainObj;
  };

  // Set up transaction mock to provide a working mockTx
  const dbTransaction = vi.fn((callback) => {
    const txWithChains: any = {
      select: vi.fn().mockImplementation(() => createChainableMock([])),
      insert: vi.fn().mockImplementation(() => createChainableMock([])),
      update: vi.fn().mockImplementation(() => createChainableMock([])),
      delete: vi.fn().mockImplementation(() => createChainableMock([])),
      execute: vi.fn(),
    };
    return callback(txWithChains);
  });

  return {
    db: {
      select: vi.fn(),
      insert: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      execute: vi.fn(),
      transaction: dbTransaction,
    },
    applicationsTable: {},
    applicantsTable: {},
    jobsTable: {},
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

vi.mock("../services/pipeline", () => ({
  getActiveCount: vi.fn(),
  promoteNext: vi.fn(),
  checkAndDecayExpiredAcknowledgments: vi.fn(),
  applyPenaltyAndRequeue: vi.fn(),
}));

// ── Test helpers ──
function createMockApplication(overrides = {}) {
  return {
    id: 1,
    applicantId: 100,
    jobId: 10,
    status: "ACTIVE",
    createdAt: new Date(),
    promotedAt: new Date(),
    acknowledgeDeadline: new Date(Date.now() + 600000),
    penaltyCount: 0,
    ...overrides,
  };
}

function createMockApplicant(overrides = {}) {
  return {
    id: 100,
    name: "John Doe",
    email: "john@example.com",
    createdAt: new Date(),
    ...overrides,
  };
}

function createMockJob(overrides = {}) {
  return {
    id: 10,
    title: "Senior Engineer",
    description: "Build amazing things",
    capacity: 5,
    createdAt: new Date(),
    ...overrides,
  };
}

// ── Mocking utilities ──
function mockDbQuery(result: any[] = []) {
  const createChain = () => {
    const chainObj = {
      from: vi.fn(),
      where: vi.fn(),
      limit: vi.fn(),
    };

    // Make all methods return the same chainable object
    chainObj.from = vi.fn().mockReturnValue(chainObj);
    chainObj.where = vi.fn().mockReturnValue(chainObj);
    chainObj.limit = vi.fn().mockReturnValue(chainObj);

    // Make the chain thenable (awaitable) - resolves to result array
    (chainObj as any).then = vi.fn((onFulfilled) => {
      return Promise.resolve(result).then(onFulfilled);
    });

    return chainObj;
  };

  const chain = createChain();
  return chain as any;
}

// ── Tests: applyToJob ──
describe("applicationService.applyToJob()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws NotFoundError if applicant does not exist", async () => {
    const mockSelect = mockDbQuery([]);
    vi.mocked(db.select).mockReturnValue(mockSelect as any);

    await expect(applyToJob(999, 10)).rejects.toThrow(NotFoundError);
    expect(vi.mocked(db.select)).toHaveBeenCalled();
  });

  it("throws NotFoundError if job does not exist", async () => {
    const applicant = createMockApplicant();
    const mockSelectApplicant = mockDbQuery([applicant]);

    vi.mocked(db.select)
      .mockReturnValueOnce(mockSelectApplicant as any)
      .mockReturnValueOnce(mockDbQuery([]) as any);

    await expect(applyToJob(100, 999)).rejects.toThrow(NotFoundError);
  });

  it("throws DuplicateSubmissionError if applicant already has active application", async () => {
    const applicant = createMockApplicant();
    const job = createMockJob();

    const mockSelectApplicant = mockDbQuery([applicant]);
    const mockSelectJob = mockDbQuery([job]);
    const mockSelectExisting = mockDbQuery([createMockApplication()]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const selects = [mockSelectApplicant, mockSelectJob, mockSelectExisting];
      return selects[callCount++] as any;
    });

    await expect(applyToJob(100, 10)).rejects.toThrow(DuplicateSubmissionError);
  });
});

// ── Tests: withdrawApplication ──
describe("applicationService.withdrawApplication()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws NotFoundError if application does not exist", async () => {
    const mockSelect = mockDbQuery([]);
    vi.mocked(db.select).mockReturnValue(mockSelect as any);

    await expect(withdrawApplication(999)).rejects.toThrow(NotFoundError);
  });

  it("throws ConflictError if application is already inactive", async () => {
    const inactiveApp = createMockApplication({ status: "INACTIVE" });
    const mockSelect = mockDbQuery([inactiveApp]);
    vi.mocked(db.select).mockReturnValue(mockSelect as any);

    await expect(withdrawApplication(1)).rejects.toThrow(ConflictError);
  });

  it("successfully withdraws an active application", async () => {
    const activeApp = createMockApplication({ status: "ACTIVE" });
    const job = createMockJob();

    const mockSelectApp = mockDbQuery([activeApp]);
    const mockSelectJob = mockDbQuery([job]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const selects = [mockSelectApp, mockSelectJob];
      return selects[callCount++] as any;
    });

    const mockUpdateChain = {
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };
    vi.mocked(db.update).mockReturnValue(mockUpdateChain as any);

    const mockInsertChain = {
      values: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(db.insert).mockReturnValue(mockInsertChain as any);

    const result = await withdrawApplication(1);
    expect(result.status).toBe("INACTIVE");
    expect(result.applicationId).toBe(1);
  });

  it("logs audit entry when withdrawing", async () => {
    const activeApp = createMockApplication({ status: "ACTIVE" });
    const job = createMockJob();

    const mockSelectApp = mockDbQuery([activeApp]);
    const mockSelectJob = mockDbQuery([job]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const selects = [mockSelectApp, mockSelectJob];
      return selects[callCount++] as any;
    });

    const mockUpdateChain = {
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };
    vi.mocked(db.update).mockReturnValue(mockUpdateChain as any);

    const mockInsertChain = {
      values: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(db.insert).mockReturnValue(mockInsertChain as any);

    await withdrawApplication(1);
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });
});

// ── Tests: acknowledgePromotion ──
describe("applicationService.acknowledgePromotion()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws NotFoundError if application does not exist", async () => {
    const mockSelect = mockDbQuery([]);
    vi.mocked(db.select).mockReturnValue(mockSelect as any);

    await expect(acknowledgePromotion(999)).rejects.toThrow(NotFoundError);
  });

  it("throws ConflictError if application is not PENDING_ACKNOWLEDGMENT", async () => {
    const activeApp = createMockApplication({ status: "ACTIVE" });
    const mockSelect = mockDbQuery([activeApp]);
    vi.mocked(db.select).mockReturnValue(mockSelect as any);

    await expect(acknowledgePromotion(1)).rejects.toThrow(ConflictError);
  });

  it("throws GoneError if acknowledgment deadline has passed", async () => {
    const expiredApp = createMockApplication({
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() - 1000), // 1ms ago
    });
    const job = createMockJob();

    const mockSelectApp = mockDbQuery([expiredApp]);
    const mockSelectJob = mockDbQuery([job]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const selects = [mockSelectApp, mockSelectJob];
      return selects[callCount++] as any;
    });

    await expect(acknowledgePromotion(1)).rejects.toThrow(GoneError);
  });

  it("successfully acknowledges a valid promotion", async () => {
    const validApp = createMockApplication({
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() + 600000), // Valid
    });
    const job = createMockJob();

    const mockSelectApp = mockDbQuery([validApp]);
    const mockSelectJob = mockDbQuery([job]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const selects = [mockSelectApp, mockSelectJob];
      return selects[callCount++] as any;
    });

    const mockUpdateChain = {
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };
    vi.mocked(db.update).mockReturnValue(mockUpdateChain as any);

    const mockInsertChain = {
      values: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(db.insert).mockReturnValue(mockInsertChain as any);

    const mockDeleteChain = {
      where: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(db.delete).mockReturnValue(mockDeleteChain as any);

    const result = await acknowledgePromotion(1);
    expect(result.status).toBe("ACTIVE");
    expect(result.applicationId).toBe(1);
  });

  it("removes application from queue when acknowledging", async () => {
    const validApp = createMockApplication({
      status: "PENDING_ACKNOWLEDGMENT",
      acknowledgeDeadline: new Date(Date.now() + 600000),
    });
    const job = createMockJob();

    const mockSelectApp = mockDbQuery([validApp]);
    const mockSelectJob = mockDbQuery([job]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const selects = [mockSelectApp, mockSelectJob];
      return selects[callCount++] as any;
    });

    const mockUpdateChain = {
      set: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) }),
    };
    vi.mocked(db.update).mockReturnValue(mockUpdateChain as any);

    const mockInsertChain = {
      values: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(db.insert).mockReturnValue(mockInsertChain as any);

    const mockDeleteChain = {
      where: vi.fn().mockResolvedValue(undefined),
    };
    vi.mocked(db.delete).mockReturnValue(mockDeleteChain as any);

    await acknowledgePromotion(1);
    expect(vi.mocked(db.delete)).toHaveBeenCalled();
  });
});

// ── Tests: applyPublic ──
describe("applicationService.applyPublic()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates new applicant if email does not exist", async () => {
    const applicant = createMockApplicant();
    const job = createMockJob();

    // Mock insert applicant chain
    const mockInsertApplicant = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([applicant]),
      }),
    };

    // Mock select for job lookup - use a fresh mockDbQuery for each select call
    vi.mocked(db.select).mockImplementation(() => {
      return mockDbQuery([job]) as any;
    });

    // Mock insert for applicant (succeeds) then insert for application (succeeds)
    vi.mocked(db.insert)
      .mockReturnValueOnce(mockInsertApplicant as any)
      .mockReturnValueOnce({
        values: vi.fn().mockResolvedValue([{ id: 1 }]),
      } as any);

    const result = await applyPublic("John Doe", "john@example.com", 10);
    expect(result.applicantId).toBe(applicant.id);
    expect(result.applicationId).toBe(1);
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
  });

  it("throws DatabaseError if job does not exist", async () => {
    const applicant = createMockApplicant();

    // Mock insert applicant chain
    const mockInsertApplicant = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([applicant]),
      }),
    };

    // Mock select to return empty for job lookup
    vi.mocked(db.select).mockImplementation(() => {
      return mockDbQuery([]) as any;
    });

    vi.mocked(db.insert).mockReturnValueOnce(mockInsertApplicant as any);

    await expect(applyPublic("John Doe", "john@example.com", 999)).rejects.toThrow(
      NotFoundError
    );
  });

  it("reuses existing applicant on duplicate email error", async () => {
    const existingApplicant = createMockApplicant({ id: 42 });
    const job = createMockJob();

    const duplicateError = new Error("duplicate key");
    (duplicateError as any).code = "23505";

    // Mock insert applicant to fail with duplicate constraint
    const mockInsertApplicant = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValueOnce(duplicateError),
      }),
    };

    // Mock select calls: returns appropriate data for each call
    let selectCallCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      selectCallCount++;
      // First select: fetch existing applicant (after duplicate error)
      // Second select: fetch job for validation
      return mockDbQuery(selectCallCount === 1 ? [existingApplicant] : [job]) as any;
    });

    // Mock insert: first for applicant (throws), then application insert doesn't need mocking
    // because it happens in transaction with mockTx
    vi.mocked(db.insert)
      .mockReturnValueOnce(mockInsertApplicant as any);

    const result = await applyPublic("John Doe", "john@example.com", 10);

    // Verify applicant was reused
    expect(result.applicantId).toBe(42);
    expect(vi.mocked(db.insert)).toHaveBeenCalled();
    expect(vi.mocked(db.select)).toHaveBeenCalled();
  });

  it("throws DatabaseError if duplicate email but applicant not found", async () => {
    const duplicateError = new Error("duplicate key");
    (duplicateError as any).code = "23505";

    // Mock insert to fail with duplicate constraint
    const mockInsertApplicant = {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockRejectedValueOnce(duplicateError),
      }),
    };

    // Mock select to always return empty (applicant not found despite duplicate error)
    vi.mocked(db.select).mockImplementation(() => {
      return mockDbQuery([]) as any;
    });

    vi.mocked(db.insert).mockReturnValueOnce(mockInsertApplicant as any);

    // Should throw DatabaseError because duplicate exists but applicant not found
    await expect(
      applyPublic("John Doe", "john@example.com", 10)
    ).rejects.toThrow(DatabaseError);

    // Verify insert was attempted
    expect(vi.mocked(db.insert)).toHaveBeenCalled();

    // Verify select was called to try to fetch existing applicant
    expect(vi.mocked(db.select)).toHaveBeenCalled();
  });

  it("wraps unknown database errors in DatabaseError", async () => {
    const unknownError = new Error("Connection refused");
    (unknownError as any).code = "unknown";

    const mockInsertApplicant = {
      values: vi.fn().mockRejectedValueOnce(unknownError),
    };

    vi.mocked(db.insert).mockReturnValueOnce(mockInsertApplicant as any);

    await expect(applyPublic("John Doe", "john@example.com", 10)).rejects.toThrow(
      DatabaseError
    );
  });
});
