/**
 * Application routes — thin wrappers using validation middleware.
 * No direct DB access. Errors bubble up to the global error handler.
 */
import { Router, type IRouter } from "express";

import {
  ApplyToJobBody,
  WithdrawApplicationBody,
  AcknowledgePromotionBody,
} from "@workspace/api-zod";
import { validateBody } from "../middlewares/validate";
import { PublicApplyBody } from "../schemas/application";
import {
  applyToJob,
  applyPublic,
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


router.post(
  "/apply-public",
  validateBody(PublicApplyBody),
  async (req, res, next): Promise<void> => {
    try {
      const { name, email, jobId } = req.body;

      const result = await applyPublic(name, email, jobId);

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;

