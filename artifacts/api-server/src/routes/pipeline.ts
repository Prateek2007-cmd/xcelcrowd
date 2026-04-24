/**
 * Pipeline routes — queue, summary, and replay endpoints.
 * All GET routes are idempotent and side-effect free.
 * Decay is handled solely by the background worker.
 */
import { Router, type IRouter } from "express";
import { eq, sql, and } from "drizzle-orm";
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
import { validateParams, validateQuery } from "../middlewares/validate";
import { NotFoundError } from "../lib/errors";
import { getPipelineSnapshot, replayPipelineFromAuditLog } from "../services/pipeline";


const router: IRouter = Router();

router.get("/queue/:jobId", validateParams(GetJobQueueParams), async (_req, res, next): Promise<void> => {
  try {
    const { jobId } = res.locals.params;

    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));

    if (!job) {
      throw new NotFoundError("Job", jobId);
    }

    // NOTE: No decay call here — GET routes must be side-effect free.
    // Decay is handled by the background worker (decayWorker.ts).

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
  } catch (err) {
    next(err);
  }
});

router.get("/pipeline/:jobId/summary", validateParams(GetPipelineSummaryParams), async (_req, res, next): Promise<void> => {
  try {
    const { jobId } = res.locals.params;

    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, jobId));

    if (!job) {
      throw new NotFoundError("Job", jobId);
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
  } catch (err) {
    next(err);
  }
});

router.get(
  "/pipeline/:jobId/replay",
  validateParams(ReplayPipelineParams),
  validateQuery(ReplayPipelineQueryParams),
  async (_req, res, next): Promise<void> => {
    try {
      const { jobId } = res.locals.params;
      const { asOf } = res.locals.query;

      // Verify job exists before delegating to service
      const [job] = await db
        .select()
        .from(jobsTable)
        .where(eq(jobsTable.id, jobId));

      if (!job) {
        throw new NotFoundError("Job", jobId);
      }

      // O(1) snapshot for current state; O(n) audit replay only for historical queries
      if (asOf) {
        const result = await replayPipelineFromAuditLog(jobId, new Date(asOf));
        res.json(result);
      } else {
        const result = await getPipelineSnapshot(jobId);
        res.json(result);
      }
    } catch (err) {
      next(err);
    }
  }
);

export default router;
