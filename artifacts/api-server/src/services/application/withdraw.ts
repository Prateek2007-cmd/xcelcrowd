/**
 * Withdraw logic.
 */
import { db } from "@workspace/db";
import {
  applicationsTable,
  jobsTable,
  queuePositionsTable,
  auditLogsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { NotFoundError, ConflictError } from "../../lib/errors";
import { assertValidTransition } from "../../lib/stateMachine";
import { promoteNext } from "../pipeline";
import { logger } from "../../lib/logger";
import type { WithdrawResult } from "./types";

/**
 * Withdraw an application.
 * Validates transition legality via the state machine.
 */
export async function withdrawApplication(applicationId: number): Promise<WithdrawResult> {
  const [app] = await db
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, applicationId));

  if (!app) throw new NotFoundError("Application", applicationId);

  if (app.status === "INACTIVE") {
    throw new ConflictError("Application is already inactive");
  }

  assertValidTransition(app.status, "INACTIVE");

  const [job] = await db
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, app.jobId));

  if (!job) throw new NotFoundError("Job", app.jobId);

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
