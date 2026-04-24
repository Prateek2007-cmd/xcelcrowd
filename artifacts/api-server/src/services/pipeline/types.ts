/**
 * Pipeline shared types and constants.
 */
import { db } from "@workspace/db";

/** Transaction handle type — reusable across all pipeline modules. */
export type TxHandle = typeof db;

/** Acknowledge window: 5 minutes. */
export const ACKNOWLEDGE_WINDOW_MS = 5 * 60 * 1000;
export const ACKNOWLEDGE_WINDOW_SECONDS = ACKNOWLEDGE_WINDOW_MS / 1000;

/** Result from a complete decay cycle. */
export interface DecayResult {
  decayed: number;
  promoted: number;
  success: boolean;
  error?: {
    code: string;
    message: string;
    stage?: string;
  };
}
