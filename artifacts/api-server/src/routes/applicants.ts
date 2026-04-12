/**
 * Applicant routes — registry, status, and timeline endpoints.
 * All validation flows through middleware or AppError classes.
 */
import { Router, type IRouter } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  applicantsTable,
  applicationsTable,
  jobsTable,
  queuePositionsTable,
  auditLogsTable,
} from "@workspace/db";
import {
  CreateApplicantBody,
  GetApplicantParams,
  GetApplicantStatusParams,
  GetApplicantTimelineParams,
  ListApplicantsResponseItem,
  GetApplicantResponse,
  GetApplicantStatusResponse,
} from "@workspace/api-zod";
import { validateBody, validateParams } from "../middlewares/validate";
import { NotFoundError, ConflictError } from "../lib/errors";

const router: IRouter = Router();

router.get("/applicants", async (_req, res): Promise<void> => {
  const applicants = await db
    .select()
    .from(applicantsTable)
    .orderBy(applicantsTable.createdAt);

  res.json(
    applicants.map((a) =>
      ListApplicantsResponseItem.parse({
        id: a.id,
        name: a.name,
        email: a.email,
        createdAt: a.createdAt.toISOString(),
      })
    )
  );
});

router.post("/applicants", validateBody(CreateApplicantBody), async (req, res, next): Promise<void> => {
  try {
    const existing = await db
      .select()
      .from(applicantsTable)
      .where(eq(applicantsTable.email, req.body.email));

    if (existing.length > 0) {
      throw new ConflictError("An applicant with this email already exists");
    }

    const [applicant] = await db
      .insert(applicantsTable)
      .values({ name: req.body.name, email: req.body.email })
      .returning();

    res.status(201).json(
      GetApplicantResponse.parse({
        id: applicant.id,
        name: applicant.name,
        email: applicant.email,
        createdAt: applicant.createdAt.toISOString(),
      })
    );
  } catch (err) {
    next(err);
  }
});

router.get("/applicants/:applicantId", validateParams(GetApplicantParams), async (_req, res, next): Promise<void> => {
  try {
    const { applicantId } = res.locals.params;

    const [applicant] = await db
      .select()
      .from(applicantsTable)
      .where(eq(applicantsTable.id, applicantId));

    if (!applicant) {
      throw new NotFoundError("Applicant", applicantId);
    }

    res.json(
      GetApplicantResponse.parse({
        id: applicant.id,
        name: applicant.name,
        email: applicant.email,
        createdAt: applicant.createdAt.toISOString(),
      })
    );
  } catch (err) {
    next(err);
  }
});

router.get("/status/:applicantId", validateParams(GetApplicantStatusParams), async (_req, res, next): Promise<void> => {
  try {
    const { applicantId } = res.locals.params;

    const [applicant] = await db
      .select()
      .from(applicantsTable)
      .where(eq(applicantsTable.id, applicantId));

    if (!applicant) {
      throw new NotFoundError("Applicant", applicantId);
    }

    const applications = await db
      .select({
        applicationId: applicationsTable.id,
        jobId: applicationsTable.jobId,
        jobTitle: jobsTable.title,
        status: applicationsTable.status,
        appliedAt: applicationsTable.createdAt,
        promotedAt: applicationsTable.promotedAt,
        acknowledgeDeadline: applicationsTable.acknowledgeDeadline,
        updatedAt: applicationsTable.updatedAt,
        position: queuePositionsTable.position,
      })
      .from(applicationsTable)
      .innerJoin(jobsTable, eq(applicationsTable.jobId, jobsTable.id))
      .leftJoin(
        queuePositionsTable,
        eq(queuePositionsTable.applicationId, applicationsTable.id)
      )
      .where(eq(applicationsTable.applicantId, applicantId));

    const now = new Date();
    const mapped = applications.map((a) => ({
      applicationId: a.applicationId,
      jobId: a.jobId,
      jobTitle: a.jobTitle,
      status: a.status,
      queuePosition: a.position ?? null,
      appliedAt: a.appliedAt.toISOString(),
      promotedAt: a.promotedAt?.toISOString() ?? null,
      acknowledgeDeadline: a.acknowledgeDeadline?.toISOString() ?? null,
      timeInCurrentStateSeconds: Math.floor(
        (now.getTime() - a.updatedAt.getTime()) / 1000
      ),
    }));

    res.json(
      GetApplicantStatusResponse.parse({
        applicantId: applicant.id,
        applicantName: applicant.name,
        applicantEmail: applicant.email,
        applications: mapped,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.get("/timeline/:applicantId", validateParams(GetApplicantTimelineParams), async (_req, res, next): Promise<void> => {
  try {
    const { applicantId } = res.locals.params;

    const [applicant] = await db
      .select()
      .from(applicantsTable)
      .where(eq(applicantsTable.id, applicantId));

    if (!applicant) {
      throw new NotFoundError("Applicant", applicantId);
    }

    const apps = await db
      .select({ id: applicationsTable.id })
      .from(applicationsTable)
      .where(eq(applicationsTable.applicantId, applicantId));

    if (apps.length === 0) {
      res.json([]);
      return;
    }

    const appIds = apps.map((a) => a.id);
    const logs = await db
      .select()
      .from(auditLogsTable)
      .where(inArray(auditLogsTable.applicationId, appIds))
      .orderBy(auditLogsTable.createdAt);

    res.json(
      logs.map((l) => ({
        id: l.id,
        applicationId: l.applicationId,
        eventType: l.eventType,
        fromStatus: l.fromStatus ?? null,
        toStatus: l.toStatus,
        metadata: l.metadata ?? null,
        createdAt: l.createdAt.toISOString(),
      }))
    );
  } catch (err) {
    next(err);
  }
});

export default router;
