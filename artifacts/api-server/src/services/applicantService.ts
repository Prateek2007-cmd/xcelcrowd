/**
 * Applicant Service — registry, status, and timeline logic.
 *
 * All database interaction for applicant-related routes lives here.
 * Routes call these functions and never touch the DB directly.
 */
import { db } from "@workspace/db";
import {
  applicantsTable,
  applicationsTable,
  jobsTable,
  queuePositionsTable,
  auditLogsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { NotFoundError, ConflictError } from "../lib/errors";

// ── Result types ────────────────────────────────────────────────────

export interface ApplicantItem {
  id: number;
  name: string;
  email: string;
  createdAt: string;
}

export interface ApplicantStatusEntry {
  applicationId: number;
  jobId: number;
  jobTitle: string;
  status: string;
  queuePosition: number | null;
  appliedAt: string;
  promotedAt: string | null;
  acknowledgeDeadline: string | null;
  timeInCurrentStateSeconds: number;
}

export interface ApplicantStatusResult {
  applicantId: number;
  applicantName: string;
  applicantEmail: string;
  applications: ApplicantStatusEntry[];
}

export interface TimelineEntry {
  id: number;
  applicationId: number;
  eventType: string;
  fromStatus: string | null;
  toStatus: string;
  metadata: unknown;
  createdAt: string;
}

// ── Service functions ───────────────────────────────────────────────

/** List all applicants ordered by registration date. */
export async function listApplicants(): Promise<ApplicantItem[]> {
  const applicants = await db
    .select()
    .from(applicantsTable)
    .orderBy(applicantsTable.createdAt);

  return applicants.map((a) => ({
    id: a.id,
    name: a.name,
    email: a.email,
    createdAt: a.createdAt.toISOString(),
  }));
}

/**
 * Register a new applicant.
 * Email uniqueness is enforced here rather than relying solely on DB constraints,
 * so we can return a descriptive ConflictError with correct HTTP semantics.
 */
export async function createApplicant(
  name: string,
  email: string
): Promise<ApplicantItem> {
  const existing = await db
    .select()
    .from(applicantsTable)
    .where(eq(applicantsTable.email, email));

  if (existing.length > 0) {
    throw new ConflictError("An applicant with this email already exists");
  }

  const [applicant] = await db
    .insert(applicantsTable)
    .values({ name, email })
    .returning();

  return {
    id: applicant.id,
    name: applicant.name,
    email: applicant.email,
    createdAt: applicant.createdAt.toISOString(),
  };
}

/** Fetch a single applicant by id. */
export async function getApplicant(applicantId: number): Promise<ApplicantItem> {
  const [applicant] = await db
    .select()
    .from(applicantsTable)
    .where(eq(applicantsTable.id, applicantId));

  if (!applicant) {
    throw new NotFoundError("Applicant", applicantId);
  }

  return {
    id: applicant.id,
    name: applicant.name,
    email: applicant.email,
    createdAt: applicant.createdAt.toISOString(),
  };
}

/**
 * Return all active applications for an applicant across all jobs.
 *
 * Single JOIN + leftJoin pulls all application state in one query.
 * timeInCurrentStateSeconds is derived in memory from updatedAt to avoid
 * a NOW()-based SQL expression that would differ per row during aggregation.
 */
export async function getApplicantStatus(
  applicantId: number
): Promise<ApplicantStatusResult> {
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

  return {
    applicantId: applicant.id,
    applicantName: applicant.name,
    applicantEmail: applicant.email,
    applications: applications.map((a) => ({
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
    })),
  };
}

/**
 * Return a chronological audit log for all of an applicant's applications.
 *
 * Fetches application ids first, then bulk-fetches logs with inArray —
 * one query regardless of how many applications the applicant has.
 */
export async function getApplicantTimeline(
  applicantId: number
): Promise<TimelineEntry[]> {
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
    return [];
  }

  const appIds = apps.map((a) => a.id);
  const logs = await db
    .select()
    .from(auditLogsTable)
    .where(inArray(auditLogsTable.applicationId, appIds))
    .orderBy(auditLogsTable.createdAt);

  return logs.map((l) => ({
    id: l.id,
    applicationId: l.applicationId,
    eventType: l.eventType,
    fromStatus: l.fromStatus ?? null,
    toStatus: l.toStatus,
    metadata: l.metadata ?? null,
    createdAt: l.createdAt.toISOString(),
  }));
}
