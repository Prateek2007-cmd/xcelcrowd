/**
 * Application service barrel file — re-exports all application modules.
 *
 * Consumers import from `./application` and get the same API surface
 * as the previous monolithic `applicationService.ts`.
 */

// Types
export type { ApplyResult, WithdrawResult, AcknowledgeResult } from "./types";

// Apply
export { applyToJob, applyPublic } from "./apply";

// Withdraw
export { withdrawApplication } from "./withdraw";

// Acknowledge
export { acknowledgePromotion } from "./acknowledge";
