/**
 * Application Service — all business logic for apply, withdraw, acknowledge.
 *
 * Routes call these functions and never touch the DB directly.
 * Functions return new result objects (no mutation of inputs).
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
  ConflictError,
  DuplicateSubmissionError,
  GoneError,
  DatabaseError,
} from "../lib/errors";
import { assertValidTransition } from "../lib/stateMachine";
import {
  getActiveCount,
  promoteNext,
  checkAndDecayExpiredAcknowledgments,
  applyPenaltyAndRequeue,
} from "./pipeline";
import { logger } from "../lib/logger";

// ── Result types (pure data, no side effects) ──────────────────────

export interface ApplyResult {
  applicationId: number;
  applicantId: number;
  jobId: number;
  status: ApplicationStatus;
  queuePosition: number | null;
  message: string;
}

export interface WithdrawResult {
  applicationId: number;
  applicantId: number;
  jobId: number;
  status: "INACTIVE";
  queuePosition: null;
  message: string;
}

export interface AcknowledgeResult {
  applicationId: number;
  applicantId: number;
  jobId: number;
  status: "ACTIVE";
  queuePosition: null;
  message: string;
}

// ── Service functions ──────────────────────────────────────────────

/**
 * Apply an applicant to a job.
 * Returns a new ApplyResult — never mutates input.
 * 
 * IMPORTANT: All applications start as WAITLIST.
 * If capacity available, system promotes to PENDING_ACKNOWLEDGMENT (user must accept).
 * User cannot go directly to ACTIVE without clicking "Accept".
 */
export async function applyToJob(applicantId: number, jobId: number): Promise<ApplyResult> {
  // Validate applicant exists
  const [applicant] = await db
    .select()
    .from(applicantsTable)
    .where(eq(applicantsTable.id, applicantId));

  if (!applicant) {
    throw new NotFoundError("Applicant", applicantId);
  }

  // Validate job exists
  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, jobId));

  if (!job) {
    throw new NotFoundError("Job", jobId);
  }

  // Check for duplicate active application
  const existingApps = await db
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

  let newAppId = 0;
  let finalStatus: ApplicationStatus = "WAITLIST";
  let queuePosition: number | null = null;

  await db.transaction(async (tx) => {
    // Run decay inside transaction for consistency
    await checkAndDecayExpiredAcknowledgments(jobId, job.capacity, tx);

    const activeCount = await getActiveCount(jobId, tx);

    // ✅ IMPORTANT: Start as WAITLIST, never ACTIVE directly
    // All applications begin in WAITLIST status
    const [newApp] = await tx
      .insert(applicationsTable)
      .values({
        jobId,
        applicantId,
        status: "WAITLIST",  // ✅ Always start here
      })
      .returning();

    newAppId = newApp.id;

    await tx.insert(auditLogsTable).values({
      applicationId: newApp.id,
      eventType: "APPLIED",
      fromStatus: null,
      toStatus: "WAITLIST",
      metadata: { jobId, applicantId },
    });

    // ✅ If capacity available, promote to PENDING_ACKNOWLEDGMENT immediately
    // This allows the applicant dashboard to show "Accept" button
    if (activeCount < job.capacity) {
      const deadline = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

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
        metadata: {
          acknowledgeDeadline: deadline.toISOString(),
          jobId,
        },
      });

      finalStatus = "PENDING_ACKNOWLEDGMENT";
    } else {
      // No capacity — add to queue
      finalStatus = "WAITLIST";
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
  });

  // Return new result object
  return {
    applicationId: newAppId,
    applicantId,
    jobId,
    status: finalStatus,
    queuePosition,
    message:
      finalStatus === "PENDING_ACKNOWLEDGMENT"
        ? "You've been promoted! Please accept this offer within 10 minutes."
        : `You have been added to the waitlist at position ${queuePosition}.`,
  };
}

/**
 * Withdraw an application.
 * Validates transition legality via the state machine.
 * Returns a new WithdrawResult — never mutates input.
 */
