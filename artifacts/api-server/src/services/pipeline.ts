/**
 * Pipeline service — re-exports from modular files.
 *
 * This file exists for backwards compatibility. All logic now lives in:
 *   services/pipeline/queue.ts      — getActiveCount, getNextInQueue, reindexQueue
 *   services/pipeline/promote.ts    — promoteNext, promoteUntilFull
 *   services/pipeline/decay.ts      — applyPenaltyAndRequeue, checkAndDecayExpired, runDecayForJob
 *   services/pipeline/snapshot.ts   — getPipelineSnapshot, replayPipelineFromAuditLog
 *   services/pipeline/types.ts      — DecayResult, ACKNOWLEDGE_WINDOW_MS
 */
export {
  // Types & constants
  ACKNOWLEDGE_WINDOW_MS,
  ACKNOWLEDGE_WINDOW_SECONDS,
  type DecayResult,
  type TxHandle,

  // Queue
  getActiveCount,
  getNextCandidates,
  getNextInQueue,
  reindexQueue,

  // Promotion
  promoteNext,
  promoteUntilFull,

  // Decay
  applyPenaltyAndRequeue,
  checkAndDecayExpiredAcknowledgments,
  runDecayForJob,

  // Snapshot & replay
  getPipelineSnapshot,
  replayPipelineFromAuditLog,
} from "./pipeline/index";
