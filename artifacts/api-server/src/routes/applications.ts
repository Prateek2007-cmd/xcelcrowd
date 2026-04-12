/**
 * Application routes — thin wrappers that parse input and delegate to services.
 * No direct DB access. Errors bubble up to the global error handler.
 */
import { Router, type IRouter } from "express";
import {
  ApplyToJobBody,
  WithdrawApplicationBody,
  AcknowledgePromotionBody,
} from "@workspace/api-zod";
import { ValidationError } from "../lib/errors";
import {
  applyToJob,
  withdrawApplication,
  acknowledgePromotion,
} from "../services/applicationService";

const router: IRouter = Router();

router.post("/apply", async (req, res, next): Promise<void> => {
  try {
    const parsed = ApplyToJobBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.message);
    }

    const result = await applyToJob(parsed.data.applicantId, parsed.data.jobId);
    res.status(201).json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/withdraw", async (req, res, next): Promise<void> => {
  try {
    const parsed = WithdrawApplicationBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.message);
    }

    const result = await withdrawApplication(parsed.data.applicationId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

router.post("/acknowledge", async (req, res, next): Promise<void> => {
  try {
    const parsed = AcknowledgePromotionBody.safeParse(req.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.message);
    }

    const result = await acknowledgePromotion(parsed.data.applicationId);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

export default router;
