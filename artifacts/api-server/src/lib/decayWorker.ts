import { db } from "@workspace/db";
import { applicationsTable, jobsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { runDecayForJob } from "../services/pipeline";

const POLL_INTERVAL_MS = 5_000;

/**
 * Execute a single decay cycle across all active jobs.
 *
 * Flow:
 *   1. Query: find distinct job IDs with expired PENDING_ACKNOWLEDGMENT applications
 *   2. For each job:
 *      - Fetch job details (capacity)
 *      - Call runDecayForJob (service layer handles decay + promote in transaction)
 *      - Log results per-job
 *   3. Errors in one job don't block other jobs
 *
 * All business logic is delegated to runDecayForJob, which:
 *   - Ensures ACID transactions
 *   - Handles expired application requeuing
 *   - Fills vacated slots from waitlist
 *   - Logs via audit trail and logger
 *
 * This worker runs on a fixed interval (POLL_INTERVAL_MS) to ensure
 * that expired acknowledgments are processed promptly.
 */
async function runDecayCycle(): Promise<void> {
  try {
    // Find all jobs with expired PENDING_ACKNOWLEDGMENT applications
    // This is a simple discovery query to identify which jobs need decay processing
    const jobsNeedingDecay = await db
      .selectDistinct({ jobId: applicationsTable.jobId })
      .from(applicationsTable)
      .where(
        sql`${applicationsTable.status} = 'PENDING_ACKNOWLEDGMENT' AND ${applicationsTable.acknowledgeDeadline} < NOW()`
      );

    if (jobsNeedingDecay.length === 0) {
      return;  // No jobs need decay this cycle
    }

    const results = [];

    // Process each job via the service layer
    for (const { jobId } of jobsNeedingDecay) {
      try {
        // Fetch job details (capacity is required by runDecayForJob)
        const [job] = await db
          .select()
          .from(jobsTable)
          .where(eq(jobsTable.id, jobId));

        if (!job) {
          logger.warn({ jobId }, "Decay worker: job not found, skipping");
          continue;
        }

        // Execute decay via service layer (handles transaction, decay, promote, logging)
        const cycleResult = await runDecayForJob(jobId, job.capacity);
        
        if (cycleResult.success) {
          if (cycleResult.decayed > 0) {
            logger.info(
              { jobId, decayed: cycleResult.decayed, promoted: cycleResult.promoted },
              "Decay worker: cycle complete"
            );
          }
          results.push({ jobId, ...cycleResult });
        } else {
          logger.warn(
            { jobId },
            "Decay worker: cycle failed (error logged in service layer)"
          );
          results.push({ jobId, success: false });
        }
      } catch (err) {
        // Catch any unexpected errors from job processing
        // One job's failure doesn't prevent other jobs from being processed
        logger.error(
          { err, jobId },
          "Decay worker: unexpected error during job processing"
        );
        results.push({ jobId, success: false, error: String(err) });
      }
    }

    // Log summary if any jobs failed
    const failedCount = results.filter((r) => !r.success).length;
    if (failedCount > 0) {
      logger.warn(
        { totalJobs: results.length, failedJobs: failedCount },
        "Decay worker: cycle complete with errors"
      );
    }
  } catch (err) {
    // Catch any error during job discovery phase
    // This shouldn't abort the worker; just log and continue to next cycle
    logger.error({ err }, "Decay worker: error during cycle initialization");
  }
}

/**
 * Start the background decay worker.
 *
 * Returns the interval ID so it can be cleared if needed (e.g., on shutdown).
 * The worker runs runDecayCycle on a fixed interval. Each cycle:
 *   - Finds jobs with expired acknowledgments
 *   - Delegates decay processing to service layer
 *   - Handles per-job errors without stopping other jobs
 */
export function startDecayWorker(): NodeJS.Timeout {
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Starting inactivity decay worker");
  const interval = setInterval(() => {
    void runDecayCycle();
  }, POLL_INTERVAL_MS);
  return interval;
}
