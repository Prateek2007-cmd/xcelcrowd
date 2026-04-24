/**
 * Application creation logic — applyToJob and applyPublic.
 */
import { db } from "@workspace/db";
import {
  applicationsTable,
  applicantsTable,
  jobsTable,
  queuePositionsTable,
  auditLogsTable,
  type ApplicationStatus,
} from "@workspace/db";
import { eq, and, sql } from "drizzle-orm";
import {
  NotFoundError,
  DuplicateSubmissionError,
  DatabaseError,
} from "../../lib/errors";
import {
  isError,
  formatErrorMessage,
  classifyDbErrorOrDefault,
} from "../../lib/errorUtils";
import { mapDbError, DbErrorType } from "../../lib/dbErrorMapper";
import {
  getActiveCount,
  checkAndDecayExpiredAcknowledgments,
} from "../pipeline";
import { logger } from "../../lib/logger";
import type { ApplyResult, ApplicationCoreResult } from "./types";

/**
 * INTERNAL: Shared application creation logic.
 * Must be called inside an open transaction.
 */
async function createApplicationCore(
  tx: typeof db,
  applicantId: number,
  jobId: number,
  job: { id: number; capacity: number }
): Promise<ApplicationCoreResult> {
  // Step 1: Check for duplicate active application
  const existingApps = await tx
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.applicantId, applicantId),
        eq(applicationsTable.jobId, jobId)
      )
    );

  const activeApp = existingApps.find((a) => a.status !== "INACTIVE");
  if (activeApp) {
    throw new DuplicateSubmissionError(applicantId, jobId);
  }

  // Step 2: Run decay check and get active count
  await checkAndDecayExpiredAcknowledgments(jobId, job.capacity, tx as any);
  const activeCount = await getActiveCount(jobId, tx as any);

  // Step 3: Insert application as WAITLIST
  const [newApp] = await tx
    .insert(applicationsTable)
    .values({ jobId, applicantId, status: "WAITLIST" })
    .returning();

  // Step 4: Insert initial audit log
  await tx.insert(auditLogsTable).values({
    applicationId: newApp.id,
    eventType: "APPLIED",
    fromStatus: null,
    toStatus: "WAITLIST",
    metadata: { jobId, applicantId },
  });

  // Step 5: Determine final status and queue position
  let finalStatus: ApplicationStatus = "WAITLIST";
  let queuePosition: number | null = null;

  if (activeCount < job.capacity) {
    const deadline = new Date(Date.now() + 10 * 60 * 1000);

    await tx
      .update(applicationsTable)
      .set({
        status: "PENDING_ACKNOWLEDGMENT",
        promotedAt: new Date(),
        acknowledgeDeadline: deadline,
      })
      .where(eq(applicationsTable.id, newApp.id));

    await tx.insert(auditLogsTable).values({
      applicationId: newApp.id,
      eventType: "PROMOTED",
      fromStatus: "WAITLIST",
      toStatus: "PENDING_ACKNOWLEDGMENT",
      metadata: { acknowledgeDeadline: deadline.toISOString(), jobId },
    });

    finalStatus = "PENDING_ACKNOWLEDGMENT";
  } else {
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

  return { applicationId: newApp.id, status: finalStatus, queuePosition };
}

/**
 * Apply an applicant (authenticated user) to a job.
 */
export async function applyToJob(applicantId: number, jobId: number): Promise<ApplyResult> {
  const [applicant] = await db
    .select()
    .from(applicantsTable)
    .where(eq(applicantsTable.id, applicantId));

  if (!applicant) throw new NotFoundError("Applicant", applicantId);

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));

  if (!job) throw new NotFoundError("Job", jobId);

  const coreResult = await db.transaction(async (tx) => {
    return createApplicationCore(tx, applicantId, jobId, job);
  });

  return {
    applicationId: coreResult.applicationId,
    applicantId,
    jobId,
    status: coreResult.status,
    queuePosition: coreResult.queuePosition,
    message:
      coreResult.status === "PENDING_ACKNOWLEDGMENT"
        ? "You've been promoted! Please accept this offer within 10 minutes."
        : `You have been added to the waitlist at position ${coreResult.queuePosition}.`,
  };
}

/**
 * Public apply flow: resolve applicant + create application atomically.
 */
export async function applyPublic(
  name: string,
  email: string,
  jobId: number
): Promise<ApplyResult> {
  let applicantId: number;

  try {
    const [created] = await db
      .insert(applicantsTable)
      .values({ name, email })
      .returning();
    applicantId = created.id;
  } catch (err: unknown) {
    if (err instanceof DatabaseError) throw err;

    const dbErr = mapDbError(err);
    const errorMessage = formatErrorMessage(err);

    if (dbErr?.type === DbErrorType.UNIQUE_VIOLATION) {
      try {
        const existing = await db
          .select()
          .from(applicantsTable)
          .where(eq(applicantsTable.email, email))
          .limit(1);

        if (!existing || existing.length === 0) {
          logger.error(
            { errorType: dbErr.type, email, rawCode: dbErr.rawCode },
            "Duplicate email constraint failed: applicant not found after detecting constraint"
          );
          throw new DatabaseError(
            "Applicant exists (duplicate email constraint) but could not be fetched from database"
          );
        }

        applicantId = existing[0].id;
        logger.debug(
          { email, applicantId, action: "applicant_reuse" },
          "Duplicate applicant detected, reusing existing applicant"
        );
      } catch (fetchErr: unknown) {
        throw classifyDbErrorOrDefault(
          fetchErr,
          "Failed to fetch existing applicant after detecting duplicate email"
        );
      }
    } else {
      logger.error(
        {
          errorType: dbErr?.type || "unknown",
          rawCode: dbErr?.rawCode,
          errorMessage,
          email,
          errorClass: isError(err) ? err.constructor.name : typeof err,
        },
        "Unknown database error during applicant creation or resolution"
      );
      throw classifyDbErrorOrDefault(err, "Failed to create or resolve applicant");
    }
  }

  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  if (!job) throw new NotFoundError("Job", jobId);

  const coreResult = await db.transaction(async (tx) => {
    return createApplicationCore(tx, applicantId, jobId, job);
  });

  return {
    applicationId: coreResult.applicationId,
    applicantId,
    jobId,
    status: coreResult.status,
    queuePosition: coreResult.queuePosition,
    message:
      coreResult.status === "PENDING_ACKNOWLEDGMENT"
        ? "You've been promoted! Please accept this offer within 10 minutes."
        : `You have been added to the waitlist at position ${coreResult.queuePosition}.`,
  };
}
