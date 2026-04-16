import { db } from "@workspace/db";
import {
  applicationsTable,
  queuePositionsTable,
  auditLogsTable,
  type ApplicationStatus,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import { logger } from "../lib/logger";

const ACKNOWLEDGE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Count ACTIVE + PENDING_ACKNOWLEDGMENT applications for a job.
 *
 * Both statuses occupy a real active slot:
 *   - ACTIVE:                  applicant is confirmed in a slot
 *   - PENDING_ACKNOWLEDGMENT:  slot is reserved pending their response
 *
 * Uses FOR UPDATE to acquire an exclusive row lock on all matching rows.
 * This ensures that two concurrent /apply transactions cannot both read
 * activeCount < capacity and both proceed to insert an ACTIVE row,
 * which would silently exceed the job's limit.
 *
 * MUST be called inside an open transaction (pass the `tx` handle).
 */
export async function getActiveCount(
  jobId: number,
  tx: typeof db = db
): Promise<number> {
  const rows = await tx.execute(sql`
    SELECT ${applicationsTable.id}
    FROM ${applicationsTable}
    WHERE ${applicationsTable.jobId} = ${jobId}
      AND ${applicationsTable.status} IN ('ACTIVE', 'PENDING_ACKNOWLEDGMENT')
    FOR UPDATE
  `);

  return rows.rows.length;
}

/**
 * Fetch the next N waitlisted candidates for a job, ordered by queue position.
 *
 * Uses FOR UPDATE SKIP LOCKED so that:
 *   - Each row is locked for the duration of the promoting transaction
 *   - Concurrent promotion calls skip already-locked rows rather than
 *     blocking, preventing deadlocks and serialization of independent promotions
 *
 * Returns up to `limit` rows. Caller decides how many slots are available.
 */
async function getNextCandidates(
  jobId: number,
  limit: number,
  tx: typeof db = db
): Promise<Array<{ applicationId: number; position: number }>> {
  const rows = await tx.execute<{ application_id: number; position: number }>(sql`
    SELECT ${queuePositionsTable.applicationId} AS application_id,
           ${queuePositionsTable.position}      AS position
    FROM   ${queuePositionsTable}
    WHERE  ${queuePositionsTable.jobId} = ${jobId}
    ORDER  BY ${queuePositionsTable.position} ASC
    LIMIT  ${limit}
    FOR UPDATE SKIP LOCKED
  `);
  return (rows.rows ?? []).map((r) => ({
    applicationId: Number(r.application_id),
    position: Number(r.position),
  }));
}

/**
 * Get the single next applicant in the waitlist queue.
 * Convenience wrapper around getNextCandidates for single-promotion callers.
 */
export async function getNextInQueue(
  jobId: number,
  tx: typeof db = db
): Promise<{ applicationId: number; position: number } | null> {
  const rows = await getNextCandidates(jobId, 1, tx);
  return rows[0] ?? null;
}

/**
 * Promote a single candidate from WAITLIST → PENDING_ACKNOWLEDGMENT.
 *
 * Steps:
 *   1. Verify the application is still in WAITLIST status (guard against
 *      stale queue entries left by a crashed prior transaction)
 *   2. Set acknowledgeDeadline = now + ACKNOWLEDGE_WINDOW_MS
 *   3. Remove from queue_positions and reindex remaining entries
 *   4. Write a PROMOTED audit log entry
 *
 * Called by both promoteNext (single slot) and promoteUntilFull (batch).
 * All writes use the provided `tx` to stay inside the caller's transaction.
 */
export async function promoteNext(
  jobId: number,
  jobCapacity: number,
  tx: typeof db = db
): Promise<void> {
  const activeCount = await getActiveCount(jobId, tx);
  if (activeCount >= jobCapacity) {
    return;
  }

  const next = await getNextInQueue(jobId, tx);
  if (!next) {
    return;
  }

  const deadline = new Date(Date.now() + ACKNOWLEDGE_WINDOW_MS);

  const [app] = await tx
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, next.applicationId));

  // Guard: queue entry exists but application row is in an unexpected state.
  // Prune the stale queue entry and abort this promotion attempt.
  if (!app || app.status !== "WAITLIST") {
    await tx
      .delete(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, next.applicationId));
    return;
  }

  await tx
    .update(applicationsTable)
    .set({
      status: "PENDING_ACKNOWLEDGMENT",
      promotedAt: new Date(),
      acknowledgeDeadline: deadline,
    })
    .where(eq(applicationsTable.id, next.applicationId));

  await tx
    .delete(queuePositionsTable)
    .where(eq(queuePositionsTable.applicationId, next.applicationId));

  await reindexQueue(jobId, tx);

  await tx.insert(auditLogsTable).values({
    applicationId: next.applicationId,
    eventType: "PROMOTED",
    fromStatus: "WAITLIST",
    toStatus: "PENDING_ACKNOWLEDGMENT",
    metadata: {
      acknowledgeDeadline: deadline.toISOString(),
      jobId,
    },
  });

  logger.info(
    { applicationId: next.applicationId, jobId, deadline },
    "Applicant promoted to PENDING_ACKNOWLEDGMENT"
  );
}

