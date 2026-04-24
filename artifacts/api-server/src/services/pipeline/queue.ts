/**
 * Queue operations — enqueue, dequeue, reindex, count, next-in-queue.
 */
import { db } from "@workspace/db";
import { applicationsTable, queuePositionsTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import type { TxHandle } from "./types";

/**
 * Count ACTIVE + PENDING_ACKNOWLEDGMENT applications for a job.
 * Uses FOR UPDATE to acquire exclusive row locks (concurrency-safe).
 * MUST be called inside an open transaction.
 */
export async function getActiveCount(
  jobId: number,
  tx: TxHandle = db
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
 * Fetch the next N waitlisted candidates, ordered by queue position.
 * Uses FOR UPDATE SKIP LOCKED to prevent deadlocks.
 */
export async function getNextCandidates(
  jobId: number,
  limit: number,
  tx: TxHandle = db
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
 */
export async function getNextInQueue(
  jobId: number,
  tx: TxHandle = db
): Promise<{ applicationId: number; position: number } | null> {
  const rows = await getNextCandidates(jobId, 1, tx);
  return rows[0] ?? null;
}

/**
 * Renumber all queue positions to eliminate gaps.
 * Uses a single UPDATE … FROM CTE with ROW_NUMBER() — O(1) round trips.
 */
export async function reindexQueue(jobId: number, tx: TxHandle = db): Promise<void> {
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
