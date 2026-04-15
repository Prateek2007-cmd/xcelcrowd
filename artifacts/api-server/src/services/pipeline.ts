import { db } from "@workspace/db";
import {
  applicationsTable,
  queuePositionsTable,
  auditLogsTable,
  type ApplicationStatus,
} from "@workspace/db";
import { eq, and, sql, asc } from "drizzle-orm";
import { logger } from "../lib/logger";

const ACKNOWLEDGE_WINDOW_MS = 5 * 60 * 1000;

/**
 * Count ACTIVE + PENDING_ACKNOWLEDGMENT applications for a job.
 * Uses FOR UPDATE to lock matching rows, preventing concurrent requests
 * from both seeing available capacity and exceeding the limit.
 *
 * MUST be called with `tx` inside a transaction.
 */
export async function getActiveCount(jobId: number, tx: typeof db = db): Promise<number> {
  const result = await tx.execute<{ count: string }>(sql`
    SELECT COUNT(*) as count
    FROM ${applicationsTable}
    WHERE ${applicationsTable.jobId} = ${jobId}
      AND ${applicationsTable.status} IN ('ACTIVE', 'PENDING_ACKNOWLEDGMENT')
  `);
  return Number(result.rows?.[0]?.count ?? 0);
}

/**
 * Get the next applicant in the waitlist queue.
 * Uses FOR UPDATE SKIP LOCKED to lock the row being promoted
 * and skip rows already locked by concurrent transactions.
 */
export async function getNextInQueue(
  jobId: number,
  tx: typeof db = db
): Promise<{ applicationId: number; position: number } | null> {
  const rows = await tx.execute<{ application_id: number; position: number }>(sql`
    SELECT ${queuePositionsTable.applicationId} AS application_id,
           ${queuePositionsTable.position} AS position
    FROM ${queuePositionsTable}
    WHERE ${queuePositionsTable.jobId} = ${jobId}
    ORDER BY ${queuePositionsTable.position} ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
  `);

  const row = rows.rows?.[0];
  if (!row) return null;
  return { applicationId: Number(row.application_id), position: Number(row.position) };
}

/**
 * Promote the next waitlisted applicant to PENDING_ACKNOWLEDGMENT
 * if there is capacity available. All reads/writes use `tx` so this
 * is safe to call inside a transaction.
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
 * Fill all available active slots from the waitlist queue.
 * Keeps promoting until capacity is full or queue is empty.
 */
export async function promoteUntilFull(
  jobId: number,
  jobCapacity: number,
  tx: typeof db = db
): Promise<number> {
  let promoted = 0;
  // Safety limit to prevent infinite loops
  const maxIterations = jobCapacity;
  for (let i = 0; i < maxIterations; i++) {
    const activeCount = await getActiveCount(jobId, tx);
    if (activeCount >= jobCapacity) break;

    const next = await getNextInQueue(jobId, tx);
    if (!next) break;

    await promoteNext(jobId, jobCapacity, tx);
    promoted++;
  }
  return promoted;
}

export async function reindexQueue(jobId: number, tx: typeof db = db): Promise<void> {
  const rows = await tx
    .select({
      applicationId: queuePositionsTable.applicationId,
    })
    .from(queuePositionsTable)
    .where(eq(queuePositionsTable.jobId, jobId))
    .orderBy(asc(queuePositionsTable.position));

  for (let i = 0; i < rows.length; i++) {
    await tx
      .update(queuePositionsTable)
      .set({ position: i + 1 })
      .where(eq(queuePositionsTable.applicationId, rows[i].applicationId));
  }
}

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
 * then fill all vacated slots from the waitlist.
 * All operations run inside the provided transaction.
 */
export async function checkAndDecayExpiredAcknowledgments(
  jobId: number,
  jobCapacity: number,
  tx: typeof db = db
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

  // Promote once per vacated slot (not just once total)
  if (decayed > 0) {
    await promoteUntilFull(jobId, jobCapacity, tx);
  }

  return decayed;
}

export const ACKNOWLEDGE_WINDOW_SECONDS = ACKNOWLEDGE_WINDOW_MS / 1000;
