import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startDecayWorker } from "../lib/decayWorker";

// ── Mock dependencies ────────────────────────────────────────────────────────

// Mock the pipeline service layer (runDecayForJob is the only import used)
const mockRunDecayForJob = vi.fn();
vi.mock("../services/pipeline", () => ({
  runDecayForJob: (...args: unknown[]) => mockRunDecayForJob(...args),
}));

// Mock the database layer
const mockSelectDistinct = vi.fn();
const mockSelectFrom = vi.fn();
const mockSelectWhere = vi.fn();
const mockJobSelect = vi.fn();
const mockJobFrom = vi.fn();
const mockJobWhere = vi.fn();

vi.mock("@workspace/db", () => ({
  db: {
    selectDistinct: vi.fn().mockImplementation(() => ({
      from: mockSelectFrom.mockReturnValue({
        where: mockSelectWhere,
      }),
    })),
    select: vi.fn().mockImplementation(() => ({
      from: mockJobFrom.mockReturnValue({
        where: mockJobWhere,
      }),
    })),
    transaction: vi.fn(),
    execute: vi.fn(),
  },
  applicationsTable: {
    jobId: "jobId",
    status: "status",
    acknowledgeDeadline: "acknowledgeDeadline",
  },
  jobsTable: {
    id: "id",
  },
}));

// Mock logger
const mockLogger = {
  info: vi.fn(),
  error: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};
