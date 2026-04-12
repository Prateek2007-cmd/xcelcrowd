import { Router, type IRouter } from "express";
import { eq, sql, and, lte } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  applicationsTable,
  queuePositionsTable,
  auditLogsTable,
  applicantsTable,
} from "@workspace/db";
import {
  GetPipelineSummaryParams,
  GetJobQueueParams,
  ReplayPipelineParams,
  ReplayPipelineQueryParams,
} from "@workspace/api-zod";
import { checkAndDecayExpiredAcknowledgments } from "../services/pipeline";

const router: IRouter = Router();

router.get("/queue/:jobId", async (req, res): Promise<void> => {
  const params = GetJobQueueParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.jobId));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  await checkAndDecayExpiredAcknowledgments(job.id, job.capacity);

  const queue = await db
    .select({
      applicationId: queuePositionsTable.applicationId,
      applicantId: applicantsTable.id,
      applicantName: applicantsTable.name,
      position: queuePositionsTable.position,
      appliedAt: applicationsTable.createdAt,
      penaltyCount: applicationsTable.penaltyCount,
    })
    .from(queuePositionsTable)
    .innerJoin(
      applicationsTable,
      eq(queuePositionsTable.applicationId, applicationsTable.id)
    )
    .innerJoin(
      applicantsTable,
      eq(applicationsTable.applicantId, applicantsTable.id)
    )
    .where(eq(queuePositionsTable.jobId, job.id))
    .orderBy(queuePositionsTable.position);

  const [counts] = await db
    .select({
      activeCount: sql<number>`COUNT(*) FILTER (WHERE ${applicationsTable.status} IN ('ACTIVE', 'PENDING_ACKNOWLEDGMENT'))`,
    })
    .from(applicationsTable)
    .where(eq(applicationsTable.jobId, job.id));

  res.json({
    jobId: job.id,
    jobTitle: job.title,
    capacity: job.capacity,
    activeCount: Number(counts?.activeCount ?? 0),
    waitlistEntries: queue.map((q) => ({
      applicationId: q.applicationId,
      applicantId: q.applicantId,
      applicantName: q.applicantName,
      position: q.position,
      appliedAt: q.appliedAt.toISOString(),
      penaltyCount: q.penaltyCount,
    })),
  });
});

router.get("/pipeline/:jobId/summary", async (req, res): Promise<void> => {
  const params = GetPipelineSummaryParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.jobId));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const [counts] = await db
    .select({
      activeCount: sql<number>`COUNT(*) FILTER (WHERE ${applicationsTable.status} IN ('ACTIVE', 'PENDING_ACKNOWLEDGMENT'))`,
      waitlistCount: sql<number>`COUNT(*) FILTER (WHERE ${applicationsTable.status} = 'WAITLIST')`,
      inactiveCount: sql<number>`COUNT(*) FILTER (WHERE ${applicationsTable.status} = 'INACTIVE')`,
      totalApplications: sql<number>`COUNT(*)`,
    })
    .from(applicationsTable)
    .where(eq(applicationsTable.jobId, job.id));

  const [promotedApps] = await db
    .select({
      avgTimeToPromotion: sql<number | null>`
        AVG(EXTRACT(EPOCH FROM (${applicationsTable.promotedAt} - ${applicationsTable.createdAt})))
        FILTER (WHERE ${applicationsTable.promotedAt} IS NOT NULL)
      `,
      avgAckTime: sql<number | null>`
        AVG(EXTRACT(EPOCH FROM (${applicationsTable.acknowledgedAt} - ${applicationsTable.promotedAt})))
        FILTER (WHERE ${applicationsTable.acknowledgedAt} IS NOT NULL AND ${applicationsTable.promotedAt} IS NOT NULL)
      `,
    })
    .from(applicationsTable)
    .where(eq(applicationsTable.jobId, job.id));

  const [decayRow] = await db
    .select({
      decayCount: sql<number>`COUNT(*)`,
    })
    .from(auditLogsTable)
    .innerJoin(
      applicationsTable,
      eq(auditLogsTable.applicationId, applicationsTable.id)
    )
    .where(
      and(
        eq(applicationsTable.jobId, job.id),
        eq(auditLogsTable.eventType, "DECAY_TRIGGERED")
      )
    );

  res.json({
    jobId: job.id,
    jobTitle: job.title,
    capacity: job.capacity,
    activeCount: Number(counts?.activeCount ?? 0),
    waitlistCount: Number(counts?.waitlistCount ?? 0),
    inactiveCount: Number(counts?.inactiveCount ?? 0),
    totalApplications: Number(counts?.totalApplications ?? 0),
    avgTimeToPromotionSeconds:
      promotedApps?.avgTimeToPromotion != null
        ? Number(promotedApps.avgTimeToPromotion)
        : null,
    avgAcknowledgmentTimeSeconds:
      promotedApps?.avgAckTime != null ? Number(promotedApps.avgAckTime) : null,
    decayEvents: Number(decayRow?.decayCount ?? 0),
  });
});

