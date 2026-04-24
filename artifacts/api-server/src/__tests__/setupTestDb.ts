/**
 * Integration test database setup.
 *
 * Connects to the REAL PostgreSQL instance using DATABASE_URL and provides
 * utilities for test isolation:
 *
 *   - `getTestDb()` — returns the shared Drizzle db instance
 *   - `cleanAllTables()` — truncates all tables in dependency order
 *   - `seedJob()` / `seedApplicant()` — insert minimal test fixtures
 *
 * WHY PostgreSQL (not SQLite)?
 *   The pipeline code uses PG-specific features: pgEnum, FOR UPDATE SKIP LOCKED,
 *   ROW_NUMBER() OVER, FILTER (WHERE ...), raw SQL templates.
 *   SQLite does not support any of these.
 *
 * ISOLATION STRATEGY:
 *   Each test file calls `cleanAllTables()` in beforeEach to start fresh.
 *   Tables are truncated in reverse-dependency order with CASCADE.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { sql } from "drizzle-orm";
import * as schema from "@workspace/db";

const { Pool } = pg;

// Re-export tables for convenience in tests
export const {
  jobsTable,
  applicantsTable,
  applicationsTable,
  queuePositionsTable,
  auditLogsTable,
} = schema;

// ── Singleton test pool + db ─────────────────────────────────────────────────

let testPool: pg.Pool | null = null;
let testDb: ReturnType<typeof drizzle> | null = null;

/**
 * Get (or create) the shared test database connection.
 * Uses DATABASE_URL from the environment — must point to a running PG instance.
 */
export function getTestDb() {
  if (!testDb) {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error(
        "DATABASE_URL is required for integration tests. " +
        "Set it in .env or pass it as an environment variable."
      );
    }

    testPool = new Pool({ connectionString: dbUrl });
    testDb = drizzle(testPool, { schema });
  }
  return testDb;
}

/**
 * Close the test pool. Call in afterAll() of each integration test file.
 */
export async function closeTestDb() {
  if (testPool) {
    await testPool.end();
    testPool = null;
    testDb = null;
  }
}

// ── Table cleanup ────────────────────────────────────────────────────────────

/**
 * Truncate all tables in reverse-dependency order.
 * Uses CASCADE to handle foreign key constraints.
 * Resets serial sequences so IDs start from 1 each test.
 */
export async function cleanAllTables() {
  const db = getTestDb();
  await db.execute(sql`
    TRUNCATE TABLE
      audit_logs,
      queue_positions,
      applications,
      applicants,
      jobs
    RESTART IDENTITY CASCADE
  `);
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

/**
 * Insert a job with the given capacity. Returns the full row.
 */
export async function seedJob(opts: { title?: string; capacity: number }) {
  const db = getTestDb();
  const [job] = await db
    .insert(jobsTable)
    .values({
      title: opts.title ?? "Test Job",
      capacity: opts.capacity,
    })
    .returning();
  return job;
}

/**
 * Insert an applicant. Returns the full row.
 */
export async function seedApplicant(opts?: { name?: string; email?: string }) {
  const db = getTestDb();
  const [applicant] = await db
    .insert(applicantsTable)
    .values({
      name: opts?.name ?? "Test User",
      email: opts?.email ?? `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`,
    })
    .returning();
  return applicant;
}

/**
 * Insert a WAITLIST application with a queue position.
 */
export async function seedWaitlistApplication(
  applicantId: number,
  jobId: number,
  position: number
) {
  const db = getTestDb();
  const [app] = await db
    .insert(applicationsTable)
    .values({
      applicantId,
      jobId,
      status: "WAITLIST",
    })
    .returning();

  await db.insert(queuePositionsTable).values({
    jobId,
    applicationId: app.id,
    position,
  });

  return app;
}

/**
 * Insert a PENDING_ACKNOWLEDGMENT application with a given deadline.
 */
export async function seedPendingApplication(
  applicantId: number,
  jobId: number,
  deadline: Date
) {
  const db = getTestDb();
  const [app] = await db
    .insert(applicationsTable)
    .values({
      applicantId,
      jobId,
      status: "PENDING_ACKNOWLEDGMENT",
      promotedAt: new Date(),
      acknowledgeDeadline: deadline,
    })
    .returning();
  return app;
}

/**
 * Insert an ACTIVE application.
 */
export async function seedActiveApplication(
  applicantId: number,
  jobId: number
) {
  const db = getTestDb();
  const [app] = await db
    .insert(applicationsTable)
    .values({
      applicantId,
      jobId,
      status: "ACTIVE",
      acknowledgedAt: new Date(),
    })
    .returning();
  return app;
}
