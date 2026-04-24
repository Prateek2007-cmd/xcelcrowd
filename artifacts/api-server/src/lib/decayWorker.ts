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
 *      - Log detailed results per-job
 *   3. Errors in one job don't block other jobs
 *   4. Log comprehensive summary with metrics
 *
 * Structured logging provides:
 *   - Cycle-level metrics (start time, duration, job count)
 *   - Job-level details (jobId, title, capacity, results)
 *   - Application-level visibility (decayed, promoted counts)
 *   - Error details with stack traces
 *
 * This worker runs on a fixed interval (POLL_INTERVAL_MS) to ensure
 * that expired acknowledgments are processed promptly.
 */
async function runDecayCycle(): Promise<void> {
  const cycleStartTime = Date.now();
  let jobsProcessed = 0;
  let jobsWithActivity = 0;
  let jobsFailed = 0;
  let totalDecayed = 0;
  let totalPromoted = 0;

  try {
    // PHASE 1: Discover jobs needing decay
    logger.debug(
      { phase: "discovery" },
      "Decay worker: starting cycle - discovering jobs with expired acknowledgments"
    );

    const jobsNeedingDecay = await db
      .selectDistinct({ jobId: applicationsTable.jobId })
      .from(applicationsTable)
      .where(
        sql`${applicationsTable.status} = 'PENDING_ACKNOWLEDGMENT' AND ${applicationsTable.acknowledgeDeadline} < NOW()`
      );

    if (jobsNeedingDecay.length === 0) {
      logger.debug(
        { phase: "discovery", jobsFound: 0 },
        "Decay worker: no jobs with expired acknowledgments this cycle"
      );
      return;
    }

    logger.info(
      { phase: "discovery", jobsFound: jobsNeedingDecay.length },
      `Decay worker: discovered ${jobsNeedingDecay.length} job(s) with expired acknowledgments`
    );

    const jobResults: Array<{
      jobId: number;
      jobTitle?: string;
      capacity?: number;
      decayed: number;
      promoted: number;
      success: boolean;
      errorMessage?: string;
    }> = [];

    // PHASE 2: Process each job independently
    for (const { jobId } of jobsNeedingDecay) {
      let jobStartTime = Date.now();
      let currentJobDecayed = 0;
      let currentJobPromoted = 0;

      try {
        // Fetch job details (capacity is required by runDecayForJob)
        logger.debug(
          { jobId, phase: "fetch" },
          "Decay worker: fetching job details"
        );

        const [job] = await db
          .select()
          .from(jobsTable)
          .where(eq(jobsTable.id, jobId));

        if (!job) {
          logger.warn(
            { jobId, phase: "fetch" },
            "Decay worker: job not found in database, skipping"
          );
          jobResults.push({
            jobId,
            decayed: 0,
            promoted: 0,
            success: false,
            errorMessage: "Job not found",
          });
          jobsFailed++;
          continue;
        }

        logger.info(
          {
            jobId,
            jobTitle: job.title,
            capacity: job.capacity,
            phase: "processing-start",
          },
          `Decay worker: starting decay cycle for job "${job.title}" (capacity: ${job.capacity})`
        );

        // PHASE 3: Execute decay via service layer
        try {
          const cycleResult = await runDecayForJob(jobId, job.capacity);

          currentJobDecayed = cycleResult.decayed;
          currentJobPromoted = cycleResult.promoted;
          totalDecayed += cycleResult.decayed;
          totalPromoted += cycleResult.promoted;

          if (cycleResult.success) {
            const processingTimeMs = Date.now() - jobStartTime;

            if (cycleResult.decayed > 0 || cycleResult.promoted > 0) {
              logger.info(
                {
                  jobId,
                  jobTitle: job.title,
                  decayed: cycleResult.decayed,
                  promoted: cycleResult.promoted,
                  processingTimeMs,
                  phase: "processing-complete",
                },
                `Decay worker: job "${job.title}" processed - decayed: ${cycleResult.decayed}, promoted: ${cycleResult.promoted}`
              );
              jobsWithActivity++;
            } else {
              logger.debug(
                {
                  jobId,
                  jobTitle: job.title,
                  processingTimeMs,
                  phase: "processing-complete",
                },
                `Decay worker: job "${job.title}" processed with no changes`
              );
            }

            jobResults.push({
              jobId,
              jobTitle: job.title,
              capacity: job.capacity,
              decayed: cycleResult.decayed,
              promoted: cycleResult.promoted,
              success: true,
            });
            jobsProcessed++;
          } else {
            const processingTimeMs = Date.now() - jobStartTime;
            logger.error(
              {
                jobId,
                jobTitle: job.title,
                processingTimeMs,
                phase: "processing-failed",
              },
              `Decay worker: job "${job.title}" processing failed (error logged in service layer)`
            );

            jobResults.push({
              jobId,
              jobTitle: job.title,
              capacity: job.capacity,
              decayed: 0,
              promoted: 0,
              success: false,
              errorMessage: "Service layer returned failure",
            });
            jobsFailed++;
          }
        } catch (serviceErr) {
          // Catch service layer errors
          const processingTimeMs = Date.now() - jobStartTime;
          const errorMessage =
            serviceErr instanceof Error ? serviceErr.message : String(serviceErr);

          logger.error(
            {
              jobId,
              jobTitle: job.title,
              error: errorMessage,
              stack: serviceErr instanceof Error ? serviceErr.stack : undefined,
              processingTimeMs,
              phase: "processing-error",
            },
            `Decay worker: unexpected error processing job "${job.title}"`
          );

          jobResults.push({
            jobId,
            jobTitle: job.title,
            capacity: job.capacity,
            decayed: 0,
            promoted: 0,
            success: false,
            errorMessage,
          });
          jobsFailed++;
        }
      } catch (jobDiscoveryErr) {
        // Catch errors during job fetching/setup phase
        const jobDiscoveryMessage =
          jobDiscoveryErr instanceof Error
            ? jobDiscoveryErr.message
            : String(jobDiscoveryErr);

        logger.error(
          {
            jobId,
            error: jobDiscoveryMessage,
            stack: jobDiscoveryErr instanceof Error ? jobDiscoveryErr.stack : undefined,
            phase: "job-discovery-error",
          },
          "Decay worker: error during job discovery phase"
        );

        jobResults.push({
          jobId,
          decayed: 0,
          promoted: 0,
          success: false,
          errorMessage: jobDiscoveryMessage,
        });
        jobsFailed++;
      }
    }

    // PHASE 4: Log comprehensive cycle summary
    const totalCycleTimeMs = Date.now() - cycleStartTime;
    const successfulJobs = jobResults.filter((r) => r.success).length;

    const summaryLog = {
      phase: "cycle-complete",
      cycleTimeMs: totalCycleTimeMs,
      jobsDiscovered: jobsNeedingDecay.length,
      jobsProcessed,
      jobsWithActivity,
      jobsFailed,
      successfulJobs,
      totalDecayed,
      totalPromoted,
      details: jobResults.map((r) => ({
        jobId: r.jobId,
        jobTitle: r.jobTitle || "unknown",
        success: r.success,
        decayed: r.decayed,
        promoted: r.promoted,
        error: r.errorMessage,
      })),
    };

    if (jobsFailed === 0 && successfulJobs > 0) {
      logger.info(
        summaryLog,
        `Decay worker: cycle complete - processed ${successfulJobs}/${jobsNeedingDecay.length} jobs, decayed: ${totalDecayed}, promoted: ${totalPromoted}, time: ${totalCycleTimeMs}ms`
      );
    } else if (jobsFailed > 0) {
      logger.warn(
        summaryLog,
        `Decay worker: cycle complete with errors - processed ${successfulJobs}/${jobsNeedingDecay.length} jobs, failed: ${jobsFailed}, decayed: ${totalDecayed}, promoted: ${totalPromoted}, time: ${totalCycleTimeMs}ms`
      );
    } else {
      logger.info(
        summaryLog,
        `Decay worker: cycle complete - processed ${successfulJobs}/${jobsNeedingDecay.length} jobs with no changes`
      );
    }
  } catch (cycleErr) {
    // Catch any error during cycle initialization or discovery phase
    // This is a critical error that prevents any job processing
    const cycleTimeMs = Date.now() - cycleStartTime;
    const errorMessage =
      cycleErr instanceof Error ? cycleErr.message : String(cycleErr);

    logger.error(
      {
        phase: "cycle-error",
        error: errorMessage,
        stack: cycleErr instanceof Error ? cycleErr.stack : undefined,
        cycleTimeMs,
      },
      "Decay worker: critical error during cycle initialization - no jobs processed"
    );
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
