/**
 * Application service shared types.
 */
import type { ApplicationStatus } from "@workspace/db";

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

export interface ApplicationCoreResult {
  applicationId: number;
  status: ApplicationStatus;
  queuePosition: number | null;
}
