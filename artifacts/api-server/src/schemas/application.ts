/**
 * Centralized request body schemas for application routes.
 * Schemas used by the shared @workspace/api-zod package live there.
 * This file covers schemas that are specific to the api-server
 * (e.g., public-facing endpoints not generated from the OpenAPI spec).
 */
import { z } from "zod";

/**
 * Body schema for the public apply endpoint.
 * Accepts name + email (find-or-create applicant) and a job ID.
 * No authentication required.
 */
export const PublicApplyBody = z.object({
  name: z.string().min(1, "Name is required"),
  email: z.string().email("Invalid email address"),
  jobId: z.number().int().positive("Job ID must be a positive integer"),
});

export type PublicApplyBodyType = z.infer<typeof PublicApplyBody>;
