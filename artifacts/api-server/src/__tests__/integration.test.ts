/**
 * Integration tests — applicationService + pipeline logic against real PostgreSQL.
 *
 * NO MOCKS on @workspace/db — all queries hit the live database.
 * Each test starts with a clean, empty database (TRUNCATE CASCADE).
 *
 * Run with: DATABASE_URL=postgresql://... npx vitest run integration
 *           or: pnpm test -- integration
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and } from "drizzle-orm";
import {
  getTestDb,
  closeTestDb,
  cleanAllTables,
  seedJob,
  seedApplicant,
  seedWaitlistApplication,
  seedPendingApplication,
  seedActiveApplication,
  applicationsTable,
  queuePositionsTable,
  auditLogsTable,
} from "./setupTestDb";

// ── Import the REAL service functions (no mocks) ─────────────────────────────
import { applyPublic, applyToJob, acknowledgePromotion, withdrawApplication } from "../services/applicationService";
import {
  promoteNext,
  applyPenaltyAndRequeue,
  checkAndDecayExpiredAcknowledgments,
  getActiveCount,
} from "../services/pipeline";

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await cleanAllTables();
});

afterAll(async () => {
  await cleanAllTables();
  await closeTestDb();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  1. applyPublic() — public application flow
// ═══════════════════════════════════════════════════════════════════════════════

describe("applyPublic() — integration", () => {
  it("creates a new applicant and application in the database", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    const result = await applyPublic("Alice", "alice@test.com", job.id);

    expect(result.applicationId).toBeDefined();
    expect(result.applicantId).toBeDefined();
    expect(result.jobId).toBe(job.id);

    // Verify applicant was inserted
    const [applicant] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, result.applicationId));

    expect(applicant).toBeDefined();
  });

  it("reuses existing applicant on duplicate email", async () => {
    const job = await seedJob({ capacity: 5 });

    const result1 = await applyPublic("Alice", "alice@test.com", job.id);

    // Withdraw first application so we can re-apply
    await withdrawApplication(result1.applicationId);

    const result2 = await applyPublic("Alice Updated", "alice@test.com", job.id);

    // Same applicant ID reused
    expect(result2.applicantId).toBe(result1.applicantId);
    // Different application
    expect(result2.applicationId).not.toBe(result1.applicationId);
  });

  it("promotes to PENDING_ACKNOWLEDGMENT when capacity is available", async () => {
    const job = await seedJob({ capacity: 3 });

    const result = await applyPublic("Bob", "bob@test.com", job.id);

    expect(result.status).toBe("PENDING_ACKNOWLEDGMENT");
  });

  it("places on WAITLIST when capacity is full", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    // Fill the single slot
    const first = await applyPublic("Alice", "alice@test.com", job.id);
    expect(first.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Second applicant should be waitlisted
    const second = await applyPublic("Bob", "bob@test.com", job.id);
    expect(second.status).toBe("WAITLIST");
    expect(second.queuePosition).toBe(1);

    // Verify queue position exists in DB
    const [qp] = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, second.applicationId));

    expect(qp).toBeDefined();
    expect(qp.position).toBe(1);
  });

  it("rejects duplicate active application for same job", async () => {
    const job = await seedJob({ capacity: 5 });

    await applyPublic("Alice", "alice@test.com", job.id);

    // Second application to same job should throw
    await expect(
      applyPublic("Alice", "alice@test.com", job.id)
    ).rejects.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. applyToJob() — authenticated application flow
// ═══════════════════════════════════════════════════════════════════════════════

describe("applyToJob() — integration", () => {
  it("creates application with PENDING_ACKNOWLEDGMENT when capacity available", async () => {
    const job = await seedJob({ capacity: 3 });
    const applicant = await seedApplicant({ name: "Charlie", email: "charlie@test.com" });

    const result = await applyToJob(applicant.id, job.id);

    expect(result.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(result.applicationId).toBeDefined();
  });

  it("creates WAITLIST application when capacity is full", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });
    const a1 = await seedApplicant({ email: "a1@test.com" });
    const a2 = await seedApplicant({ email: "a2@test.com" });

    // Fill the slot
    const first = await applyToJob(a1.id, job.id);
    expect(first.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Second goes to waitlist
    const second = await applyToJob(a2.id, job.id);
    expect(second.status).toBe("WAITLIST");
    expect(second.queuePosition).toBeGreaterThanOrEqual(1);
  });

  it("writes APPLIED audit log on creation", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "audit@test.com" });

    const result = await applyToJob(applicant.id, job.id);

    const logs = await db
      .select()
      .from(auditLogsTable)
      .where(eq(auditLogsTable.applicationId, result.applicationId));

    const appliedLog = logs.find((l) => l.eventType === "APPLIED");
    expect(appliedLog).toBeDefined();
    expect(appliedLog!.toStatus).toBe("WAITLIST");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. acknowledgePromotion() — accept within window
// ═══════════════════════════════════════════════════════════════════════════════

describe("acknowledgePromotion() — integration", () => {
  it("transitions PENDING_ACKNOWLEDGMENT → ACTIVE on valid acknowledge", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "ack@test.com" });

    // Apply → gets PENDING_ACKNOWLEDGMENT
    const applied = await applyToJob(applicant.id, job.id);
    expect(applied.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Acknowledge
    const result = await acknowledgePromotion(applied.applicationId);

    expect(result.status).toBe("ACTIVE");

    // Verify in DB
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, applied.applicationId));

    expect(app.status).toBe("ACTIVE");
    expect(app.acknowledgedAt).not.toBeNull();
    expect(app.acknowledgeDeadline).toBeNull();
  });

  it("rejects expired acknowledgment and moves to WAITLIST", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "expired@test.com" });

    // Seed a PENDING app with an already-expired deadline
    const expiredApp = await seedPendingApplication(
      applicant.id,
      job.id,
      new Date(Date.now() - 60_000) // expired 1 min ago
    );

    // Acknowledge should throw GoneError
    await expect(
      acknowledgePromotion(expiredApp.id)
    ).rejects.toThrow(/expired/i);

    // Verify status changed to WAITLIST in DB
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, expiredApp.id));

    expect(app.status).toBe("WAITLIST");
    expect(app.penaltyCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. Pipeline logic — promoteNext, decay, requeue
// ═══════════════════════════════════════════════════════════════════════════════

describe("promoteNext() — integration", () => {
  it("promotes the first WAITLIST candidate by queue position", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 2 });
    const a1 = await seedApplicant({ email: "first@test.com" });
    const a2 = await seedApplicant({ email: "second@test.com" });

    // Seed two waitlisted apps with positions
    const app1 = await seedWaitlistApplication(a1.id, job.id, 1);
    const app2 = await seedWaitlistApplication(a2.id, job.id, 2);

    // Promote next — should pick app1 (position 1)
    await db.transaction(async (tx) => {
      await promoteNext(job.id, job.capacity, tx);
    });

    // app1 should now be PENDING_ACKNOWLEDGMENT
    const [promoted] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, app1.id));

    expect(promoted.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(promoted.acknowledgeDeadline).not.toBeNull();

    // app2 should still be WAITLIST
    const [still_waiting] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, app2.id));

    expect(still_waiting.status).toBe("WAITLIST");
  });

  it("does not promote when capacity is full", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });
    const a1 = await seedApplicant({ email: "active@test.com" });
    const a2 = await seedApplicant({ email: "waiting@test.com" });

    // Fill the slot
    await seedActiveApplication(a1.id, job.id);

    // Add waitlisted candidate
    const waitApp = await seedWaitlistApplication(a2.id, job.id, 1);

    // Try to promote — should do nothing
    await db.transaction(async (tx) => {
      await promoteNext(job.id, job.capacity, tx);
    });

    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, waitApp.id));

    expect(app.status).toBe("WAITLIST");
  });

  it("removes queue entry after successful promotion", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "queue@test.com" });

    const waitApp = await seedWaitlistApplication(applicant.id, job.id, 1);

    await db.transaction(async (tx) => {
      await promoteNext(job.id, job.capacity, tx);
    });

    // Queue entry should be gone
    const queueEntries = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, waitApp.id));

    expect(queueEntries.length).toBe(0);
  });
});

describe("checkAndDecayExpiredAcknowledgments() — integration", () => {
  it("decays expired PENDING_ACKNOWLEDGMENT apps and requeues them", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 2 });
    const applicant = await seedApplicant({ email: "decay@test.com" });

    // Create expired pending app
    const expiredApp = await seedPendingApplication(
      applicant.id,
      job.id,
      new Date(Date.now() - 60_000) // expired
    );

    let decayed = 0;
    await db.transaction(async (tx) => {
      decayed = await checkAndDecayExpiredAcknowledgments(job.id, job.capacity, tx);
    });

    expect(decayed).toBe(1);

    // App should now be WAITLIST
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, expiredApp.id));

    expect(app.status).toBe("WAITLIST");
    expect(app.penaltyCount).toBe(1);
    expect(app.acknowledgeDeadline).toBeNull();

    // Should have a queue position
    const [qp] = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, expiredApp.id));

    expect(qp).toBeDefined();
    expect(qp.position).toBeGreaterThanOrEqual(1);
  });

  it("does not decay non-expired PENDING_ACKNOWLEDGMENT apps", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 2 });
    const applicant = await seedApplicant({ email: "valid@test.com" });

    // Create pending app with future deadline
    const validApp = await seedPendingApplication(
      applicant.id,
      job.id,
      new Date(Date.now() + 300_000) // 5 min in future
    );

    let decayed = 0;
    await db.transaction(async (tx) => {
      decayed = await checkAndDecayExpiredAcknowledgments(job.id, job.capacity, tx);
    });

    expect(decayed).toBe(0);

    // App should still be PENDING_ACKNOWLEDGMENT
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, validApp.id));

    expect(app.status).toBe("PENDING_ACKNOWLEDGMENT");
  });

  it("decays multiple expired apps in a single cycle", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    const a1 = await seedApplicant({ email: "exp1@test.com" });
    const a2 = await seedApplicant({ email: "exp2@test.com" });
    const a3 = await seedApplicant({ email: "exp3@test.com" });

    await seedPendingApplication(a1.id, job.id, new Date(Date.now() - 60_000));
    await seedPendingApplication(a2.id, job.id, new Date(Date.now() - 30_000));
    await seedPendingApplication(a3.id, job.id, new Date(Date.now() - 10_000));

    let decayed = 0;
    await db.transaction(async (tx) => {
      decayed = await checkAndDecayExpiredAcknowledgments(job.id, job.capacity, tx);
    });

    expect(decayed).toBe(3);

    // All should be WAITLIST now
    const apps = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.jobId, job.id));

    for (const app of apps) {
      expect(app.status).toBe("WAITLIST");
      expect(app.penaltyCount).toBe(1);
    }
  });

  it("writes DECAY_TRIGGERED audit log for each expired app", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "auditdecay@test.com" });

    const expiredApp = await seedPendingApplication(
      applicant.id,
      job.id,
      new Date(Date.now() - 60_000)
    );

    await db.transaction(async (tx) => {
      await checkAndDecayExpiredAcknowledgments(job.id, job.capacity, tx);
    });

    const logs = await db
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.applicationId, expiredApp.id),
          eq(auditLogsTable.eventType, "DECAY_TRIGGERED")
        )
      );

    expect(logs.length).toBe(1);
    expect(logs[0].fromStatus).toBe("PENDING_ACKNOWLEDGMENT");
    expect(logs[0].toStatus).toBe("WAITLIST");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. getActiveCount() — real DB count
// ═══════════════════════════════════════════════════════════════════════════════

describe("getActiveCount() — integration", () => {
  it("counts ACTIVE + PENDING_ACKNOWLEDGMENT applications", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 10 });

    const a1 = await seedApplicant({ email: "act1@test.com" });
    const a2 = await seedApplicant({ email: "act2@test.com" });
    const a3 = await seedApplicant({ email: "wait@test.com" });

    await seedActiveApplication(a1.id, job.id);
    await seedPendingApplication(a2.id, job.id, new Date(Date.now() + 300_000));
    await seedWaitlistApplication(a3.id, job.id, 1);

    let count = 0;
    await db.transaction(async (tx) => {
      count = await getActiveCount(job.id, tx);
    });

    // 1 ACTIVE + 1 PENDING = 2 (WAITLIST not counted)
    expect(count).toBe(2);
  });

  it("returns 0 when no applications exist", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    let count = 0;
    await db.transaction(async (tx) => {
      count = await getActiveCount(job.id, tx);
    });

    expect(count).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. withdrawApplication() — end-to-end
// ═══════════════════════════════════════════════════════════════════════════════

describe("withdrawApplication() — integration", () => {
  it("sets status to INACTIVE and promotes next waitlisted candidate", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });
    const a1 = await seedApplicant({ email: "withdraw@test.com" });
    const a2 = await seedApplicant({ email: "nextup@test.com" });

    // a1 applies (gets PENDING_ACKNOWLEDGMENT), a2 waitlisted
    const r1 = await applyToJob(a1.id, job.id);
    const r2 = await applyToJob(a2.id, job.id);

    expect(r1.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(r2.status).toBe("WAITLIST");

    // a1 withdraws — should promote a2
    await withdrawApplication(r1.applicationId);

    // a1 should be INACTIVE
    const [app1] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, r1.applicationId));
    expect(app1.status).toBe("INACTIVE");

    // a2 should be PENDING_ACKNOWLEDGMENT (promoted)
    const [app2] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, r2.applicationId));
    expect(app2.status).toBe("PENDING_ACKNOWLEDGMENT");
  });
});
