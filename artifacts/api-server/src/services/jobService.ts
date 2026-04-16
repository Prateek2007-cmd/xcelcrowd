/**
 * Job Service — CRUD and query logic for jobs.
 *
 * All database interaction for job-related routes lives here.
 * Routes call these functions and never touch the DB directly.
 */
import { db } from "@workspace/db";
import {
  jobsTable,
  applicantsTable,
  applicationsTable,
  queuePositionsTable,
} from "@workspace/db";
import { and, eq, sql } from "drizzle-orm";
import { NotFoundError } from "../lib/errors";

// ── Result types ────────────────────────────────────────────────────

export interface JobListItem {
  id: number;
  title: string;
  description: string | null;
  capacity: number;
  activeCount: number;
  waitlistCount: number;
  createdAt: string;
}

export interface JobDetailApplicant {
  applicationId: number;
  applicantId: number;
  applicantName: string;
  applicantEmail: string;
  status: string;
  queuePosition: number | null;
  appliedAt: string;
  promotedAt: string | null;
  acknowledgeDeadline: string | null;
}

export interface JobDetailResult {
  id: number;
  title: string;
  description: string | null;
  capacity: number;
  activeApplicants: JobDetailApplicant[];
  waitlistApplicants: JobDetailApplicant[];
  createdAt: string;
}

// ── Service functions ───────────────────────────────────────────────

/**
 * List all jobs with per-job active/waitlist counts.
 *
 * Uses a single LEFT JOIN + GROUP BY instead of a per-job COUNT query,
 * eliminating the N+1 pattern from the previous loop-based approach.
 * FILTER (WHERE ...) avoids separate subqueries per status.
 */
export async function listJobs(): Promise<JobListItem[]> {
  const rows = await db
    .select({
      id: jobsTable.id,
      title: jobsTable.title,
      description: jobsTable.description,
      capacity: jobsTable.capacity,
      createdAt: jobsTable.createdAt,
      /**
 * Uses single aggregated query (LEFT JOIN + GROUP BY)
 * to avoid N+1 queries when listing jobs with counts.
 */
      activeCount: sql<number>`
  COUNT(${applicationsTable.id}) FILTER (
    WHERE ${applicationsTable.status} IN ('ACTIVE', 'PENDING_ACKNOWLEDGMENT')
  )
`,
      waitlistCount: sql<number>`
  COUNT(${applicationsTable.id}) FILTER (
    WHERE ${applicationsTable.status} = 'WAITLIST'
  )
`,
    })
    .from(jobsTable)
    .leftJoin(applicationsTable, eq(applicationsTable.jobId, jobsTable.id))
    .groupBy(jobsTable.id)
    .orderBy(jobsTable.createdAt);

  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    capacity: row.capacity,
    activeCount: Number(row.activeCount ?? 0),
    waitlistCount: Number(row.waitlistCount ?? 0),
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Create a new job and return it as a JobListItem with zero counts.
 * New jobs start empty, so counts are always 0.
 */
export async function createJob(data: {
  title: string;
  description?: string | null;
  capacity: number;
}): Promise<JobListItem> {
  const [job] = await db
    .insert(jobsTable)
    .values({
      title: data.title,
      description: data.description ?? null,
      capacity: data.capacity,
    })
    .returning();

  return {
    id: job.id,
    title: job.title,
    description: job.description ?? null,
    capacity: job.capacity,
    activeCount: 0,
    waitlistCount: 0,
    createdAt: job.createdAt.toISOString(),
  };
}

/**
 * Fetch a job's full detail including all applicants.
 *
 * Single JOIN query pulls actives and waitlisted applicants together;
 * the in-memory split avoids a second round-trip for separate status queries.
 */
export async function getJobDetail(jobId: number): Promise<JobDetailResult> {
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));

  if (!job) {
    throw new NotFoundError("Job", jobId);
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

  const activeApplicants: JobDetailApplicant[] = applications
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

  const waitlistApplicants: JobDetailApplicant[] = applications
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

  return {
    id: job.id,
    title: job.title,
    description: job.description ?? null,
    capacity: job.capacity,
    activeApplicants,
    waitlistApplicants,
    createdAt: job.createdAt.toISOString(),
  };
}
