/**
 * Pipeline integration tests — end-to-end flows across services + real DB.
 *
 * Tests the SEAMS between:
 *   - applicationService (apply, acknowledge, withdraw)
 *   - pipeline (promoteNext, checkAndDecayExpiredAcknowledgments, runDecayForJob)
 *   - database (applications, queue_positions, audit_logs)
 *
 * NO MOCKS. All queries hit the real PostgreSQL database.
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

// Real service functions — NO mocks
import { applyPublic, applyToJob, acknowledgePromotion, withdrawApplication } from "../services/applicationService";
import {
  promoteNext,
  promoteUntilFull,
  checkAndDecayExpiredAcknowledgments,
  getActiveCount,
  runDecayForJob,
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
//  1. APPLY → PENDING_ACKNOWLEDGMENT (capacity available)
// ═══════════════════════════════════════════════════════════════════════════════
describe("Apply → PENDING_ACKNOWLEDGMENT flow", () => {
  it("creates applicant and application with PENDING_ACKNOWLEDGMENT when capacity open", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    const result = await applyPublic("Alice", "alice@pipeline.com", job.id);

    expect(result.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(result.applicantId).toBeDefined();
    expect(result.applicationId).toBeDefined();

    // Verify in DB
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, result.applicationId));

    expect(app.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(app.promotedAt).not.toBeNull();
    expect(app.acknowledgeDeadline).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. APPLY → WAITLIST (capacity full)
// ═══════════════════════════════════════════════════════════════════════════════
describe("Apply → WAITLIST flow", () => {
  it("places applicant on WAITLIST with queue position when capacity is full", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    // Fill the single slot
    const first = await applyPublic("Alice", "alice@wait.com", job.id);
    expect(first.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Second applicant goes to waitlist
    const second = await applyPublic("Bob", "bob@wait.com", job.id);

    expect(second.status).toBe("WAITLIST");
    expect(second.queuePosition).toBeGreaterThanOrEqual(1);

    // Queue position exists in DB
    const [qp] = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, second.applicationId));

    expect(qp).toBeDefined();
    expect(qp.position).toBeGreaterThanOrEqual(1);
  });

  it("preserves FIFO order for multiple waitlisted applicants", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    await applyPublic("Alice", "alice@fifo.com", job.id);

    const bob = await applyPublic("Bob", "bob@fifo.com", job.id);
    const carol = await applyPublic("Carol", "carol@fifo.com", job.id);

    // Bob applied first → lower position
    const [bobQp] = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, bob.applicationId));
    const [carolQp] = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, carol.applicationId));

    expect(bobQp.position).toBeLessThan(carolQp.position);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. PROMOTION FLOW — promoteNext on real DB
// ═══════════════════════════════════════════════════════════════════════════════
describe("Promotion flow (promoteNext)", () => {
  it("promotes first WAITLIST candidate to PENDING_ACKNOWLEDGMENT", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "promote@test.com" });
    const waitApp = await seedWaitlistApplication(applicant.id, job.id, 1);

    await db.transaction(async (tx) => {
      await promoteNext(job.id, job.capacity, tx);
    });

    // Status updated
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, waitApp.id));

    expect(app.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(app.promotedAt).not.toBeNull();
    expect(app.acknowledgeDeadline).not.toBeNull();

    // Queue entry removed
    const queueEntries = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, waitApp.id));

    expect(queueEntries.length).toBe(0);
  });

  it("promotes lowest position first (FIFO fairness)", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    const a1 = await seedApplicant({ email: "first@fifo.com" });
    const a2 = await seedApplicant({ email: "second@fifo.com" });

    const app1 = await seedWaitlistApplication(a1.id, job.id, 1);
    const app2 = await seedWaitlistApplication(a2.id, job.id, 2);

    await db.transaction(async (tx) => {
      await promoteNext(job.id, job.capacity, tx);
    });

    // app1 (position 1) promoted
    const [promoted] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, app1.id));
    expect(promoted.status).toBe("PENDING_ACKNOWLEDGMENT");

    // app2 (position 2) still waiting
    const [still_waiting] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, app2.id));
    expect(still_waiting.status).toBe("WAITLIST");
  });

  it("does not promote when capacity is full", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    const a1 = await seedApplicant({ email: "active@cap.com" });
    const a2 = await seedApplicant({ email: "waiting@cap.com" });

    await seedActiveApplication(a1.id, job.id);
    const waitApp = await seedWaitlistApplication(a2.id, job.id, 1);

    await db.transaction(async (tx) => {
      await promoteNext(job.id, job.capacity, tx);
    });

    // waitApp should still be WAITLIST
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, waitApp.id));
    expect(app.status).toBe("WAITLIST");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. ACKNOWLEDGMENT FLOW — PENDING → ACTIVE
// ═══════════════════════════════════════════════════════════════════════════════
describe("Acknowledgment flow", () => {
  it("transitions PENDING_ACKNOWLEDGMENT → ACTIVE on valid acknowledge", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    const result = await applyPublic("Dave", "dave@ack.com", job.id);
    expect(result.status).toBe("PENDING_ACKNOWLEDGMENT");

    const ackResult = await acknowledgePromotion(result.applicationId);
    expect(ackResult.status).toBe("ACTIVE");

    // Verify DB
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, result.applicationId));

    expect(app.status).toBe("ACTIVE");
    expect(app.acknowledgedAt).not.toBeNull();
    expect(app.acknowledgeDeadline).toBeNull();
  });

  it("writes ACKNOWLEDGED audit log", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    const result = await applyPublic("Eve", "eve@ack.com", job.id);
    await acknowledgePromotion(result.applicationId);

    const logs = await db
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.applicationId, result.applicationId),
          eq(auditLogsTable.eventType, "ACKNOWLEDGED")
        )
      );

    expect(logs.length).toBe(1);
    expect(logs[0].fromStatus).toBe("PENDING_ACKNOWLEDGMENT");
    expect(logs[0].toStatus).toBe("ACTIVE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. EXPIRY + DECAY + REQUEUE — full cycle
// ═══════════════════════════════════════════════════════════════════════════════
describe("Expiry + decay + requeue flow", () => {
  it("decays expired PENDING_ACKNOWLEDGMENT → WAITLIST with penalty", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "expire@decay.com" });

    // Seed expired pending app
    const expiredApp = await seedPendingApplication(
      applicant.id,
      job.id,
      new Date(Date.now() - 60_000) // expired 1 min ago
    );

    await db.transaction(async (tx) => {
      await checkAndDecayExpiredAcknowledgments(job.id, job.capacity, tx);
    });

    // Status → WAITLIST
    const [app] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, expiredApp.id));

    expect(app.status).toBe("WAITLIST");
    expect(app.penaltyCount).toBe(1);
    expect(app.acknowledgeDeadline).toBeNull();

    // Queue position reassigned
    const [qp] = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, expiredApp.id));

    expect(qp).toBeDefined();
    expect(qp.position).toBeGreaterThanOrEqual(1);
  });

  it("promotes next waitlisted candidate after expiry", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    const a1 = await seedApplicant({ email: "expired@promo.com" });
    const a2 = await seedApplicant({ email: "next@promo.com" });

    // a1 has expired pending slot, a2 is waitlisted
    await seedPendingApplication(a1.id, job.id, new Date(Date.now() - 60_000));
    const waitApp = await seedWaitlistApplication(a2.id, job.id, 1);

    await db.transaction(async (tx) => {
      await checkAndDecayExpiredAcknowledgments(job.id, job.capacity, tx);
    });

    // a2 should be promoted
    const [promoted] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, waitApp.id));

    expect(promoted.status).toBe("PENDING_ACKNOWLEDGMENT");
  });

  it("runDecayForJob processes full decay cycle via transaction wrapper", async () => {
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "rundecay@test.com" });

    await seedPendingApplication(
      applicant.id,
      job.id,
      new Date(Date.now() - 60_000)
    );

    const result = await runDecayForJob(job.id, job.capacity);

    expect(result.success).toBe(true);
    expect(result.decayed).toBe(1);
  });

  it("writes DECAY_TRIGGERED audit log on expiry", async () => {
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
//  6. FULL LIFECYCLE — apply → promote → acknowledge → withdraw → cascade
// ═══════════════════════════════════════════════════════════════════════════════
describe("Full lifecycle across all services", () => {
  it("apply → acknowledge → withdraw → next promoted (end-to-end)", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    // Step 1: Alice applies (PENDING_ACKNOWLEDGMENT)
    const alice = await applyPublic("Alice", "alice@e2e.com", job.id);
    expect(alice.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Step 2: Bob applies (WAITLIST)
    const bob = await applyPublic("Bob", "bob@e2e.com", job.id);
    expect(bob.status).toBe("WAITLIST");

    // Step 3: Alice acknowledges → ACTIVE
    const ack = await acknowledgePromotion(alice.applicationId);
    expect(ack.status).toBe("ACTIVE");

    // Step 4: Alice withdraws → slot opens → Bob promoted
    await withdrawApplication(alice.applicationId);

    // Step 5: Verify Alice is INACTIVE
    const [aliceApp] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, alice.applicationId));
    expect(aliceApp.status).toBe("INACTIVE");

    // Step 6: Verify Bob is now PENDING_ACKNOWLEDGMENT
    const [bobApp] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, bob.applicationId));
    expect(bobApp.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Step 7: Bob acknowledges → ACTIVE
    const bobAck = await acknowledgePromotion(bob.applicationId);
    expect(bobAck.status).toBe("ACTIVE");
  });

  it("apply → expire → decay → requeue → promote → acknowledge", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    const a1 = await seedApplicant({ email: "expire-e2e@test.com" });
    const a2 = await seedApplicant({ email: "next-e2e@test.com" });

    // a1 gets the slot (expired deadline)
    const expApp = await seedPendingApplication(
      a1.id,
      job.id,
      new Date(Date.now() - 60_000)
    );

    // a2 is waitlisted
    const waitApp = await seedWaitlistApplication(a2.id, job.id, 1);

    // Run decay — a1 goes to WAITLIST, a2 gets promoted
    const decayResult = await runDecayForJob(job.id, job.capacity);
    expect(decayResult.success).toBe(true);
    expect(decayResult.decayed).toBe(1);

    // a1 is WAITLIST with penalty
    const [a1App] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, expApp.id));
    expect(a1App.status).toBe("WAITLIST");
    expect(a1App.penaltyCount).toBe(1);

    // a2 is PENDING_ACKNOWLEDGMENT
    const [a2App] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, waitApp.id));
    expect(a2App.status).toBe("PENDING_ACKNOWLEDGMENT");

    // a2 acknowledges → ACTIVE
    const ackResult = await acknowledgePromotion(waitApp.id);
    expect(ackResult.status).toBe("ACTIVE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  7. ACTIVE COUNT — cross-service verification
// ═══════════════════════════════════════════════════════════════════════════════
describe("Active count accuracy", () => {
  it("counts ACTIVE + PENDING_ACKNOWLEDGMENT correctly after mixed operations", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 10 });

    const a1 = await seedApplicant({ email: "active1@count.com" });
    const a2 = await seedApplicant({ email: "pending1@count.com" });
    const a3 = await seedApplicant({ email: "waitlist1@count.com" });

    await seedActiveApplication(a1.id, job.id);
    await seedPendingApplication(a2.id, job.id, new Date(Date.now() + 300_000));
    await seedWaitlistApplication(a3.id, job.id, 1);

    let count = 0;
    await db.transaction(async (tx) => {
      count = await getActiveCount(job.id, tx);
    });

    // 1 ACTIVE + 1 PENDING = 2 (WAITLIST excluded)
    expect(count).toBe(2);
  });
});
