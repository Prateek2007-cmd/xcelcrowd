import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  applicantsTable,
  applicationsTable,
  jobsTable,
  queuePositionsTable,
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

router.post("/applicants", async (req, res): Promise<void> => {
  const parsed = CreateApplicantBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const existing = await db
    .select()
    .from(applicantsTable)
    .where(eq(applicantsTable.email, parsed.data.email));

  if (existing.length > 0) {
    res.status(400).json({ error: "An applicant with this email already exists" });
    return;
  }

  const [applicant] = await db
    .insert(applicantsTable)
    .values({ name: parsed.data.name, email: parsed.data.email })
    .returning();

  res.status(201).json(
    GetApplicantResponse.parse({
      id: applicant.id,
      name: applicant.name,
      email: applicant.email,
      createdAt: applicant.createdAt.toISOString(),
    })
  );
});

router.get("/applicants/:applicantId", async (req, res): Promise<void> => {
  const params = GetApplicantParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [applicant] = await db
    .select()
    .from(applicantsTable)
    .where(eq(applicantsTable.id, params.data.applicantId));

  if (!applicant) {
    res.status(404).json({ error: "Applicant not found" });
    return;
  }

  res.json(
    GetApplicantResponse.parse({
      id: applicant.id,
      name: applicant.name,
      email: applicant.email,
      createdAt: applicant.createdAt.toISOString(),
    })
  );
});

router.get("/status/:applicantId", async (req, res): Promise<void> => {
  const params = GetApplicantStatusParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [applicant] = await db
    .select()
    .from(applicantsTable)
    .where(eq(applicantsTable.id, params.data.applicantId));

  if (!applicant) {
    res.status(404).json({ error: "Applicant not found" });
    return;
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
    .where(eq(applicationsTable.applicantId, params.data.applicantId));

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
});

router.get("/timeline/:applicantId", async (req, res): Promise<void> => {
  const params = GetApplicantTimelineParams.safeParse(req.params);
  if (!params.success) {
    res.status(400).json({ error: params.error.message });
    return;
  }

  const [applicant] = await db
    .select()
    .from(applicantsTable)
    .where(eq(applicantsTable.id, params.data.applicantId));

  if (!applicant) {
    res.status(404).json({ error: "Applicant not found" });
    return;
  }

  const { auditLogsTable } = await import("@workspace/db");
  const { inArray } = await import("drizzle-orm");

  const apps = await db
    .select({ id: applicationsTable.id })
    .from(applicationsTable)
    .where(eq(applicationsTable.applicantId, params.data.applicantId));

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
});

export default router;
