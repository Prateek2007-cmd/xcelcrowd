/**
 * API-level integration tests — full HTTP request → Express → service → DB → response.
 *
 * Uses:
 *   - supertest to fire real HTTP requests against the Express app
 *   - real PostgreSQL database (no mocks)
 *   - cleanAllTables() for test isolation
 *
 * Run with: pnpm test:api
 */
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import request from "supertest";
import app from "../app";
import { eq } from "drizzle-orm";
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
  it("creates applicant and application, returns 201", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    const res = await request(app)
      .post("/api/apply-public")
      .send({ name: "Prateek", email: "prateek@test.com", jobId: job.id })
      .expect(201);

    expect(res.body).toHaveProperty("applicationId");
    expect(res.body).toHaveProperty("applicantId");
    expect(res.body.jobId).toBe(job.id);
    expect(res.body.status).toBeDefined();

    // Verify applicant was inserted in DB
    const [applicant] = await db
      .select()
      .from(applicantsTable)
      .where(eq(applicantsTable.email, "prateek@test.com"));
    expect(applicant).toBeDefined();
    expect(applicant.name).toBe("Prateek");

    // Verify application was created
    const [application] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, res.body.applicationId));
    expect(application).toBeDefined();
  });

  it("reuses existing applicant on duplicate email (no duplicate rows)", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    // First application
    const res1 = await request(app)
      .post("/api/apply-public")
      .send({ name: "Prateek", email: "dup@test.com", jobId: job.id })
      .expect(201);

    // Withdraw first so we can re-apply
    await request(app)
      .post("/api/withdraw")
      .send({ applicationId: res1.body.applicationId })
      .expect(200);

    // Second application — same email
    const res2 = await request(app)
      .post("/api/apply-public")
      .send({ name: "Prateek Updated", email: "dup@test.com", jobId: job.id })
      .expect(201);

    // Same applicant ID reused
    expect(res2.body.applicantId).toBe(res1.body.applicantId);

    // Only ONE applicant row exists
    const applicants = await db
      .select()
      .from(applicantsTable)
      .where(eq(applicantsTable.email, "dup@test.com"));
    expect(applicants.length).toBe(1);
  });

  it("returns 409 for duplicate active application to same job", async () => {
    const job = await seedJob({ capacity: 5 });

    await request(app)
      .post("/api/apply-public")
      .send({ name: "Alice", email: "alice@test.com", jobId: job.id })
      .expect(201);

    // Second apply to same job → 409
    const res = await request(app)
      .post("/api/apply-public")
      .send({ name: "Alice", email: "alice@test.com", jobId: job.id })
      .expect(409);

    expect(res.body.error).toBeDefined();
  });

  it("returns 404 when job does not exist", async () => {
    await request(app)
      .post("/api/apply-public")
      .send({ name: "Bob", email: "bob@test.com", jobId: 99999 })
      .expect(404);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  2. Capacity: PENDING_ACKNOWLEDGMENT vs WAITLIST
// ═══════════════════════════════════════════════════════════════════════════════

describe("Capacity management — PENDING vs WAITLIST", () => {
  it("first applicant gets PENDING_ACKNOWLEDGMENT, second goes to WAITLIST when capacity=1", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    const res1 = await request(app)
      .post("/api/apply-public")
      .send({ name: "First", email: "first@test.com", jobId: job.id })
      .expect(201);

    expect(res1.body.status).toBe("PENDING_ACKNOWLEDGMENT");

    const res2 = await request(app)
      .post("/api/apply-public")
      .send({ name: "Second", email: "second@test.com", jobId: job.id })
      .expect(201);

    expect(res2.body.status).toBe("WAITLIST");
    expect(res2.body.queuePosition).toBeGreaterThanOrEqual(1);

    // Verify queue position in DB
    const [qp] = await db
      .select()
      .from(queuePositionsTable)
      .where(eq(queuePositionsTable.applicationId, res2.body.applicationId));
    expect(qp).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  3. POST /api/acknowledge — Acknowledgment flow
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/acknowledge", () => {
  it("transitions PENDING_ACKNOWLEDGMENT → ACTIVE on valid acknowledgment", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });

    // Apply (gets PENDING_ACKNOWLEDGMENT)
    const applyRes = await request(app)
      .post("/api/apply-public")
      .send({ name: "Charlie", email: "charlie@test.com", jobId: job.id })
      .expect(201);

    expect(applyRes.body.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Acknowledge
    const ackRes = await request(app)
      .post("/api/acknowledge")
      .send({ applicationId: applyRes.body.applicationId })
      .expect(200);

    expect(ackRes.body.status).toBe("ACTIVE");
    expect(ackRes.body.applicationId).toBe(applyRes.body.applicationId);

    // Verify in DB
    const [app_row] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, applyRes.body.applicationId));
    expect(app_row.status).toBe("ACTIVE");
    expect(app_row.acknowledgedAt).not.toBeNull();
  });

  it("returns 410 (Gone) for expired acknowledgment deadline", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "expired-ack@test.com" });

    // Seed application with already-expired deadline
    const expiredApp = await seedPendingApplication(
      applicant.id,
      job.id,
      new Date(Date.now() - 60_000) // expired 1 min ago
    );

    const res = await request(app)
      .post("/api/acknowledge")
      .send({ applicationId: expiredApp.id })
      .expect(410);

    expect(res.body.error).toBeDefined();

    // Verify status changed to WAITLIST in DB
    const [app_row] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, expiredApp.id));
    expect(app_row.status).toBe("WAITLIST");
    expect(app_row.penaltyCount).toBe(1);
  });

  it("returns 409 when application is not PENDING_ACKNOWLEDGMENT", async () => {
    const job = await seedJob({ capacity: 5 });
    const applicant = await seedApplicant({ email: "active-ack@test.com" });
    const activeApp = await seedActiveApplication(applicant.id, job.id);

    await request(app)
      .post("/api/acknowledge")
      .send({ applicationId: activeApp.id })
      .expect(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  4. POST /api/withdraw — Withdrawal flow
// ═══════════════════════════════════════════════════════════════════════════════

describe("POST /api/withdraw", () => {
  it("sets status to INACTIVE and frees the slot", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    // Apply (fills the slot)
    const applyRes = await request(app)
      .post("/api/apply-public")
      .send({ name: "Diana", email: "diana@test.com", jobId: job.id })
      .expect(201);

    // Withdraw
    const withdrawRes = await request(app)
      .post("/api/withdraw")
      .send({ applicationId: applyRes.body.applicationId })
      .expect(200);

    expect(withdrawRes.body.status).toBe("INACTIVE");
    expect(withdrawRes.body.message).toContain("withdrawn");

    // Verify in DB
    const [app_row] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, applyRes.body.applicationId));
    expect(app_row.status).toBe("INACTIVE");
  });

  it("promotes next waitlisted candidate after withdrawal", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    // Fill the slot
    const r1 = await request(app)
      .post("/api/apply-public")
      .send({ name: "Eve", email: "eve@test.com", jobId: job.id })
      .expect(201);
    expect(r1.body.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Second goes to waitlist
    const r2 = await request(app)
      .post("/api/apply-public")
      .send({ name: "Frank", email: "frank@test.com", jobId: job.id })
      .expect(201);
    expect(r2.body.status).toBe("WAITLIST");

    // Eve withdraws → Frank should get promoted
    await request(app)
      .post("/api/withdraw")
      .send({ applicationId: r1.body.applicationId })
      .expect(200);

    // Verify Frank is now PENDING_ACKNOWLEDGMENT
    const [frank] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, r2.body.applicationId));
    expect(frank.status).toBe("PENDING_ACKNOWLEDGMENT");
  });

  it("returns 404 for non-existent application", async () => {
    await request(app)
      .post("/api/withdraw")
      .send({ applicationId: 99999 })
      .expect(404);
  });

  it("returns 409 when application is already INACTIVE", async () => {
    const job = await seedJob({ capacity: 5 });

    const applyRes = await request(app)
      .post("/api/apply-public")
      .send({ name: "Grace", email: "grace@test.com", jobId: job.id })
      .expect(201);

    // Withdraw once
    await request(app)
      .post("/api/withdraw")
      .send({ applicationId: applyRes.body.applicationId })
      .expect(200);

    // Withdraw again → 409
    await request(app)
      .post("/api/withdraw")
      .send({ applicationId: applyRes.body.applicationId })
      .expect(409);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  5. Full lifecycle: apply → acknowledge → withdraw → promote
// ═══════════════════════════════════════════════════════════════════════════════

describe("Full lifecycle — end to end", () => {
  it("apply → acknowledge → withdraw → next promoted", async () => {
    const db = getTestDb();
    const job = await seedJob({ capacity: 1 });

    // Step 1: Alice applies (gets PENDING_ACKNOWLEDGMENT)
    const alice = await request(app)
      .post("/api/apply-public")
      .send({ name: "Alice", email: "alice@lifecycle.com", jobId: job.id })
      .expect(201);
    expect(alice.body.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Step 2: Bob applies (gets WAITLIST)
    const bob = await request(app)
      .post("/api/apply-public")
      .send({ name: "Bob", email: "bob@lifecycle.com", jobId: job.id })
      .expect(201);
    expect(bob.body.status).toBe("WAITLIST");

    // Step 3: Alice acknowledges (becomes ACTIVE)
    const ack = await request(app)
      .post("/api/acknowledge")
      .send({ applicationId: alice.body.applicationId })
      .expect(200);
    expect(ack.body.status).toBe("ACTIVE");

    // Step 4: Alice withdraws (INACTIVE, slot opens)
    await request(app)
      .post("/api/withdraw")
      .send({ applicationId: alice.body.applicationId })
      .expect(200);

    // Step 5: Bob should now be PENDING_ACKNOWLEDGMENT (promoted)
    const [bobApp] = await db
      .select()
      .from(applicationsTable)
      .where(eq(applicationsTable.id, bob.body.applicationId));
    expect(bobApp.status).toBe("PENDING_ACKNOWLEDGMENT");

    // Step 6: Bob acknowledges
    const bobAck = await request(app)
      .post("/api/acknowledge")
      .send({ applicationId: bob.body.applicationId })
      .expect(200);
    expect(bobAck.body.status).toBe("ACTIVE");
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
//  6. Error responses — structured format
// ═══════════════════════════════════════════════════════════════════════════════

describe("Error response format", () => {
  it("returns structured { error: { message, code } } on 404", async () => {
    const res = await request(app)
      .post("/api/withdraw")
      .send({ applicationId: 99999 })
      .expect(404);

    expect(res.body.error).toBeDefined();
    expect(res.body.error.message).toBeDefined();
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("returns structured error on validation failure (missing body fields)", async () => {
    const res = await request(app)
      .post("/api/apply-public")
      .send({}) // missing all fields
      .expect(400);

    expect(res.body.error).toBeDefined();
  });
});
