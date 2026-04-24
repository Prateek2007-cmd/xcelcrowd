/**
 * Pipeline barrel file — re-exports all pipeline modules.
 *
 * Consumers import from `./pipeline` (the directory) and get the same
 * API surface as the previous monolithic `pipeline.ts` file.
 */

// Types & constants
export { ACKNOWLEDGE_WINDOW_MS, ACKNOWLEDGE_WINDOW_SECONDS } from "./types";
export type { DecayResult, TxHandle } from "./types";

// Queue operations
export { getActiveCount, getNextCandidates, getNextInQueue, reindexQueue } from "./queue";

// Promotion
export { promoteNext, promoteUntilFull } from "./promote";

// Decay
export { applyPenaltyAndRequeue, checkAndDecayExpiredAcknowledgments, runDecayForJob } from "./decay";

// Snapshot & replay
export { getPipelineSnapshot, replayPipelineFromAuditLog } from "./snapshot";
