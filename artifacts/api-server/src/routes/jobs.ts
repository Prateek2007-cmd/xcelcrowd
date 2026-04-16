/**
 * Job routes — list, create, and detail endpoints.
 * Thin controllers: delegate all logic to jobService.
 */
import { Router, type IRouter } from "express";
import {
  CreateJobBody,
  GetJobParams,
} from "@workspace/api-zod";
import { validateBody, validateParams } from "../middlewares/validate";

import {
  listJobs,
  createJob,
  getJobDetail,
} from "../services/jobService";

const router: IRouter = Router();

/**
 * List all jobs
 * (delegates to service — no DB logic here)
 */
router.get("/jobs", async (_req, res): Promise<void> => {
  const jobs = await listJobs();
  res.json(jobs);
});

/**
 * Create job
 */
router.post(
  "/jobs",
  validateBody(CreateJobBody),
  async (req, res, next): Promise<void> => {
    try {
      const job = await createJob(req.body);
      res.status(201).json(job);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * Get job detail
 */
router.get(
  "/jobs/:jobId",
  validateParams(GetJobParams),
  async (_req, res, next): Promise<void> => {
    try {
      const { jobId } = res.locals.params;

      const result = await getJobDetail(jobId);

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

export default router;