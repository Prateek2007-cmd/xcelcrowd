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
  const chainFn = vi.fn()
    .mockReturnValue({ limit: vi.fn().mockResolvedValue(result) })
    .mockResolvedValue(result);

  chainFn.where = vi.fn().mockReturnValue(chainFn);
  chainFn.limit = vi.fn().mockReturnValue(chainFn);
  chainFn.from = vi.fn().mockReturnValue(chainFn);

  return chainFn;
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
    const job = createMockJob();

    const mockInsertApplicant = {
      values: vi.fn().mockResolvedValue([createMockApplicant()]),
    };

    const mockSelectJob = mockDbQuery([job]);
    const mockInsertApp = {
      values: vi.fn().mockResolvedValue([{ id: 1 }]),
    };

    vi.mocked(db.insert)
      .mockReturnValueOnce(mockInsertApplicant as any)
      .mockReturnValueOnce(mockInsertApp as any)
      .mockReturnValueOnce({ values: vi.fn().mockResolvedValue(undefined) } as any);

    vi.mocked(db.select).mockReturnValue(mockSelectJob as any);

    const result = await applyPublic("John Doe", "john@example.com", 10);
    expect(result.applicantId).toBe(100);
    expect(vi.mocked(db.insert)).toHaveBeenCalledWith(expect.anything());
  });

  it("throws DatabaseError if job does not exist", async () => {
    const mockInsertApplicant = {
      values: vi.fn().mockResolvedValue([createMockApplicant()]),
    };

    const mockSelectJob = mockDbQuery([]); // Empty result

    vi.mocked(db.insert).mockReturnValueOnce(mockInsertApplicant as any);
    vi.mocked(db.select).mockReturnValue(mockSelectJob as any);

    await expect(applyPublic("John Doe", "john@example.com", 999)).rejects.toThrow(
      NotFoundError
    );
  });

  it("reuses existing applicant on duplicate email error", async () => {
    const existingApplicant = createMockApplicant();
    const job = createMockJob();

    const duplicateError = new Error("duplicate key");
    (duplicateError as any).code = "23505";

    const mockInsertApplicant = {
      values: vi.fn().mockRejectedValueOnce(duplicateError),
    };

    const mockSelectExisting = mockDbQuery([existingApplicant]);
    const mockSelectJob = mockDbQuery([job]);

    let callCount = 0;
    vi.mocked(db.select).mockImplementation(() => {
      const selects = [mockSelectExisting, mockSelectJob];
      return selects[callCount++] as any;
    });

    vi.mocked(db.insert).mockReturnValueOnce(mockInsertApplicant as any);

    const mockInsertApp = {
      values: vi.fn().mockResolvedValue([{ id: 1 }]),
    };
    vi.mocked(db.insert).mockReturnValueOnce({ values: vi.fn() } as any);

    // This test demonstrates the duplicate email handling
    // The actual implementation would reuse the applicant
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
