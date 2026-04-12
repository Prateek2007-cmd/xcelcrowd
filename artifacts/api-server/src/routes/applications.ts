import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  applicationsTable,
  applicantsTable,
  jobsTable,
  queuePositionsTable,
  auditLogsTable,
} from "@workspace/db";
import {
  ApplyToJobBody,
  WithdrawApplicationBody,
  AcknowledgePromotionBody,
} from "@workspace/api-zod";
import {
  getActiveCount,
  promoteNext,
  checkAndDecayExpiredAcknowledgments,
  applyPenaltyAndRequeue,
} from "../services/pipeline";
import { logger } from "../lib/logger";
import { asc } from "drizzle-orm";

const router: IRouter = Router();

router.post("/apply", async (req, res): Promise<void> => {
  const parsed = ApplyToJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { applicantId, jobId } = parsed.data;

  const [applicant] = await db
    .select()
    .from(applicantsTable)
    .where(eq(applicantsTable.id, applicantId));

  if (!applicant) {
    res.status(400).json({ error: "Applicant not found" });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));

  if (!job) {
    res.status(400).json({ error: "Job not found" });
    return;
  }

  const existingApps = await db
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.applicantId, applicantId),
        eq(applicationsTable.jobId, jobId)
      )
    );

  const activeApp = existingApps.find(
    (a) => a.status !== "INACTIVE"
  );

  if (activeApp) {
    res.status(409).json({ error: "Applicant already has an active application for this job" });
    return;
  }

  await checkAndDecayExpiredAcknowledgments(jobId, job.capacity);

  let finalStatus: "ACTIVE" | "WAITLIST" = "WAITLIST";
  let queuePosition: number | null = null;

  await db.transaction(async (tx) => {
    const activeCount = await getActiveCount(jobId);

    if (activeCount < job.capacity) {
      finalStatus = "ACTIVE";
    }

    const [newApp] = await tx
      .insert(applicationsTable)
      .values({
        jobId,
        applicantId,
        status: finalStatus,
      })
      .returning();

    await tx.insert(auditLogsTable).values({
      applicationId: newApp.id,
      eventType: "APPLIED",
      fromStatus: null,
      toStatus: finalStatus,
      metadata: { jobId, applicantId },
    });

    if (finalStatus === "WAITLIST") {
      const [lastRow] = await tx
        .select({ maxPos: sql<number>`MAX(${queuePositionsTable.position})` })
        .from(queuePositionsTable)
        .where(eq(queuePositionsTable.jobId, jobId));

      queuePosition = Number(lastRow?.maxPos ?? 0) + 1;

      await tx.insert(queuePositionsTable).values({
        jobId,
        applicationId: newApp.id,
        position: queuePosition,
      });
    }

    res.status(201).json({
      applicationId: newApp.id,
      applicantId,
      jobId,
      status: finalStatus,
      queuePosition,
      message:
        finalStatus === "ACTIVE"
          ? "You have been placed in an active slot."
          : `You have been added to the waitlist at position ${queuePosition}.`,
    });
  });
});

router.post("/withdraw", async (req, res): Promise<void> => {
  const parsed = WithdrawApplicationBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { applicationId } = parsed.data;

  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));

  if (!app) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  if (app.status === "INACTIVE") {
    res.status(400).json({ error: "Application is already inactive" });
    return;
  }

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, app.jobId));

  if (!job) {
    res.status(400).json({ error: "Job not found" });
    return;
  }

  const wasActive = app.status === "ACTIVE" || app.status === "PENDING_ACKNOWLEDGMENT";

  await db.transaction(async (tx) => {
    await tx
      .update(applicationsTable)
      .set({
        status: "INACTIVE",
        withdrawnAt: new Date(),
      })
      .where(eq(applicationsTable.id, applicationId));

    await tx
      .delete(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, applicationId));

    await tx.insert(auditLogsTable).values({
      applicationId,
      eventType: "WITHDRAWN",
      fromStatus: app.status,
      toStatus: "INACTIVE",
      metadata: { jobId: app.jobId },
    });

    if (wasActive) {
      await promoteNext(app.jobId, job.capacity, tx);
    }
  });

  res.json({
    applicationId,
    applicantId: app.applicantId,
    jobId: app.jobId,
    status: "INACTIVE",
    queuePosition: null,
    message: "Application withdrawn successfully.",
  });
});

router.post("/acknowledge", async (req, res): Promise<void> => {
  const parsed = AcknowledgePromotionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { applicationId } = parsed.data;

  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));

  if (!app) {
    res.status(404).json({ error: "Application not found" });
    return;
  }

  if (app.status !== "PENDING_ACKNOWLEDGMENT") {
    res.status(400).json({ error: "Application is not pending acknowledgment" });
    return;
  }

  const now = new Date();
  if (app.acknowledgeDeadline && app.acknowledgeDeadline < now) {
    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, app.jobId));

    if (job) {
      await applyPenaltyAndRequeue(applicationId, app.jobId);
      await promoteNext(app.jobId, job.capacity);
    }

    res.status(400).json({
      error: "Acknowledgment window has expired. You have been returned to the waitlist with a penalty.",
    });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(applicationsTable)
      .set({
        status: "ACTIVE",
        acknowledgedAt: now,
        acknowledgeDeadline: null,
      })
      .where(eq(applicationsTable.id, applicationId));

    await tx.insert(auditLogsTable).values({
      applicationId,
      eventType: "ACKNOWLEDGED",
      fromStatus: "PENDING_ACKNOWLEDGMENT",
      toStatus: "ACTIVE",
      metadata: { jobId: app.jobId, acknowledgedAt: now.toISOString() },
    });
  });

  res.json({
    applicationId,
    applicantId: app.applicantId,
    jobId: app.jobId,
    status: "ACTIVE",
    queuePosition: null,
    message: "Promotion acknowledged. You are now ACTIVE.",
  });
});

export default router;
