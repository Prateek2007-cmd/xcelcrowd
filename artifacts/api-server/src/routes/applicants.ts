/**
 * Applicant routes — registry, status, and timeline endpoints.
 * Routes are thin controllers and delegate all logic to services.
 */
import { Router, type IRouter } from "express";
import {
  CreateApplicantBody,
  GetApplicantParams,
  GetApplicantStatusParams,
  GetApplicantTimelineParams,
  ListApplicantsResponseItem,
  GetApplicantResponse,
  GetApplicantStatusResponse,
} from "@workspace/api-zod";
import { validateBody, validateParams } from "../middlewares/validate";

import {
  listApplicants,
  createApplicant,
  getApplicant,
  getApplicantStatus,
  getApplicantTimeline,
} from "../services/applicantService";

const router: IRouter = Router();

/**
 * List applicants
 */
router.get("/applicants", async (_req, res): Promise<void> => {
  const applicants = await listApplicants();

  res.json(
    applicants.map((a) =>
      ListApplicantsResponseItem.parse(a)
    )
  );
});

/**
 * Create applicant (FIXED: moved logic to service)
 */
router.post(
  "/applicants",
  validateBody(CreateApplicantBody),
  async (req, res, next): Promise<void> => {
    try {
      const applicant = await createApplicant(
        req.body.name,
        req.body.email
      );

      res.status(201).json(
        GetApplicantResponse.parse(applicant)
      );
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Get single applicant
 */
router.get(
  "/applicants/:applicantId",
  validateParams(GetApplicantParams),
  async (_req, res, next): Promise<void> => {
    try {
      const { applicantId } = res.locals.params;

      const applicant = await getApplicant(applicantId);

      res.json(GetApplicantResponse.parse(applicant));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Get applicant status
 */
router.get(
  "/status/:applicantId",
  validateParams(GetApplicantStatusParams),
  async (_req, res, next): Promise<void> => {
    try {
      const { applicantId } = res.locals.params;

      const result = await getApplicantStatus(applicantId);

      res.json(GetApplicantStatusResponse.parse(result));
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Get applicant timeline
 */
router.get(
  "/timeline/:applicantId",
  validateParams(GetApplicantTimelineParams),
  async (_req, res, next): Promise<void> => {
    try {
      const { applicantId } = res.locals.params;

      const timeline = await getApplicantTimeline(applicantId);

      res.json(timeline);
    } catch (err) {
      next(err);
    }
  }
);

export default router;