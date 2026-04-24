/**
 * Decay logic — expiry handling, penalty, requeue, and decay orchestration.
 */
import { db } from "@workspace/db";
import { applicationsTable, queuePositionsTable, auditLogsTable } from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "../../lib/logger";
import { AppError } from "../../lib/errors";
import { mapDbError } from "../../lib/dbErrorMapper";
import type { TxHandle, DecayResult } from "./types";
import { promoteUntilFull } from "./promote";

/**
 * Move an expired PENDING_ACKNOWLEDGMENT application back to WAITLIST,
 * placing them at the END of the queue to preserve FIFO fairness.
 */
export async function applyPenaltyAndRequeue(
  applicationId: number,
  jobId: number,
  tx: TxHandle = db
): Promise<void> {
  const [app] = await tx
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));

  if (!app) return;

  // STEP 1: Remove any stale queue entry (defensive)
  await tx
    .delete(queuePositionsTable)
    .where(eq(queuePositionsTable.applicationId, applicationId));

  // STEP 2: Calculate end-of-queue position
  const [lastRow] = await tx
    .select({ maxPos: sql<number>`MAX(${queuePositionsTable.position})` })
    .from(queuePositionsTable)
    .where(eq(queuePositionsTable.jobId, jobId));

  const maxPos = Number(lastRow?.maxPos ?? 0);
  const newPosition = maxPos + 1;

  // STEP 3: Insert new queue entry at the end
  await tx.insert(queuePositionsTable).values({
    jobId,
    applicationId,
    position: newPosition,
  });

  // STEP 4: Update application status back to WAITLIST
  const penaltyCount = app.penaltyCount + 1;
  await tx
    .update(applicationsTable)
    .set({
      status: "WAITLIST",
      penaltyCount,
      promotedAt: null,
      acknowledgeDeadline: null,
    })
    .where(eq(applicationsTable.id, applicationId));

  // STEP 5: Log the decay event
  await tx.insert(auditLogsTable).values({
    applicationId,
    eventType: "DECAY_TRIGGERED",
    fromStatus: "PENDING_ACKNOWLEDGMENT",
    toStatus: "WAITLIST",
    metadata: { penaltyCount, newPosition, jobId },
  });

  logger.info(
    { applicationId, jobId, penaltyCount, newPosition },
    "Decay triggered: applicant moved to end of queue"
  );
}

/**
 * Decay all expired PENDING_ACKNOWLEDGMENT applicants for a job,
 * then fill all vacated slots from the waitlist in one pass.
 */
export async function checkAndDecayExpiredAcknowledgments(
  jobId: number,
  jobCapacity: number,
  tx: TxHandle = db
): Promise<number> {
  const now = new Date();
  const expired = await tx
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.jobId, jobId),
        eq(applicationsTable.status, "PENDING_ACKNOWLEDGMENT"),
        sql`${applicationsTable.acknowledgeDeadline} < ${now.toISOString()}`
      )
    );

  let decayed = 0;
  for (const app of expired) {
    await applyPenaltyAndRequeue(app.id, jobId, tx);
    decayed++;
  }

  if (decayed > 0) {
    await promoteUntilFull(jobId, jobCapacity, tx);
  }

  return decayed;
}

/**
 * Execute a complete decay cycle for a single job (transaction wrapper).
 * Primary entry point called by decayWorker.
 */
export async function runDecayForJob(
  jobId: number,
  jobCapacity: number
): Promise<DecayResult> {
  try {
    const result = await db.transaction(async (tx) => {
      const decayed = await checkAndDecayExpiredAcknowledgments(jobId, jobCapacity, tx);
      return { decayed };
    });

    return {
      decayed: result.decayed,
      promoted: result.decayed > 0 ? 1 : 0,
      success: true,
    };
  } catch (err) {
    if (err instanceof AppError) {
      logger.error(
        { jobId, errorCode: err.code, message: err.message, stage: "decay" },
        `Pipeline error during decay cycle for job ${jobId}`
      );
      return {
        decayed: 0, promoted: 0, success: false,
        error: { code: err.code, message: err.message, stage: "decay" },
      };
    }

    // ── 2. Database errors (semantic mapping) ──
    const dbErr = mapDbError(err);
    if (dbErr) {
      logger.error(
        { jobId, errorType: dbErr.type, rawCode: dbErr.rawCode, stage: "decay", err },
        `Database error (${dbErr.type}) during decay cycle for job ${jobId}`
      );
      return {
        decayed: 0, promoted: 0, success: false,
        error: { code: dbErr.type, message: `Database error: ${dbErr.type}`, stage: "decay" },
      };
    }

    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      { jobId, error: message, stack: err instanceof Error ? err.stack : undefined, stage: "decay" },
      `Unexpected failure during decay cycle for job ${jobId}`
    );
    return {
      decayed: 0, promoted: 0, success: false,
      error: { code: "INTERNAL_ERROR", message: "Unexpected failure during decay", stage: "decay" },
    };
  }
}
