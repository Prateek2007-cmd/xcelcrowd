/**
 * API-level integration tests — full HTTP request → Express → service → DB → response.
 *
 * HIGH ASSERTION DENSITY: Every test validates:
 *   1. HTTP status code
 *   2. Response body structure and values
 *   3. Database state after the operation
 *   4. Side effects (queue positions, audit logs, status transitions)
 *
 * Uses real PostgreSQL database (no mocks).
 * Run with: pnpm test:api
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { eq, and } from "drizzle-orm";
import {
  getTestDb,
  closeTestDb,
  cleanAllTables,
  seedJob,
  seedApplicant,
  seedPendingApplication,
  seedActiveApplication,
  applicationsTable,
  applicantsTable,
  queuePositionsTable,
  auditLogsTable,
} from "./setupTestDb";

// ── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(async () => {
  await cleanAllTables();
});

afterAll(async () => {
  await cleanAllTables();
  await closeTestDb();
});

// ═══════════════════════════════════════════════════════════════════════════════
//  1. POST /api/apply-public — Public application flow
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/apply-public", () => {
  it("creates applicant + application + audit log, returns correct body", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    const res = await request(app)
      .post("/api/apply-public")
      .send({ name: "Prateek", email: "prateek@test.com", jobId: job.id })
      .expect(201);

    // ── Response body assertions ──
    expect(res.body.applicationId).toBeGreaterThan(0);
    expect(res.body.applicantId).toBeGreaterThan(0);
    expect(res.body.jobId).toBe(job.id);
    expect(res.body.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(res.body.queuePosition).toBeNull();
    expect(res.body.message).toContain("promoted");

    // ── DB: applicant created ──
    const [applicant] = await db
      .select()
      .from(applicantsTable)
      .where(eq(applicantsTable.email, "prateek@test.com"));
    expect(applicant).toBeDefined();
    expect(applicant.name).toBe("Prateek");
    expect(applicant.id).toBe(res.body.applicantId);

    // ── DB: application created with correct fields ──
    const [application] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, res.body.applicationId));
    expect(application).toBeDefined();
    expect(application.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(application.jobId).toBe(job.id);
    expect(application.applicantId).toBe(res.body.applicantId);
    expect(application.promotedAt).not.toBeNull();
    expect(application.acknowledgeDeadline).not.toBeNull();
    // Deadline should be ~10 minutes in the future
    expect(application.acknowledgeDeadline!.getTime()).toBeGreaterThan(Date.now());

    // ── DB: audit logs written (APPLIED + PROMOTED) ──
    const logs = await db
      .select()
      .from(auditLogsTable)
      .where(eq(auditLogsTable.applicationId, res.body.applicationId));
    expect(logs.length).toBe(2);
    expect(logs.map((l) => l.eventType).sort()).toEqual(["APPLIED", "PROMOTED"]);

    // ── No queue position (capacity available) ──
    const queueEntries = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, res.body.applicationId));
    expect(queueEntries.length).toBe(0);
  });

  it("reuses existing applicant on duplicate email — single applicant row, new application", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    // First application
    const res1 = await request(app)
      .post("/api/apply-public")
      .send({ name: "Prateek", email: "dup@test.com", jobId: job.id })
      .expect(201);

    // Withdraw so we can re-apply
    await request(app)
      .post("/api/withdraw")
      .send({ applicationId: res1.body.applicationId })
      .expect(200);

    // Second application — same email
    const res2 = await request(app)
      .post("/api/apply-public")
      .send({ name: "Prateek Updated", email: "dup@test.com", jobId: job.id })
      .expect(201);

    // ── Same applicant reused ──
    expect(res2.body.applicantId).toBe(res1.body.applicantId);
    // ── Different application ID ──
    expect(res2.body.applicationId).not.toBe(res1.body.applicationId);

    // ── DB: only ONE applicant row ──
    const applicants = await db
      .select()
      .from(applicantsTable)
      .where(eq(applicantsTable.email, "dup@test.com"));
    expect(applicants.length).toBe(1);

    // ── DB: TWO application rows (one INACTIVE, one new) ──
    const apps = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.applicantId, res1.body.applicantId));
    expect(apps.length).toBe(2);
    expect(apps.filter((a) => a.status === "INACTIVE").length).toBe(1);
    expect(apps.filter((a) => a.status !== "INACTIVE").length).toBe(1);
  });

  it("returns 409 with structured error for duplicate active application", async () => {
    const job = await seedJob({ capacity: 5 });

    await request(app)
      .post("/api/apply-public")
      .send({ name: "Alice", email: "alice@test.com", jobId: job.id })
      .expect(201);

    const res = await request(app)
      .post("/api/apply-public")
      .send({ name: "Alice", email: "alice@test.com", jobId: job.id })
      .expect(409);

    // ── Unified error contract ──
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("DUPLICATE_SUBMISSION");
    expect(res.body.error.message).toContain("already has an active application");
    expect(res.body.error.details).toBeNull();
  });

  it("returns 404 with structured error when job does not exist", async () => {
    const res = await request(app)
      .post("/api/apply-public")
      .send({ name: "Bob", email: "bob@test.com", jobId: 99999 })
      .expect(404);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.message).toContain("99999");
  });

  it("returns 400 with structured error when body fields are missing", async () => {
    const res = await request(app)
      .post("/api/apply-public")
      .send({})
      .expect(400);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBeDefined();
    expect(typeof res.body.error.message).toBe("string");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Capacity: PENDING_ACKNOWLEDGMENT vs WAITLIST
// ═══════════════════════════════════════════════════════════════════════════════

describe("Capacity management — PENDING vs WAITLIST", () => {
  it("first applicant gets PENDING, second gets WAITLIST with correct queue position", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    const res1 = await request(app)
      .post("/api/apply-public")
      .send({ name: "First", email: "first@test.com", jobId: job.id })
      .expect(201);

    // ── First: PENDING_ACKNOWLEDGMENT ──
    expect(res1.body.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(res1.body.queuePosition).toBeNull();

    const res2 = await request(app)
      .post("/api/apply-public")
      .send({ name: "Second", email: "second@test.com", jobId: job.id })
      .expect(201);

    // ── Second: WAITLIST with position ──
    expect(res2.body.status).toBe("WAITLIST");
    expect(res2.body.queuePosition).toBeGreaterThanOrEqual(1);
    expect(res2.body.message).toContain("waitlist");

    // ── DB: queue position exists and matches response ──
    const [qp] = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, res2.body.applicationId));
    expect(qp).toBeDefined();
    expect(qp.position).toBe(res2.body.queuePosition);

    // ── DB: first has no queue entry ──
    const firstQp = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, res1.body.applicationId));
    expect(firstQp.length).toBe(0);

    // ── DB: statuses match response ──
    const [app1] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, res1.body.applicationId));
    const [app2] = await db.select().from(applicationsTable).where(eq(applicationsTable.id, res2.body.applicationId));
    expect(app1.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(app2.status).toBe("WAITLIST");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. POST /api/acknowledge — Acknowledgment flow
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/acknowledge", () => {
  it("transitions PENDING → ACTIVE: response, DB state, audit log all verified", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    const applyRes = await request(app)
      .post("/api/apply-public")
      .send({ name: "Charlie", email: "charlie@test.com", jobId: job.id })
      .expect(201);

    expect(applyRes.body.status).toBe("PENDING_ACKNOWLEDGMENT");

    const ackRes = await request(app)
      .post("/api/acknowledge")
      .send({ applicationId: applyRes.body.applicationId })
      .expect(200);

    // ── Response ──
    expect(ackRes.body.status).toBe("ACTIVE");
    expect(ackRes.body.applicationId).toBe(applyRes.body.applicationId);
    expect(ackRes.body.applicantId).toBe(applyRes.body.applicantId);
    expect(ackRes.body.message).toContain("ACTIVE");

    // ── DB: application state ──
    const [appRow] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, applyRes.body.applicationId));
    expect(appRow.status).toBe("ACTIVE");
    expect(appRow.acknowledgedAt).not.toBeNull();
    expect(appRow.acknowledgeDeadline).toBeNull(); // cleared after ack

    // ── DB: ACKNOWLEDGED audit log ──
    const logs = await db
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.applicationId, applyRes.body.applicationId),
          eq(auditLogsTable.eventType, "ACKNOWLEDGED")
        )
      );
    expect(logs.length).toBe(1);
    expect(logs[0].fromStatus).toBe("PENDING_ACKNOWLEDGMENT");
    expect(logs[0].toStatus).toBe("ACTIVE");
  });

  it("returns 410 for expired deadline — decays, requeues, penalizes", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "expired-ack@test.com" });

    const expiredApp = await seedPendingApplication(
      applicant.id,
      job.id,
      new Date(Date.now() - 60_000)
    );

    const res = await request(app)
      .post("/api/acknowledge")
      .send({ applicationId: expiredApp.id })
      .expect(410);

    // ── Response: unified error contract ──
    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("GONE");
    expect(res.body.error.message).toContain("expired");

    // ── DB: moved to WAITLIST with penalty ──
    const [appRow] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, expiredApp.id));
    expect(appRow.status).toBe("WAITLIST");
    expect(appRow.penaltyCount).toBe(1);
    expect(appRow.promotedAt).toBeNull();
    expect(appRow.acknowledgeDeadline).toBeNull();

    // ── DB: queue position reassigned ──
    const [qp] = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, expiredApp.id));
    expect(qp).toBeDefined();
    expect(qp.position).toBeGreaterThanOrEqual(1);

    // ── DB: DECAY_TRIGGERED audit log ──
    const decayLogs = await db
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.applicationId, expiredApp.id),
          eq(auditLogsTable.eventType, "DECAY_TRIGGERED")
        )
      );
    expect(decayLogs.length).toBe(1);
    expect(decayLogs[0].fromStatus).toBe("PENDING_ACKNOWLEDGMENT");
    expect(decayLogs[0].toStatus).toBe("WAITLIST");
  });

  it("returns 409 with correct error when application is not PENDING", async () => {
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "active-ack@test.com" });
    const activeApp = await seedActiveApplication(applicant.id, job.id);

    const res = await request(app)
      .post("/api/acknowledge")
      .send({ applicationId: activeApp.id })
      .expect(409);

    expect(res.body.error.code).toBe("CONFLICT");
    expect(res.body.error.message).toContain("not pending");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. POST /api/withdraw — Withdrawal flow
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/withdraw", () => {
  it("sets INACTIVE, clears fields, writes audit log, frees slot", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    const applyRes = await request(app)
      .post("/api/apply-public")
      .send({ name: "Diana", email: "diana@test.com", jobId: job.id })
      .expect(201);

    const withdrawRes = await request(app)
      .post("/api/withdraw")
      .send({ applicationId: applyRes.body.applicationId })
      .expect(200);

    // ── Response ──
    expect(withdrawRes.body.status).toBe("INACTIVE");
    expect(withdrawRes.body.applicationId).toBe(applyRes.body.applicationId);
    expect(withdrawRes.body.message).toContain("withdrawn");

    // ── DB: application state ──
    const [appRow] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, applyRes.body.applicationId));
    expect(appRow.status).toBe("INACTIVE");
    expect(appRow.withdrawnAt).not.toBeNull();
    expect(appRow.promotedAt).toBeNull();
    expect(appRow.acknowledgeDeadline).toBeNull();

    // ── DB: WITHDRAWN audit log ──
    const logs = await db
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.applicationId, applyRes.body.applicationId),
          eq(auditLogsTable.eventType, "WITHDRAWN")
        )
      );
    expect(logs.length).toBe(1);
    expect(logs[0].fromStatus).toBe("PENDING_ACKNOWLEDGMENT");
    expect(logs[0].toStatus).toBe("INACTIVE");

    // ── DB: no queue entries ──
    const qp = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, applyRes.body.applicationId));
    expect(qp.length).toBe(0);
  });

  it("promotes next waitlisted candidate after withdrawal — full cascade verified", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    const r1 = await request(app)
      .post("/api/apply-public")
      .send({ name: "Eve", email: "eve@test.com", jobId: job.id })
      .expect(201);
    expect(r1.body.status).toBe("PENDING_ACKNOWLEDGMENT");

    const r2 = await request(app)
      .post("/api/apply-public")
      .send({ name: "Frank", email: "frank@test.com", jobId: job.id })
      .expect(201);
    expect(r2.body.status).toBe("WAITLIST");

    // Eve withdraws
    await request(app)
      .post("/api/withdraw")
      .send({ applicationId: r1.body.applicationId })
      .expect(200);

    // ── DB: Frank promoted to PENDING_ACKNOWLEDGMENT ──
    const [frank] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, r2.body.applicationId));
    expect(frank.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(frank.promotedAt).not.toBeNull();
    expect(frank.acknowledgeDeadline).not.toBeNull();

    // ── DB: Frank's queue entry removed after promotion ──
    const frankQp = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, r2.body.applicationId));
    expect(frankQp.length).toBe(0);

    // ── DB: PROMOTED audit log for Frank ──
    const promoLogs = await db
      .select()
      .from(auditLogsTable)
      .where(
        and(
          eq(auditLogsTable.applicationId, r2.body.applicationId),
          eq(auditLogsTable.eventType, "PROMOTED")
        )
      );
    expect(promoLogs.length).toBe(1);
    expect(promoLogs[0].fromStatus).toBe("WAITLIST");
    expect(promoLogs[0].toStatus).toBe("PENDING_ACKNOWLEDGMENT");
  });

  it("returns 404 for non-existent application with structured error", async () => {
    const res = await request(app)
      .post("/api/withdraw")
      .send({ applicationId: 99999 })
      .expect(404);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.message).toContain("99999");
  });

  it("returns 409 when already INACTIVE with structured error", async () => {
    const job = await seedJob({ capacity: 5 });

    const applyRes = await request(app)
      .post("/api/apply-public")
      .send({ name: "Grace", email: "grace@test.com", jobId: job.id })
      .expect(201);

    await request(app)
      .post("/api/withdraw")
      .send({ applicationId: applyRes.body.applicationId })
      .expect(200);

    const res = await request(app)
      .post("/api/withdraw")
      .send({ applicationId: applyRes.body.applicationId })
      .expect(409);

    expect(res.body.error.code).toBe("CONFLICT");
    expect(res.body.error.message).toContain("already inactive");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. Full lifecycle: apply → acknowledge → withdraw → promote
// ═══════════════════════════════════════════════════════════════════════════════

describe("Full lifecycle — end to end", () => {
  it("apply → acknowledge → withdraw → next promoted: every state transition verified", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    // Step 1: Alice applies (PENDING_ACKNOWLEDGMENT)
    const alice = await request(app)
      .post("/api/apply-public")
      .send({ name: "Alice", email: "alice@lifecycle.com", jobId: job.id })
      .expect(201);
    expect(alice.body.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Step 2: Bob applies (WAITLIST)
    const bob = await request(app)
      .post("/api/apply-public")
      .send({ name: "Bob", email: "bob@lifecycle.com", jobId: job.id })
      .expect(201);
    expect(bob.body.status).toBe("WAITLIST");
    expect(bob.body.queuePosition).toBe(1);

    // Step 3: Alice acknowledges (ACTIVE)
    const ack = await request(app)
      .post("/api/acknowledge")
      .send({ applicationId: alice.body.applicationId })
      .expect(200);
    expect(ack.body.status).toBe("ACTIVE");

    // Step 4: Alice withdraws (INACTIVE → Bob promoted)
    await request(app)
      .post("/api/withdraw")
      .send({ applicationId: alice.body.applicationId })
      .expect(200);

    // ── Verify Alice is INACTIVE in DB ──
    const [aliceApp] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, alice.body.applicationId));
    expect(aliceApp.status).toBe("INACTIVE");

    // ── Verify Bob promoted to PENDING in DB ──
    const [bobApp] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, bob.body.applicationId));
    expect(bobApp.status).toBe("PENDING_ACKNOWLEDGMENT");
    expect(bobApp.promotedAt).not.toBeNull();

    // Step 5: Bob acknowledges (ACTIVE)
    const bobAck = await request(app)
      .post("/api/acknowledge")
      .send({ applicationId: bob.body.applicationId })
      .expect(200);
    expect(bobAck.body.status).toBe("ACTIVE");

    // ── Final DB state: Bob is ACTIVE, Alice is INACTIVE ──
    const [bobFinal] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, bob.body.applicationId));
    expect(bobFinal.status).toBe("ACTIVE");
    expect(bobFinal.acknowledgedAt).not.toBeNull();

    // ── Audit log count: comprehensive trail ──
    const allLogs = await db.select().from(auditLogsTable);
    // Alice: APPLIED, PROMOTED, ACKNOWLEDGED, WITHDRAWN
    // Bob:   APPLIED, PROMOTED (after withdraw), ACKNOWLEDGED
    // Total: 7 audit entries
    expect(allLogs.length).toBe(7);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. Error responses — unified contract
// ═══════════════════════════════════════════════════════════════════════════════

describe("Error response format — unified contract", () => {
  it("404 returns { error: { code, message, details } }", async () => {
    const res = await request(app)
      .post("/api/withdraw")
      .send({ applicationId: 99999 })
      .expect(404);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("NOT_FOUND");
    expect(res.body.error.message).toBeDefined();
    expect(typeof res.body.error.message).toBe("string");
    expect(res.body.error.details).toBeNull();
  });

  it("400 returns { error: { code, message } } on validation failure", async () => {
    const res = await request(app)
      .post("/api/apply-public")
      .send({})
      .expect(400);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBeDefined();
    expect(typeof res.body.error.message).toBe("string");
  });

  it("409 returns { error: { code, message, details: null } } on conflict", async () => {
    const job = await seedJob({ capacity: 5 });

    await request(app)
      .post("/api/apply-public")
      .send({ name: "Test", email: "conflict@test.com", jobId: job.id })
      .expect(201);

    const res = await request(app)
      .post("/api/apply-public")
      .send({ name: "Test", email: "conflict@test.com", jobId: job.id })
      .expect(409);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.code).toBe("DUPLICATE_SUBMISSION");
    expect(res.body.error.details).toBeNull();
  });
});