export async function withdrawApplication(applicationId: number): Promise<WithdrawResult> {
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));

  if (!app) {
    throw new NotFoundError("Application", applicationId);
  }

  if (app.status === "INACTIVE") {
    throw new ConflictError("Application is already inactive");
  }

  // Validate this is a legal state transition
  assertValidTransition(app.status, "INACTIVE");

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, app.jobId));

  if (!job) {
    throw new NotFoundError("Job", app.jobId);
  }

  const wasActive = app.status === "ACTIVE" || app.status === "PENDING_ACKNOWLEDGMENT";

  await db.transaction(async (tx) => {
    await tx
      .update(applicationsTable)
      .set({
        status: "INACTIVE",
        withdrawnAt: new Date(),
        promotedAt: null,
        acknowledgeDeadline: null,
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

  logger.info({ applicationId, fromStatus: app.status }, "Application withdrawn");

  return {
    applicationId,
    applicantId: app.applicantId,
    jobId: app.jobId,
    status: "INACTIVE",
    queuePosition: null,
    message: "Application withdrawn successfully.",
  };
}

/**
 * Acknowledge a promotion within the time window.
 *
 * DESIGN: Expiry check happens BEFORE the success transaction.
 * If expired → decay + throw GoneError (no success commit ever occurs).
 * If valid → commit success → return result (no throws after commit).
 *
 * This guarantees the client response always reflects the actual committed state.
 */
export async function acknowledgePromotion(applicationId: number): Promise<AcknowledgeResult> {
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));

  if (!app) {
    throw new NotFoundError("Application", applicationId);
  }

  if (app.status !== "PENDING_ACKNOWLEDGMENT") {
    throw new ConflictError("Application is not pending acknowledgment");
  }

  const now = new Date();

  // ── EXPIRY CHECK (BEFORE any success transaction) ──
  // If expired, handle the penalty and throw. No success commit will occur.
  if (app.acknowledgeDeadline && app.acknowledgeDeadline < now) {
    const [job] = await db
      .select()
      .from(jobsTable)
      .where(eq(jobsTable.id, app.jobId));

    if (job) {
      await db.transaction(async (tx) => {
        await applyPenaltyAndRequeue(applicationId, app.jobId, tx);
        await promoteNext(app.jobId, job.capacity, tx);
      });
    }

    // Throw BEFORE any success path — client sees the error,
    // and the DB state (penalty applied) is consistent.
    throw new GoneError(
      "Acknowledgment window has expired. You have been returned to the waitlist with a penalty."
    );
  }

  // ── SUCCESS PATH (only reached if NOT expired) ──
  // Validate transition
  assertValidTransition("PENDING_ACKNOWLEDGMENT", "ACTIVE");

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

  // No throws after this point — the commit succeeded,
  // so the response MUST reflect the committed state.
  logger.info({ applicationId }, "Promotion acknowledged");

  return {
    applicationId,
    applicantId: app.applicantId,
    jobId: app.jobId,
    status: "ACTIVE",
    queuePosition: null,
    message: "Promotion acknowledged. You are now ACTIVE.",
  };
}

/**
 * Public apply flow: resolve applicant + atomic application creation
 * 1. Resolve applicant (create if new, fetch if existing) — handles duplicate email gracefully
 * 2. Validate job exists
 * 3. In transaction:
 *    - Check for duplicate application
 *    - Run decay check
 *    - Assign status (ACTIVE or WAITLIST)
 *    - Insert application + audit log + queue position
 *
 * Returns ApplyResult with consistent state.
 */
export async function applyPublic(
  name: string,
  email: string,
  jobId: number
): Promise<ApplyResult> {
  // ── Step 1: Resolve applicant (create if new, fetch if existing) ──
  let applicantId: number;

  try {
    const [created] = await db
      .insert(applicantsTable)
      .values({ name, email })
      .returning();

    applicantId = created.id;
  } catch (err: any) {
    // Handle duplicate email (Postgres)
    const errorCode = err?.code || err?.cause?.code;

    if (errorCode === "23505") {
      const existing = await db
        .select()
        .from(applicantsTable)
        .where(eq(applicantsTable.email, email))
        .limit(1);

      if (!existing || existing.length === 0) {
        throw new Error("Applicant exists but could not be fetched");
      }

      applicantId = existing[0].id;
    } else {
      throw err;
    }
  }

  // ── Step 2: Validate job exists before entering transaction ──
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));

  if (!job) {
    throw new NotFoundError("Job", jobId);
  }

  // ── Step 3: Run application logic in atomic transaction ──
  return db.transaction(async (tx) => {
    // Check for duplicate active application
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

    // Decay check and determine status
    await checkAndDecayExpiredAcknowledgments(jobId, job.capacity, tx as any);

    const activeCount = await getActiveCount(jobId, tx as any);

    // ✅ IMPORTANT: All applications start as WAITLIST
    // If capacity available, promote to PENDING_ACKNOWLEDGMENT (requires user acceptance)
    // Never set directly to ACTIVE
    let finalStatus: ApplicationStatus = "WAITLIST";
    let queuePosition: number | null = null;

    // Insert application as WAITLIST first
    const [newApp] = await tx
      .insert(applicationsTable)
      .values({
        jobId,
        applicantId,
        status: "WAITLIST",  // ✅ Always start here
      })
      .returning();

    // Insert audit log for initial application
    await tx.insert(auditLogsTable).values({
      applicationId: newApp.id,
      eventType: "APPLIED",
      fromStatus: null,
      toStatus: "WAITLIST",
      metadata: { jobId, applicantId },
    });

    // ✅ If capacity available, promote to PENDING_ACKNOWLEDGMENT immediately
    if (activeCount < job.capacity) {
      const deadline = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

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
        metadata: {
          acknowledgeDeadline: deadline.toISOString(),
          jobId,
        },
      });

      finalStatus = "PENDING_ACKNOWLEDGMENT";
    } else {
      // No capacity — add to queue
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

    // Return result
    return {
      applicationId: newApp.id,
      applicantId,
      jobId,
      status: finalStatus,
      queuePosition,
      message:
        finalStatus === "PENDING_ACKNOWLEDGMENT"
          ? "You've been promoted! Please accept this offer within 10 minutes."
          : `You have been added to the waitlist at position ${queuePosition}.`,
    };
  });
}