/**
 * Pipeline snapshot and audit-log replay — read-only query modules.
 */
import { db } from "@workspace/db";
import {
  applicationsTable,
  queuePositionsTable,
  auditLogsTable,
  applicantsTable,
} from "@workspace/db";
import { eq, and, lte } from "drizzle-orm";

/**
 * Get the current pipeline state for a job — O(1) snapshot.
 * Reads DIRECTLY from applications + queue_positions tables.
 */
export async function getPipelineSnapshot(
  jobId: number
): Promise<{
  jobId: number;
  asOf: string;
  activeApplicants: Array<{
    applicationId: number;
    applicantId: number;
    applicantName: string;
    status: string;
  }>;
  waitlistApplicants: Array<{
    applicationId: number;
    applicantId: number;
    applicantName: string;
    status: string;
    queuePosition: number | null;
  }>;
}> {
  const rows = await db
    .select({
      applicationId: applicationsTable.id,
      applicantId: applicantsTable.id,
      applicantName: applicantsTable.name,
      status: applicationsTable.status,
      queuePosition: queuePositionsTable.position,
    })
    .from(applicationsTable)
    .innerJoin(applicantsTable, eq(applicationsTable.applicantId, applicantsTable.id))
    .leftJoin(queuePositionsTable, eq(queuePositionsTable.applicationId, applicationsTable.id))
    .where(eq(applicationsTable.jobId, jobId));

  const activeApplicants: Array<{ applicationId: number; applicantId: number; applicantName: string; status: string }> = [];
  const waitlistApplicants: Array<{ applicationId: number; applicantId: number; applicantName: string; status: string; queuePosition: number | null }> = [];

  for (const row of rows) {
    if (row.status === "ACTIVE" || row.status === "PENDING_ACKNOWLEDGMENT") {
      activeApplicants.push({ applicationId: row.applicationId, applicantId: row.applicantId, applicantName: row.applicantName, status: row.status });
    } else if (row.status === "WAITLIST") {
      waitlistApplicants.push({ applicationId: row.applicationId, applicantId: row.applicantId, applicantName: row.applicantName, status: row.status, queuePosition: row.queuePosition ?? null });
    }
  }

  waitlistApplicants.sort((a, b) => (a.queuePosition ?? 9999) - (b.queuePosition ?? 9999));

  return { jobId, asOf: new Date().toISOString(), activeApplicants, waitlistApplicants };
}

/**
 * Replay the pipeline state at a HISTORICAL point in time.
 * ⚠️ ADMIN/DEBUG ONLY — O(n) in audit log entries.
 */
export async function replayPipelineFromAuditLog(
  jobId: number,
  asOf: Date = new Date()
): Promise<{
  jobId: number;
  asOf: string;
  activeApplicants: Array<{ applicationId: number; applicantId: number; applicantName: string; status: string }>;
  waitlistApplicants: Array<{ applicationId: number; applicantId: number; applicantName: string; status: string }>;
  events: Array<{ id: number; applicationId: number; eventType: string; fromStatus: string | null; toStatus: string; metadata: unknown; createdAt: string }>;
}> {
  const apps = await db
    .select({ applicationId: applicationsTable.id, applicantId: applicantsTable.id, applicantName: applicantsTable.name })
    .from(applicationsTable)
    .innerJoin(applicantsTable, eq(applicationsTable.applicantId, applicantsTable.id))
    .where(and(eq(applicationsTable.jobId, jobId), lte(applicationsTable.createdAt, asOf)));

  const replayState = new Map<number, string>();
  for (const app of apps) replayState.set(app.applicationId, "APPLIED");

  const logs = await db
    .select()
    .from(auditLogsTable)
    .innerJoin(applicationsTable, eq(auditLogsTable.applicationId, applicationsTable.id))
    .where(and(eq(applicationsTable.jobId, jobId), lte(auditLogsTable.createdAt, asOf)))
    .orderBy(auditLogsTable.createdAt);

  for (const log of logs) replayState.set(log.audit_logs.applicationId, log.audit_logs.toStatus);

  const appMap = new Map(apps.map((a) => [a.applicationId, a]));
  const activeApplicants: Array<{ applicationId: number; applicantId: number; applicantName: string; status: string }> = [];
  const waitlistApplicants: Array<{ applicationId: number; applicantId: number; applicantName: string; status: string }> = [];

  for (const [applicationId, status] of replayState.entries()) {
    const app = appMap.get(applicationId);
    if (!app) continue;
    const entry = { applicationId, applicantId: app.applicantId, applicantName: app.applicantName, status };
    if (status === "ACTIVE" || status === "PENDING_ACKNOWLEDGMENT") activeApplicants.push(entry);
    else if (status === "WAITLIST") waitlistApplicants.push(entry);
  }

  const events = logs.map((l) => ({
    id: l.audit_logs.id, applicationId: l.audit_logs.applicationId, eventType: l.audit_logs.eventType,
    fromStatus: l.audit_logs.fromStatus ?? null, toStatus: l.audit_logs.toStatus,
    metadata: l.audit_logs.metadata ?? null, createdAt: l.audit_logs.createdAt.toISOString(),
  }));

  return { jobId, asOf: asOf.toISOString(), activeApplicants, waitlistApplicants, events };
}
