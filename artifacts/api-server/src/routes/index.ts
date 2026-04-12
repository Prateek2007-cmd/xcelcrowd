import { Router, type IRouter } from "express";
import healthRouter from "./health";
import jobsRouter from "./jobs";
import applicantsRouter from "./applicants";
import applicationsRouter from "./applications";
import pipelineRouter from "./pipeline";

const router: IRouter = Router();

router.use(healthRouter);
router.use(jobsRouter);
router.use(applicantsRouter);
router.use(applicationsRouter);
router.use(pipelineRouter);

export default router;
