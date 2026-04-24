/**
 * Promotion logic — promoteNext and promoteUntilFull.
 */
import { db } from "@workspace/db";
import { applicationsTable, queuePositionsTable, auditLogsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger";
import type { TxHandle } from "./types";
import { ACKNOWLEDGE_WINDOW_MS } from "./types";
import { getActiveCount, getNextInQueue, getNextCandidates, reindexQueue } from "./queue";

/**
 * Promote a single candidate from WAITLIST → PENDING_ACKNOWLEDGMENT.
 *
 * Steps:
 *   1. Verify capacity available
 *   2. Fetch next in queue
 *   3. Guard against stale entries
 *   4. Update status + set deadline
 *   5. Remove from queue + reindex
 *   6. Write PROMOTED audit log
 *
 * Returns true if a promotion occurred, false otherwise.
 */
export async function promoteNext(
  jobId: number,
  jobCapacity: number,
  tx: TxHandle = db
): Promise<boolean> {
  const activeCount = await getActiveCount(jobId, tx);
  if (activeCount >= jobCapacity) {
    return false;
  }

  const next = await getNextInQueue(jobId, tx);
  if (!next) {
    return false;
  }

  const deadline = new Date(Date.now() + ACKNOWLEDGE_WINDOW_MS);

  const [app] = await tx
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, next.applicationId));

  // Guard: stale queue entry — prune and abort
  if (!app || app.status !== "WAITLIST") {
    await tx
      .delete(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, next.applicationId));
    return false;
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

  return true;
}

/**
 * Fill all available active slots from the waitlist in a single pass.
 * Returns the number of candidates actually promoted.
 */
export async function promoteUntilFull(
  jobId: number,
  jobCapacity: number,
  tx: TxHandle = db
): Promise<number> {
  const activeCount = await getActiveCount(jobId, tx);
  const slotsAvailable = jobCapacity - activeCount;
  if (slotsAvailable <= 0) return 0;

  const candidates = await getNextCandidates(jobId, slotsAvailable, tx);
  if (candidates.length === 0) return 0;

  let promoted = 0;
  for (const _candidate of candidates) {
    const success = await promoteNext(jobId, jobCapacity, tx);
    if (!success) break;
    promoted++;
  }
  return promoted;
}