router.get("/pipeline/:jobId/replay", async (req, res): Promise<void> => {
  const params = ReplayPipelineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const queryParsed = ReplayPipelineQueryParams.safeParse(req.query);
  if (!queryParsed.success) {
    res.status(400).json({ error: queryParsed.error.message });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, params.data.jobId));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const asOf = queryParsed.data.asOf ? new Date(queryParsed.data.asOf) : new Date();

  const apps = await db
    .select({
      applicationId: applicationsTable.id,
      applicantId: applicantsTable.id,
      applicantName: applicantsTable.name,
    })
    .from(applicationsTable)
    .innerJoin(
      applicantsTable,
      eq(applicationsTable.applicantId, applicantsTable.id)
    )
    .where(
      and(
        eq(applicationsTable.jobId, job.id),
        lte(applicationsTable.createdAt, asOf)
      )
    );

  const replayState = new Map<number, string>();

  for (const app of apps) {
    replayState.set(app.applicationId, "APPLIED");
  }

  const logs = await db
    .select()
    .from(auditLogsTable)
    .innerJoin(
      applicationsTable,
      eq(auditLogsTable.applicationId, applicationsTable.id)
    )
    .where(
      and(
        eq(applicationsTable.jobId, job.id),
        lte(auditLogsTable.createdAt, asOf)
      )
    )
    .orderBy(auditLogsTable.createdAt);

  for (const log of logs) {
    replayState.set(log.audit_logs.applicationId, log.audit_logs.toStatus);
  }

  const appMap = new Map(apps.map((a) => [a.applicationId, a]));

  const activeApplicants: {
    applicationId: number;
    applicantId: number;
    applicantName: string;
    status: string;
  }[] = [];

  const waitlistApplicants: {
    applicationId: number;
    applicantId: number;
    applicantName: string;
    status: string;
  }[] = [];

  for (const [applicationId, status] of replayState.entries()) {
    const app = appMap.get(applicationId);
    if (!app) continue;

    const entry = {
      applicationId,
      applicantId: app.applicantId,
      applicantName: app.applicantName,
      status,
    };

    if (status === "ACTIVE" || status === "PENDING_ACKNOWLEDGMENT") {
      activeApplicants.push(entry);
    } else if (status === "WAITLIST") {
      waitlistApplicants.push(entry);
    }
  }

  const events = logs.map((l) => ({
    id: l.audit_logs.id,
    applicationId: l.audit_logs.applicationId,
    eventType: l.audit_logs.eventType,
    fromStatus: l.audit_logs.fromStatus ?? null,
    toStatus: l.audit_logs.toStatus,
    metadata: l.audit_logs.metadata ?? null,
    createdAt: l.audit_logs.createdAt.toISOString(),
  }));

  res.json({
    jobId: job.id,
    asOf: asOf.toISOString(),
    activeApplicants,
    waitlistApplicants,
    events,
  });
});

export default router;
