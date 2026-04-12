/**
 * Centralized state transition validator for ApplicationStatus.
 *
 * This module defines the ONLY legal transitions in the pipeline
 * and provides a pure validation function. No mutations occur here.
 */
import type { ApplicationStatus } from "@workspace/db";
import { InvalidTransitionError } from "./errors";

/**
 * Adjacency map of legal state transitions.
 * Key = current state, Value = set of states that are reachable.
 */
const VALID_TRANSITIONS: Record<ApplicationStatus, ReadonlySet<ApplicationStatus>> = {
  ACTIVE: new Set(["INACTIVE"]),
  WAITLIST: new Set(["PENDING_ACKNOWLEDGMENT", "INACTIVE"]),
  PENDING_ACKNOWLEDGMENT: new Set(["ACTIVE", "WAITLIST", "INACTIVE"]),
  INACTIVE: new Set(["ACTIVE", "WAITLIST"]), // re-apply after withdrawal
} as const;

/**
 * Returns true if transitioning from `from` to `to` is a legal state change.
 * Pure function — no side effects.
 */
export function isValidTransition(from: ApplicationStatus, to: ApplicationStatus): boolean {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.has(to) : false;
}

/**
 * Asserts that a state transition is valid. Throws InvalidTransitionError if not.
 * Pure validation — no side effects.
 */
export function assertValidTransition(from: ApplicationStatus, to: ApplicationStatus): void {
  if (!isValidTransition(from, to)) {
    throw new InvalidTransitionError(from, to);
  }
}

/**
 * Returns a new status object representing the transition result.
 * Pure function — produces a new object, never mutates input.
 */
export function createTransitionResult(
  applicationId: number,
  from: ApplicationStatus,
  to: ApplicationStatus,
  metadata?: Record<string, unknown>
): {
  applicationId: number;
  fromStatus: ApplicationStatus;
  toStatus: ApplicationStatus;
  timestamp: string;
  metadata?: Record<string, unknown>;
} {
  assertValidTransition(from, to);
  return {
    applicationId,
    fromStatus: from,
    toStatus: to,
    timestamp: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  };
}

/**
 * Get all valid next states from the given status.
 */
export function getValidNextStates(from: ApplicationStatus): readonly ApplicationStatus[] {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? Array.from(allowed) : [];
}
