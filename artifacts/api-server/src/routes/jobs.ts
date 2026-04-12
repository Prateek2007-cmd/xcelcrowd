import { Router, type IRouter } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  jobsTable,
  applicantsTable,
  applicationsTable,
  queuePositionsTable,
} from "@workspace/db";
import {
  CreateJobBody,
  GetJobParams,
  ListJobsResponseItem,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/jobs", async (_req, res): Promise<void> => {
  const jobs = await db.select().from(jobsTable).orderBy(jobsTable.createdAt);

  const result = await Promise.all(
    jobs.map(async (job) => {
      const [counts] = await db
        .select({
          activeCount: sql<number>`COUNT(*) FILTER (WHERE ${applicationsTable.status} IN ('ACTIVE', 'PENDING_ACKNOWLEDGMENT'))`,
          waitlistCount: sql<number>`COUNT(*) FILTER (WHERE ${applicationsTable.status} = 'WAITLIST')`,
        })
        .from(applicationsTable)
        .where(eq(applicationsTable.jobId, job.id));

      return ListJobsResponseItem.parse({
        id: job.id,
        title: job.title,
        description: job.description ?? null,
        capacity: job.capacity,
        activeCount: Number(counts?.activeCount ?? 0),
        waitlistCount: Number(counts?.waitlistCount ?? 0),
        createdAt: job.createdAt.toISOString(),
      });
    })
  );

  res.json(result);
});

router.post("/jobs", async (req, res): Promise<void> => {
  const parsed = CreateJobBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const [job] = await db
    .insert(jobsTable)
    .values({
      title: parsed.data.title,
      description: parsed.data.description ?? null,
      capacity: parsed.data.capacity,
    })
    .returning();

  res.status(201).json(
    ListJobsResponseItem.parse({
      id: job.id,
      title: job.title,
      description: job.description ?? null,
      capacity: job.capacity,
      activeCount: 0,
      waitlistCount: 0,
      createdAt: job.createdAt.toISOString(),
    })
  );
});

router.get("/jobs/:jobId", async (req, res): Promise<void> => {
  const params = GetJobParams.safeParse(req.params);
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

  const applications = await db
    .select({
      applicationId: applicationsTable.id,
      applicantId: applicationsTable.applicantId,
      applicantName: applicantsTable.name,
      applicantEmail: applicantsTable.email,
      status: applicationsTable.status,
      appliedAt: applicationsTable.createdAt,
      promotedAt: applicationsTable.promotedAt,
      acknowledgeDeadline: applicationsTable.acknowledgeDeadline,
      position: queuePositionsTable.position,
    })
    .from(applicationsTable)
    .innerJoin(applicantsTable, eq(applicationsTable.applicantId, applicantsTable.id))
    .leftJoin(
      queuePositionsTable,
      and(
        eq(queuePositionsTable.applicationId, applicationsTable.id),
        eq(queuePositionsTable.jobId, job.id)
      )
    )
    .where(eq(applicationsTable.jobId, job.id));

  const active = applications
    .filter((a) => a.status === "ACTIVE" || a.status === "PENDING_ACKNOWLEDGMENT")
    .map((a) => ({
      applicationId: a.applicationId,
      applicantId: a.applicantId,
      applicantName: a.applicantName,
      applicantEmail: a.applicantEmail,
      status: a.status,
      queuePosition: null,
      appliedAt: a.appliedAt.toISOString(),
      promotedAt: a.promotedAt?.toISOString() ?? null,
      acknowledgeDeadline: a.acknowledgeDeadline?.toISOString() ?? null,
    }));

  const waitlist = applications
    .filter((a) => a.status === "WAITLIST")
    .sort((a, b) => (a.position ?? 9999) - (b.position ?? 9999))
    .map((a) => ({
      applicationId: a.applicationId,
      applicantId: a.applicantId,
      applicantName: a.applicantName,
      applicantEmail: a.applicantEmail,
      status: a.status,
      queuePosition: a.position ?? null,
      appliedAt: a.appliedAt.toISOString(),
      promotedAt: a.promotedAt?.toISOString() ?? null,
      acknowledgeDeadline: null,
    }));

  res.json({
    id: job.id,
    title: job.title,
    description: job.description ?? null,
    capacity: job.capacity,
    activeApplicants: active,
    waitlistApplicants: waitlist,
    createdAt: job.createdAt.toISOString(),
  });
});

export default router;
