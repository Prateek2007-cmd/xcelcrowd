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

export async function getActiveCount(jobId: number): Promise<number> {
  const [row] = await db
    .select({
      count: sql<number>`COUNT(*)`,
    })
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.jobId, jobId),
        sql`${applicationsTable.status} IN ('ACTIVE', 'PENDING_ACKNOWLEDGMENT')`
      )
    );
  return Number(row?.count ?? 0);
}

export async function getNextInQueue(
  jobId: number,
  tx: typeof db = db
): Promise<{ applicationId: number; position: number } | null> {
  const [row] = await tx
    .select({
      applicationId: queuePositionsTable.applicationId,
      position: queuePositionsTable.position,
    })
    .from(queuePositionsTable)
    .where(eq(queuePositionsTable.jobId, jobId))
    .orderBy(asc(queuePositionsTable.position))
    .limit(1);

  return row ?? null;
}

export async function promoteNext(
  jobId: number,
  jobCapacity: number,
  tx: typeof db = db
): Promise<void> {
  const activeCount = await getActiveCount(jobId);
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

  if (decayed > 0) {
    await promoteNext(jobId, jobCapacity, tx);
  }

  return decayed;
}

export const ACKNOWLEDGE_WINDOW_SECONDS = ACKNOWLEDGE_WINDOW_MS / 1000;