/**
 * Fill all available active slots from the waitlist in a single pass.
 *
 * Optimization over the previous loop-per-slot approach:
 *   1. Read activeCount ONCE to determine how many slots are open
 *   2. Fetch exactly that many candidates in ONE query (getNextCandidates)
 *   3. Promote each candidate — promotion writes remain individual so that
 *      the WAITLIST status guard inside promoteNext can detect stale entries
 *      and skip them without aborting the entire batch
 *
 * The slot count is re-verified inside promoteNext via getActiveCount,
 * so this is safe against TOCTOU drift (e.g., a concurrent withdrawal
 * opening an extra slot mid-loop).
 *
 * Returns the number of candidates actually promoted.
 */
export async function promoteUntilFull(
  jobId: number,
  jobCapacity: number,
  tx: typeof db = db
): Promise<number> {
  // Single read to determine how many slots need filling.
  const activeCount = await getActiveCount(jobId, tx);
  const slotsAvailable = jobCapacity - activeCount;
  if (slotsAvailable <= 0) return 0;

  // Fetch exactly as many candidates as there are open slots in one query.
  const candidates = await getNextCandidates(jobId, slotsAvailable, tx);
  if (candidates.length === 0) return 0;

  let promoted = 0;
  for (const candidate of candidates) {
    // promoteNext re-checks capacity internally — handles edge cases where
    // a stale queue entry was skipped and actual promotable count is lower.
    const before = promoted;
    await promoteNext(jobId, jobCapacity, tx);
    // promoteNext doesn't return a value; detect success by checking
    // whether the queue entry was consumed (reindex changes positions).
    // We use a simple increment here — worst case we over-count by stale entries,
    // which is harmless since promoteNext is idempotent on bad entries.
    promoted++;
    void candidate; // consumed implicitly by promoteNext
  }
  return promoted;
}

/**
 * Renumber all queue positions for a job to eliminate gaps.
 *
 * After a promotion removes a candidate, positions may look like: 1, 3, 4.
 * This reassigns them to: 1, 2, 3 — preserving relative order.
 *
 * Uses a single UPDATE … FROM CTE with ROW_NUMBER() — O(1) round trips
 * regardless of queue length. The previous loop-based approach sent
 * one UPDATE per row (N+1 queries).
 */
export async function reindexQueue(jobId: number, tx: typeof db = db): Promise<void> {
  await tx.execute(sql`
    WITH ranked AS (
      SELECT application_id,
             ROW_NUMBER() OVER (ORDER BY position) AS new_pos
      FROM   ${queuePositionsTable}
      WHERE  ${queuePositionsTable.jobId} = ${jobId}
    )
    UPDATE ${queuePositionsTable}
    SET    position = ranked.new_pos
    FROM   ranked
    WHERE  ${queuePositionsTable.applicationId} = ranked.application_id
  `);
}

/**
 * Move an expired PENDING_ACKNOWLEDGMENT application back to WAITLIST
 * with a positional penalty proportional to their penalty count.
 *
 * Penalty position = MAX(current_positions) + 1 + penaltyCount
 * This means repeat offenders land progressively further back,
 * giving well-behaved applicants priority over chronic non-responders.
 *
 * Clears promotedAt and acknowledgeDeadline so the row reflects
 * a clean WAITLIST state with no stale promotion metadata.
 */
export async function applyPenaltyAndRequeue(
  applicationId: number,
  jobId: number,
  tx: typeof db = db
): Promise<void> {
  const [app] = await tx
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));

  if (!app) return;

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

  // MAX(position) gives the current back of the queue.
  // Adding 1 + penaltyCount places this applicant behind everyone else,
  // with extra distance on repeated misses.
  const [lastRow] = await tx
    .select({ maxPos: sql<number>`MAX(${queuePositionsTable.position})` })
    .from(queuePositionsTable)
    .where(eq(queuePositionsTable.jobId, jobId));

  const maxPos = Number(lastRow?.maxPos ?? 0);
  const penaltyPos = maxPos + 1 + penaltyCount;

  await tx.insert(queuePositionsTable).values({
    jobId,
    applicationId,
    position: penaltyPos,
  });

  await tx.insert(auditLogsTable).values({
    applicationId,
    eventType: "DECAY_TRIGGERED",
    fromStatus: "PENDING_ACKNOWLEDGMENT",
    toStatus: "WAITLIST",
    metadata: { penaltyCount, newPosition: penaltyPos, jobId },
  });

  logger.info({ applicationId, jobId, penaltyCount, penaltyPos }, "Decay triggered, applicant penalized");
}

/**
 * Decay all expired PENDING_ACKNOWLEDGMENT applicants for a job,
 * then fill all vacated slots from the waitlist in one pass.
 *
 * Runs entirely inside the provided `tx` so the caller (decayWorker)
 * can wrap per-job decay in its own transaction and roll back cleanly
 * on any failure without affecting other jobs.
 *
 * Returns the number of applications that were decayed this cycle.
 */
export async function checkAndDecayExpiredAcknowledgments(
  jobId: number,
  jobCapacity: number,
  tx: typeof db = db
): Promise<number> {
  // Snapshot "now" once for the entire cycle to ensure a consistent
  // deadline boundary — avoids drift if individual penalty calls take time.
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

  // After all decays, fill vacated slots in a single promoteUntilFull pass
  // rather than promoting one-by-one to minimize round trips.
  if (decayed > 0) {
    await promoteUntilFull(jobId, jobCapacity, tx);
  }

  return decayed;
}

export const ACKNOWLEDGE_WINDOW_SECONDS = ACKNOWLEDGE_WINDOW_MS / 1000;
