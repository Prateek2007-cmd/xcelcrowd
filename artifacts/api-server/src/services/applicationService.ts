/**
 * Application service — re-exports from modular files.
 *
 * This file exists for backwards compatibility. All logic now lives in:
 *   services/application/apply.ts        — applyToJob, applyPublic
 *   services/application/withdraw.ts     — withdrawApplication
 *   services/application/acknowledge.ts  — acknowledgePromotion
 *   services/application/types.ts        — ApplyResult, WithdrawResult, AcknowledgeResult
 */
export {
  type ApplyResult,
  type WithdrawResult,
  type AcknowledgeResult,
  applyToJob,
  applyPublic,
  withdrawApplication,
  acknowledgePromotion,
} from "./application/index";