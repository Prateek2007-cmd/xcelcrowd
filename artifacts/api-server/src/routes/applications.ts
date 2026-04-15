/**
 * Application routes — thin wrappers using validation middleware.
 * No direct DB access. Errors bubble up to the global error handler.
 */
import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "@workspace/db";
import { applicantsTable } from "@workspace/db";
import {
  ApplyToJobBody,
  WithdrawApplicationBody,
  AcknowledgePromotionBody,
} from "@workspace/api-zod";
import { validateBody } from "../middlewares/validate";
import {
  applyToJob,
  withdrawApplication,
  acknowledgePromotion,
} from "../services/applicationService";

const router: IRouter = Router();

router.post("/apply", validateBody(ApplyToJobBody), async (req, res, next): Promise<void> => {
  try {
    const result = await applyToJob(req.body.applicantId, req.body.jobId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/withdraw", validateBody(WithdrawApplicationBody), async (req, res, next): Promise<void> => {
  try {
    const result = await withdrawApplication(req.body.applicationId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/acknowledge", validateBody(AcknowledgePromotionBody), async (req, res, next): Promise<void> => {
  try {
    const result = await acknowledgePromotion(req.body.applicationId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * Public apply endpoint — handles full flow in one call:
 * 1. Find existing applicant by email OR create new one
 * 2. Apply to the specified job
 * No authentication required.
 */
const PublicApplyBody = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  jobId: z.number().int().positive(),
});

router.post("/apply-public", validateBody(PublicApplyBody), async (req, res, next): Promise<void> => {
  try {
    const { name, email, jobId } = req.body;

    // Find or create applicant
    let applicantId: number;
    const [existing] = await db
      .select()
      .from(applicantsTable)
      .where(eq(applicantsTable.email, email));

    if (existing) {
      applicantId = existing.id;
    } else {
      const [created] = await db
        .insert(applicantsTable)
        .values({ name, email })
        .returning();
      applicantId = created.id;
    }

    // Apply to job (reuses existing service with all business logic)
    const result = await applyToJob(applicantId, jobId);
    res.status(201).json({ ...result, applicantId });
  } catch (err) {
    next(err);
  }
});

export default router;

