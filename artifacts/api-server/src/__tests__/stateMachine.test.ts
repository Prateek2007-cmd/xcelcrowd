import { describe, it, expect } from "vitest";
import {
  isValidTransition,
  assertValidTransition,
  createTransitionResult,
  getValidNextStates,
} from "../lib/stateMachine";
import { InvalidTransitionError } from "../lib/errors";

describe("stateMachine", () => {
  describe("isValidTransition", () => {
    // ── Legal transitions ──
    it("ACTIVE → INACTIVE is valid (withdrawal)", () => {
      expect(isValidTransition("ACTIVE", "INACTIVE")).toBe(true);
    });

    it("WAITLIST → PENDING_ACKNOWLEDGMENT is valid (promotion)", () => {
      expect(isValidTransition("WAITLIST", "PENDING_ACKNOWLEDGMENT")).toBe(true);
    });

    it("WAITLIST → INACTIVE is valid (withdrawal from waitlist)", () => {
      expect(isValidTransition("WAITLIST", "INACTIVE")).toBe(true);
    });

    it("PENDING_ACKNOWLEDGMENT → ACTIVE is valid (acknowledge)", () => {
      expect(isValidTransition("PENDING_ACKNOWLEDGMENT", "ACTIVE")).toBe(true);
    });

    it("PENDING_ACKNOWLEDGMENT → WAITLIST is valid (decay penalty)", () => {
      expect(isValidTransition("PENDING_ACKNOWLEDGMENT", "WAITLIST")).toBe(true);
    });

    it("PENDING_ACKNOWLEDGMENT → INACTIVE is valid (withdrawal)", () => {
      expect(isValidTransition("PENDING_ACKNOWLEDGMENT", "INACTIVE")).toBe(true);
    });

    it("INACTIVE → ACTIVE is valid (re-apply with capacity)", () => {
      expect(isValidTransition("INACTIVE", "ACTIVE")).toBe(true);
    });

    it("INACTIVE → WAITLIST is valid (re-apply when full)", () => {
      expect(isValidTransition("INACTIVE", "WAITLIST")).toBe(true);
    });

    // ── Illegal transitions ──
    it("ACTIVE → WAITLIST is invalid (cannot demote active to waitlist)", () => {
      expect(isValidTransition("ACTIVE", "WAITLIST")).toBe(false);
    });

    it("ACTIVE → PENDING_ACKNOWLEDGMENT is invalid", () => {
      expect(isValidTransition("ACTIVE", "PENDING_ACKNOWLEDGMENT")).toBe(false);
    });

    it("ACTIVE → ACTIVE is invalid (self-transition)", () => {
      expect(isValidTransition("ACTIVE", "ACTIVE")).toBe(false);
    });

    it("WAITLIST → ACTIVE is invalid (must go through PENDING_ACKNOWLEDGMENT)", () => {
      expect(isValidTransition("WAITLIST", "ACTIVE")).toBe(false);
    });

    it("INACTIVE → PENDING_ACKNOWLEDGMENT is invalid (must re-apply first)", () => {
      expect(isValidTransition("INACTIVE", "PENDING_ACKNOWLEDGMENT")).toBe(false);
    });
  });

  describe("assertValidTransition", () => {
    it("does not throw for legal transitions", () => {
      expect(() => assertValidTransition("ACTIVE", "INACTIVE")).not.toThrow();
      expect(() => assertValidTransition("WAITLIST", "PENDING_ACKNOWLEDGMENT")).not.toThrow();
    });

    it("throws InvalidTransitionError for illegal transitions", () => {
      expect(() => assertValidTransition("ACTIVE", "WAITLIST")).toThrow(InvalidTransitionError);
    });

    it("error contains from and to status in message", () => {
      try {
        assertValidTransition("ACTIVE", "WAITLIST");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidTransitionError);
        const error = err as InvalidTransitionError;
        expect(error.message).toContain("ACTIVE");
        expect(error.message).toContain("WAITLIST");
        expect(error.statusCode).toBe(422);
        expect(error.code).toBe("INVALID_TRANSITION");
      }
    });
  });

  describe("createTransitionResult", () => {
    it("returns a new result object for valid transitions", () => {
      const result = createTransitionResult(42, "ACTIVE", "INACTIVE");
      expect(result.applicationId).toBe(42);
      expect(result.fromStatus).toBe("ACTIVE");
      expect(result.toStatus).toBe("INACTIVE");
      expect(result.timestamp).toBeDefined();
      expect(typeof result.timestamp).toBe("string");
    });

    it("includes metadata when provided", () => {
      const result = createTransitionResult(1, "ACTIVE", "INACTIVE", { reason: "user_request" });
      expect(result.metadata).toEqual({ reason: "user_request" });
    });

    it("omits metadata key when not provided", () => {
      const result = createTransitionResult(1, "ACTIVE", "INACTIVE");
      expect(result).not.toHaveProperty("metadata");
    });

    it("throws for invalid transitions", () => {
      expect(() => createTransitionResult(1, "ACTIVE", "WAITLIST")).toThrow(InvalidTransitionError);
    });

    it("never mutates — returns new object each time", () => {
      const r1 = createTransitionResult(1, "ACTIVE", "INACTIVE");
      const r2 = createTransitionResult(1, "ACTIVE", "INACTIVE");
      expect(r1).not.toBe(r2);
    });
  });

  describe("getValidNextStates", () => {
    it("ACTIVE can only go to INACTIVE", () => {
      const next = getValidNextStates("ACTIVE");
      expect(next).toEqual(["INACTIVE"]);
    });

    it("WAITLIST can go to PENDING_ACKNOWLEDGMENT or INACTIVE", () => {
      const next = getValidNextStates("WAITLIST");
      expect(next).toContain("PENDING_ACKNOWLEDGMENT");
      expect(next).toContain("INACTIVE");
      expect(next).toHaveLength(2);
    });

    it("PENDING_ACKNOWLEDGMENT can go to ACTIVE, WAITLIST, or INACTIVE", () => {
      const next = getValidNextStates("PENDING_ACKNOWLEDGMENT");
      expect(next).toContain("ACTIVE");
      expect(next).toContain("WAITLIST");
      expect(next).toContain("INACTIVE");
      expect(next).toHaveLength(3);
    });

    it("INACTIVE can go to ACTIVE or WAITLIST", () => {
      const next = getValidNextStates("INACTIVE");
      expect(next).toContain("ACTIVE");
      expect(next).toContain("WAITLIST");
      expect(next).toHaveLength(2);
    });
  });
});
