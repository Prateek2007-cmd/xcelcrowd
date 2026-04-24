/**
 * Acknowledge promotion logic.
 */
import { db } from "@workspace/db";
import {
  applicationsTable,
  jobsTable,
  auditLogsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { NotFoundError, ConflictError, GoneError } from "../../lib/errors";
import { assertValidTransition } from "../../lib/stateMachine";
import { applyPenaltyAndRequeue, promoteNext } from "../pipeline";
import { logger } from "../../lib/logger";
import type { AcknowledgeResult } from "./types";

/**
 * Acknowledge a promotion within the time window.
 *
 * If expired → decay + throw GoneError.
 * If valid → commit ACTIVE → return result.
 */
export async function acknowledgePromotion(applicationId: number): Promise<AcknowledgeResult> {
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));

  if (!app) throw new NotFoundError("Application", applicationId);

  if (app.status !== "PENDING_ACKNOWLEDGMENT") {
    throw new ConflictError("Application is not pending acknowledgment");
  }

  const now = new Date();

  // EXPIRY CHECK (BEFORE any success transaction)
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

    throw new GoneError(
      "Acknowledgment window has expired. You have been returned to the waitlist with a penalty."
    );
  }

  // SUCCESS PATH
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
