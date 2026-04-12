import { db } from "@workspace/db";
import { applicationsTable, jobsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";
import { checkAndDecayExpiredAcknowledgments } from "../services/pipeline";

const POLL_INTERVAL_MS = 30_000;

async function runDecayCycle(): Promise<void> {
  try {
    const pendingJobs = await db
      .selectDistinct({ jobId: applicationsTable.jobId })
      .from(applicationsTable)
      .where(
        sql`${applicationsTable.status} = 'PENDING_ACKNOWLEDGMENT' AND ${applicationsTable.acknowledgeDeadline} < NOW()`
      );

    for (const { jobId } of pendingJobs) {
      const [job] = await db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, jobId));

      if (!job) continue;

      const decayed = await checkAndDecayExpiredAcknowledgments(jobId, job.capacity);
      if (decayed > 0) {
        logger.info({ jobId, decayed }, "Decay worker: processed expired acknowledgments");
      }
    }
  } catch (err) {
    logger.error({ err }, "Decay worker: error during cycle");
  }
}

export function startDecayWorker(): NodeJS.Timeout {
  logger.info({ intervalMs: POLL_INTERVAL_MS }, "Starting inactivity decay worker");
  const interval = setInterval(() => {
    void runDecayCycle();
  }, POLL_INTERVAL_MS);
  return interval;
}
