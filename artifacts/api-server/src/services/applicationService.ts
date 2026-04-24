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

// ── Private core result type ──────────────────────────────────────

interface ApplicationCoreResult {
  applicationId: number;
  status: ApplicationStatus;
  queuePosition: number | null;
}

// ── Service functions ──────────────────────────────────────────────

/**
 * INTERNAL: Shared application creation logic.
 *
 * Encapsulates all business logic for creating an application:
 *   1. Check for duplicate active application
 *   2. Run decay check for expired acknowledgments
 *   3. Determine status (WAITLIST or PENDING_ACKNOWLEDGMENT based on capacity)
 *   4. Insert application + audit logs + queue position
 *
 * Must be called inside an open transaction.
 *
 * Returns: {applicationId, status, queuePosition}
 */
async function createApplicationCore(
  tx: typeof db,
  applicantId: number,
  jobId: number,
  job: { id: number; capacity: number }
): Promise<ApplicationCoreResult> {
  // ── Step 1: Check for duplicate active application ──
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

  // ── Step 2: Run decay check and get active count ──
  await checkAndDecayExpiredAcknowledgments(jobId, job.capacity, tx as any);
  const activeCount = await getActiveCount(jobId, tx as any);

  // ── Step 3: Insert application as WAITLIST ──
  // IMPORTANT: All applications start as WAITLIST
  const [newApp] = await tx
    .insert(applicationsTable)
    .values({
      jobId,
      applicantId,
      status: "WAITLIST",  // ✅ Always start here
    })
    .returning();

  // ── Step 4: Insert initial "APPLIED" audit log ──
  await tx.insert(auditLogsTable).values({
    applicationId: newApp.id,
    eventType: "APPLIED",
    fromStatus: null,
    toStatus: "WAITLIST",
    metadata: { jobId, applicantId },
  });

  // ── Step 5: Determine final status and queue position ──
  let finalStatus: ApplicationStatus = "WAITLIST";
  let queuePosition: number | null = null;

  if (activeCount < job.capacity) {
    // Capacity available: promote to PENDING_ACKNOWLEDGMENT immediately
    // User must accept within 10 minutes
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
    // No capacity: add to queue
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

  return {
    applicationId: newApp.id,
    status: finalStatus,
    queuePosition,
  };
}

/**
 * Apply an applicant (authenticated user) to a job.
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

  // Create application using shared core logic
  const coreResult = await db.transaction(async (tx) => {
    return createApplicationCore(tx, applicantId, jobId, job);
  });

  // Return ApplyResult with user message
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
 * Public apply flow: resolve applicant + create application atomically.
 * 
 * Steps:
 *   1. Resolve applicant (create if new, fetch if exists) — handles duplicate email gracefully
 *   2. Validate job exists
 *   3. Call shared createApplicationCore for all business logic
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
    // If already an AppError, re-throw as-is
    if (err instanceof DatabaseError) {
      throw err;
    }

    // Handle duplicate email (Postgres error code 23505)
    const errorCode = err?.code || err?.cause?.code;

    if (errorCode === "23505") {
      // Applicant with this email already exists — fetch and reuse
      try {
        const existing = await db
          .select()
          .from(applicantsTable)
          .where(eq(applicantsTable.email, email))
          .limit(1);

        if (!existing || existing.length === 0) {
          throw new DatabaseError(
            "Applicant exists (duplicate email constraint) but could not be fetched from database"
          );
        }

        applicantId = existing[0].id;
      } catch (fetchErr: any) {
        // Wrap any fetch errors
        if (fetchErr instanceof DatabaseError) {
          throw fetchErr;
        }
        throw new DatabaseError(
          "Failed to fetch existing applicant after detecting duplicate email"
        );
      }
    } else {
      // Wrap all other unknown errors (including internal DB errors)
      throw new DatabaseError(
        "Failed to create or resolve applicant"
      );
    }
  }

  // ── Step 2: Validate job exists before entering transaction ──
  const [job] = await db.select().from(jobsTable).where(eq(jobsTable.id, jobId));

  if (!job) {
    throw new NotFoundError("Job", jobId);
  }

  // ── Step 3: Create application using shared core logic ──
  const coreResult = await db.transaction(async (tx) => {
    return createApplicationCore(tx, applicantId, jobId, job);
  });

  // Return ApplyResult with user message
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