vi.mock("../lib/logger", () => ({
  logger: mockLogger,
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The decayWorker's runDecayCycle is not exported directly —
 * it's only invoked via setInterval inside startDecayWorker.
 *
 * We test it by:
 *   1. Starting the worker (captures setInterval callback)
 *   2. Manually invoking the callback
 *   3. Asserting side effects
 */

function makeJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 10,
    title: "Software Engineer",
    capacity: 5,
    createdAt: new Date(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. startDecayWorker – lifecycle
// ═══════════════════════════════════════════════════════════════════════════════
describe("startDecayWorker()", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns an interval ID that can be cleared", () => {
    // Prevent actual execution by mocking db to return no jobs
    mockSelectWhere.mockResolvedValue([]);

    const intervalId = startDecayWorker();

    expect(intervalId).toBeDefined();
    clearInterval(intervalId);
  });

  it("logs startup with interval configuration", () => {
    mockSelectWhere.mockResolvedValue([]);

    const intervalId = startDecayWorker();

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMs: expect.any(Number) }),
      expect.stringContaining("Starting inactivity decay worker")
    );

    clearInterval(intervalId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. runDecayCycle – via timer tick
// ═══════════════════════════════════════════════════════════════════════════════
describe("runDecayCycle() – triggered via interval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("processes multiple jobs with expired acknowledgments", async () => {
    // Discovery: 2 jobs need decay
    mockSelectWhere.mockResolvedValueOnce([{ jobId: 10 }, { jobId: 20 }]);

    // Job fetches
    mockJobWhere
      .mockResolvedValueOnce([makeJob({ id: 10, title: "Job A", capacity: 5 })])
      .mockResolvedValueOnce([makeJob({ id: 20, title: "Job B", capacity: 3 })]);

    // Service layer results
    mockRunDecayForJob
      .mockResolvedValueOnce({ decayed: 2, promoted: 1, success: true })
      .mockResolvedValueOnce({ decayed: 1, promoted: 1, success: true });

    const intervalId = startDecayWorker();

    // Advance timer to trigger the cycle
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockRunDecayForJob).toHaveBeenCalledTimes(2);
    expect(mockRunDecayForJob).toHaveBeenCalledWith(10, 5);
    expect(mockRunDecayForJob).toHaveBeenCalledWith(20, 3);

    clearInterval(intervalId);
  });

  it("skips cycle silently when no jobs have expired acknowledgments", async () => {
    mockSelectWhere.mockResolvedValueOnce([]); // No expired jobs

    const intervalId = startDecayWorker();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockRunDecayForJob).not.toHaveBeenCalled();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "discovery", jobsFound: 0 }),
      expect.any(String)
    );

    clearInterval(intervalId);
  });

  it("calls runDecayForJob with correct jobId and capacity", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ jobId: 42 }]);
    mockJobWhere.mockResolvedValueOnce([makeJob({ id: 42, capacity: 8 })]);
    mockRunDecayForJob.mockResolvedValueOnce({ decayed: 1, promoted: 0, success: true });

    const intervalId = startDecayWorker();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockRunDecayForJob).toHaveBeenCalledWith(42, 8);

    clearInterval(intervalId);
  });

  it("logs success with decay/promote metrics per job", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ jobId: 10 }]);
    mockJobWhere.mockResolvedValueOnce([makeJob({ id: 10, title: "Backend Dev", capacity: 5 })]);
    mockRunDecayForJob.mockResolvedValueOnce({ decayed: 3, promoted: 2, success: true });

    const intervalId = startDecayWorker();
    await vi.advanceTimersByTimeAsync(5_000);

    // Job-level success log
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 10,
        decayed: 3,
        promoted: 2,
        phase: "processing-complete",
      }),
      expect.stringContaining("processed")
    );

    clearInterval(intervalId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. Failure isolation – one job fails, others still process
// ═══════════════════════════════════════════════════════════════════════════════
describe("runDecayCycle() – failure isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("continues processing remaining jobs after one job fails", async () => {
    // 3 jobs discovered
    mockSelectWhere.mockResolvedValueOnce([
      { jobId: 1 },
      { jobId: 2 },
      { jobId: 3 },
    ]);

    // Job fetches
    mockJobWhere
      .mockResolvedValueOnce([makeJob({ id: 1, capacity: 5 })])
      .mockResolvedValueOnce([makeJob({ id: 2, capacity: 3 })])
      .mockResolvedValueOnce([makeJob({ id: 3, capacity: 4 })]);

    // Job 1: success, Job 2: throws, Job 3: success
    mockRunDecayForJob
      .mockResolvedValueOnce({ decayed: 1, promoted: 1, success: true })
      .mockRejectedValueOnce(new Error("DB connection lost"))
      .mockResolvedValueOnce({ decayed: 2, promoted: 0, success: true });

    const intervalId = startDecayWorker();
    await vi.advanceTimersByTimeAsync(5_000);

    // All 3 jobs attempted
    expect(mockRunDecayForJob).toHaveBeenCalledTimes(3);

    // Error logged for job 2
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 2,
        error: "DB connection lost",
        phase: "processing-error",
      }),
      expect.any(String)
    );

    clearInterval(intervalId);
  });

  it("handles service layer returning success: false", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ jobId: 10 }]);
    mockJobWhere.mockResolvedValueOnce([makeJob({ id: 10, capacity: 5 })]);
    mockRunDecayForJob.mockResolvedValueOnce({ decayed: 0, promoted: 0, success: false });

    const intervalId = startDecayWorker();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: 10,
        phase: "processing-failed",
      }),
      expect.any(String)
    );

    clearInterval(intervalId);
  });

  it("skips job when job record is not found in database", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ jobId: 999 }]);
    mockJobWhere.mockResolvedValueOnce([]); // Job not found

    const intervalId = startDecayWorker();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockRunDecayForJob).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 999, phase: "fetch" }),
      expect.stringContaining("job not found")
    );

    clearInterval(intervalId);
  });

  it("logs cycle summary with warning when failures occur", async () => {
    mockSelectWhere.mockResolvedValueOnce([{ jobId: 1 }, { jobId: 2 }]);
    mockJobWhere
      .mockResolvedValueOnce([makeJob({ id: 1, capacity: 5 })])
      .mockResolvedValueOnce([makeJob({ id: 2, capacity: 3 })]);
    mockRunDecayForJob
      .mockResolvedValueOnce({ decayed: 1, promoted: 0, success: true })
      .mockResolvedValueOnce({ decayed: 0, promoted: 0, success: false });

    const intervalId = startDecayWorker();
    await vi.advanceTimersByTimeAsync(5_000);

    // Cycle summary should use warn level when failures exist
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "cycle-complete",
        jobsFailed: expect.any(Number),
      }),
      expect.stringContaining("errors")
    );

    clearInterval(intervalId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. Critical discovery-phase error
// ═══════════════════════════════════════════════════════════════════════════════
describe("runDecayCycle() – critical cycle error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs critical error when discovery query itself fails", async () => {
    mockSelectWhere.mockRejectedValueOnce(new Error("connection refused"));

    const intervalId = startDecayWorker();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockRunDecayForJob).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "cycle-error",
        error: "connection refused",
      }),
      expect.stringContaining("critical error")
    );

    clearInterval(intervalId);
  });
});
