# Hiring Pipeline — Capacity-Limited Queue Management System

A production-grade full-stack system that manages applicant queues for job positions, enforcing capacity limits, automatic waitlist promotion, acknowledgment deadlines, and decay penalties — with full auditability and concurrency safety.

---

## Problem Statement

Hiring teams managing high-volume job openings face a real coordination problem: more candidates apply than available slots. Without structure, this creates chaos — candidates don't know where they stand, slots get double-booked, and dropped candidates have no recourse.

This system solves that by treating each job opening as a **capacity-limited pipeline** with a formal queue. Applicants either get an active slot or join a waitlist in order. When slots open up, the system automatically promotes the next candidate — no manual intervention needed. Candidates who don't respond lose their spot and get re-queued with a penalty.

---

## Solution Overview

The system has two distinct faces:

- **Applicants** — apply to jobs, track their position and status, manage their applications
- **Company (OPS)** — create and manage job postings, monitor the pipeline, remove candidates

When an applicant submits an application:
1. If `active_count < capacity` → they get an **ACTIVE** slot immediately
2. If full → they join the **WAITLIST** with a numbered position
3. When a slot opens (withdrawal, removal, expiry) → the next waitlisted applicant is automatically promoted to **PENDING_ACKNOWLEDGMENT** with a 5-minute deadline
4. If they acknowledge → they become **ACTIVE**
5. If they don't → they're decayed back to **WAITLIST** with a penalty, and the next candidate is promoted

All state changes are atomic (PostgreSQL transactions), logged (audit trail), and protected against race conditions (row-level locking).

---

## Core Features

- **Capacity-limited jobs** — each job has a configurable number of active slots
- **Ordered waitlist** — applicants beyond capacity are queued with explicit position numbers
- **Automatic promotion** — when any slot opens, the next waitlisted applicant is promoted immediately
- **Acknowledgment window** — promoted applicants have 5 minutes to confirm; missed deadlines trigger decay
- **Inactivity decay** — expired promotions re-queue the applicant at the back with a penalty score
- **Cascade promotion** — after decay, the system fills all vacated slots before settling
- **Full audit log** — every state transition is recorded; the pipeline state at any past timestamp can be reconstructed
- **Concurrency safety** — `FOR UPDATE` row locking prevents double-booking even under simultaneous load
- **Applicant dashboard** — applicants log in by name/email, see all their applications, apply to more jobs, and withdraw — no account needed
- **Company dashboard** — create jobs, monitor active roster and waitlist, view timelines and decay events per job

---

## System Design

### Architecture

```
┌─────────────────────────────────────────┐
│           Frontend (React + Vite)        │
│     TailwindCSS · Radix UI · Wouter     │
│              Port 5173                   │
└──────────────────┬──────────────────────┘
                   │ /api proxy
┌──────────────────▼──────────────────────┐
│          API Server (Express 5)          │
│          TypeScript · Pino              │
│               Port 5000                 │
│                                         │
│  Routes → Services → Pipeline           │
│  Validation Middleware (Zod)            │
│  Global Error Handler                   │
│  Background Decay Worker (5s poll)      │
└──────────────────┬──────────────────────┘
                   │ Drizzle ORM
┌──────────────────▼──────────────────────┐
│              PostgreSQL                  │
│  jobs · applicants · applications       │
│  queue_positions · audit_logs           │
└─────────────────────────────────────────┘
```

### Monorepo Structure

```
├── artifacts/
│   ├── api-server/
│   │   └── src/
│   │       ├── routes/         # Thin handlers — parse, call service, respond
│   │       ├── services/       # Business logic (applicationService, pipeline)
│   │       ├── lib/            # Errors, state machine, logger, decay worker
│   │       ├── schemas/        # Server-local Zod schemas (PublicApplyBody, etc.)
│   │       └── middlewares/    # Validation, error handling
│   └── hiring-pipeline/        # React frontend (Vite)
├── lib/
│   ├── db/                     # Drizzle ORM schema + migrations
│   ├── api-zod/                # Shared Zod schemas (generated from OpenAPI)
│   └── api-client-react/       # React Query hooks (generated)
├── scripts/
│   └── seed.mjs                # Seed script (creates jobs, applicants, applications)
└── pnpm-workspace.yaml
```

### Separation of Concerns

**Routes** are intentionally thin — they validate the request body (via Zod middleware), call one service function, and return the result. No business logic, no direct DB access.

**Services** own all business logic. `applicationService.ts` handles apply/withdraw/acknowledge. `pipeline.ts` handles queue operations (count, promote, reindex, decay). Neither layer knows about HTTP.

**Schemas** are separated by ownership: shared API contracts live in `@workspace/api-zod` (generated from OpenAPI). Server-specific schemas (like `PublicApplyBody`) live in `src/schemas/application.ts`.

---

## State Machine

Every application follows a strict state machine. No ad-hoc status changes are allowed — all transitions go through `assertValidTransition()` in `lib/stateMachine.ts`, which throws `InvalidTransitionError` (422) on illegal moves.

```
                ┌──────────────┐
    ┌──────────►│   INACTIVE   │◄────────────────┐
    │           │  (withdrawn) │                 │
    │           └──────────────┘                 │
    │                  │                         │
    │            re-apply (new app)          withdraw
    │                  ▼                         │
    │          ┌──────────────┐                  │
  withdraw    │   WAITLIST   │──────────────────┤
    │          │  (queued)    │                  │
    │          └──────┬───────┘                  │
    │                 │                          │
    │         auto-promote                       │
    │                 ▼                          │
    │    ┌────────────────────────┐              │
    ├────│  PENDING_ACKNOWLEDGMENT │─────────────┤
    │    │   (5-min deadline)     │              │
    │    └───────┬───────┬────────┘              │
    │            │       │                       │
    │       acknowledge  expire → decay          │
    │            ▼       ▼                       │
    │        ┌──────┐  ┌─────────┐              │
    └────────│ACTIVE│  │WAITLIST │ (+ penalty)   │
             └──────┘  └────────-┘               │
                │                                │
                └────────────────────────────────┘
```

### Valid Transitions

| From | To | Trigger |
|------|----|---------|
| — | ACTIVE | Apply (slot available) |
| — | WAITLIST | Apply (job at capacity) |
| WAITLIST | PENDING_ACKNOWLEDGMENT | Auto-promotion (slot opens) |
| WAITLIST | INACTIVE | Withdraw |
| PENDING_ACKNOWLEDGMENT | ACTIVE | Applicant acknowledges in time |
| PENDING_ACKNOWLEDGMENT | WAITLIST | Deadline expires (decay + penalty) |
| PENDING_ACKNOWLEDGMENT | INACTIVE | Withdraw |
| ACTIVE | INACTIVE | Withdraw / Remove from pipeline |

---

## Inactivity Decay Logic

This is the most operationally complex part of the system. When an applicant is promoted to `PENDING_ACKNOWLEDGMENT`, they have a 5-minute window to respond. If they don't, the decay system handles it automatically.

### How Decay Works (Step by Step)

**1. Detection (every 5 seconds)**

A background worker (`lib/decayWorker.ts`) polls the database every 5 seconds for any applications where:
```sql
status = 'PENDING_ACKNOWLEDGMENT'
AND acknowledge_deadline < NOW()
```

It groups findings by job so each job's decay runs in its own transaction.

**2. Penalty transition (per expired application)**

Inside an atomic transaction:

```
PENDING_ACKNOWLEDGMENT → WAITLIST
penaltyCount             +1
promotedAt               → NULL
acknowledgeDeadline      → NULL
```

The new queue position is calculated as:
```
position = MAX(current_positions) + 1 + penaltyCount
```

This means repeat offenders land further back on every missed deadline — deliberate game-theory pressure.

**3. Cascade promotion**

After decay removes one or more occupants from active/pending slots, `promoteUntilFull()` runs inside the same transaction. It repeatedly promotes the next waitlisted applicant (by position) until either the queue is empty or the job is back at capacity. Each promotion sets a new 5-minute acknowledgment deadline.

**4. Audit trail**

Every decayed application gets a `DECAY_TRIGGERED` log entry. Every promotion gets a `PROMOTED` entry. If the system crashes mid-cycle, re-running is safe — the state machine prevents double-transitions.

**Important:** `EXPIRED` is **never a stored state**. There is no frozen application sitting in an expired limbo. Within 5 seconds of a deadline passing, the application is moved to `WAITLIST` and the next candidate is promoted. The UI may show a countdown reaching zero, but the database reflects the actual transitioned state.

---

## Concurrency Handling

### The Problem

If two applicants submit at exactly the same moment for a job with one remaining slot, both could independently read `activeCount = N-1 < capacity` and both proceed to insert an ACTIVE application — exceeding the job's limit.

### The Solution

**`getActiveCount()` uses `FOR UPDATE`:**

```sql
SELECT COUNT(*) as count
FROM applications
WHERE job_id = $1
  AND status IN ('ACTIVE', 'PENDING_ACKNOWLEDGMENT')
FOR UPDATE
```

The first transaction reaches this query and acquires an exclusive row lock. The second transaction blocks at this exact point. When the first commits (inserting an ACTIVE application), the second re-reads a count that now hits capacity — and correctly inserts a WAITLIST application instead.

**`getNextInQueue()` uses `FOR UPDATE SKIP LOCKED`:**

```sql
SELECT application_id, position
FROM queue_positions
WHERE job_id = $1
ORDER BY position
LIMIT 1
FOR UPDATE SKIP LOCKED
```

`SKIP LOCKED` prevents two concurrent promotion calls from both selecting the same candidate. If the top row is already locked by another promotion, the second transaction skips it rather than blocking — making concurrent promotions safe at scale.

**All state mutations run inside `db.transaction()`** with the `tx` handle propagated through the entire call chain — ensures no mixed-commit state between the capacity check and the application insert.

### Concurrency Validation

The core locking strategy is validated in `concurrency.test.ts`, which tests:

- Duplicate application detection within the same transaction
- Capacity boundary enforcement (N applicants for a job with capacity N-1)
- State machine rejection of illegal concurrent transitions
- getActiveCount returning correct values under mocked contention scenarios

**Known limitation:** The test suite mocks the database layer, which means it validates application-level logic but does not exercise actual PostgreSQL lock acquisition. True DB-level race conditions (two real concurrent connections racing on the same row) are not covered by the current suite.

**Path to full validation:** Integration tests using `Promise.all` to fire simultaneous requests against a live test database would validate that `FOR UPDATE` actually prevents double-booking under real PostgreSQL contention. This is the natural next step before a load-test environment.

---

## Audit Logging

Every status transition generates an immutable row in `audit_logs`:

| Event | Trigger |
|-------|---------|
| `APPLIED` | Applicant submits an application |
| `PROMOTED` | System promotes from WAITLIST → PENDING_ACKNOWLEDGMENT |
| `ACKNOWLEDGED` | Applicant confirms their promotion |
| `WITHDRAWN` | Applicant or company removes the application |
| `DECAY_TRIGGERED` | Promotion deadline expires; applicant re-queued |

Each log entry captures `fromStatus`, `toStatus`, `applicationId`, a `metadata` JSON blob (includes job ID, deadlines, penalty counts), and a `createdAt` timestamp.

Because every transition is logged, the pipeline state at any historical timestamp can be reconstructed by replaying events up to that point. This is exposed via `GET /api/pipeline/:jobId/replay?asOf=ISO8601` — useful for audits or debugging.

---

## API Overview

All endpoints are prefixed with `/api`.

### Jobs
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/jobs` | List jobs with live active/waitlist counts |
| `POST` | `/api/jobs` | Create a job with title, description, capacity |
| `GET` | `/api/jobs/:jobId` | Job detail with active roster and waitlist |

### Pipeline Actions
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/apply` | Apply (admin — requires applicantId) |
| `POST` | `/api/apply-public` | Apply (public — name + email, find-or-create) |
| `POST` | `/api/withdraw` | Withdraw an application (triggers promotion) |
| `POST` | `/api/acknowledge` | Acknowledge a promotion within deadline |

### Applicant Views
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/status/:id` | All applications + queue positions for an applicant |
| `GET` | `/api/timeline/:id` | Full audit event timeline for an applicant |

### Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/queue/:jobId` | Ordered waitlist for a job |
| `GET` | `/api/pipeline/:jobId/summary` | Stats: counts, avg times, decay events |
| `GET` | `/api/pipeline/:jobId/replay` | Reconstruct pipeline state at a past timestamp |

### Error Format

All errors follow a consistent structure:

```json
{
  "error": {
    "message": "Applicant 3 already has an active application for job 7",
    "code": "DUPLICATE_SUBMISSION"
  }
}
```

Machine-readable `code` fields (`NOT_FOUND`, `CONFLICT`, `GONE`, `INVALID_TRANSITION`, etc.) allow the frontend to handle errors precisely without string parsing.

---

## Frontend Strategy

The frontend is **not real-time**. It uses React Query's refetch-on-focus and manual refresh rather than WebSockets or Server-sent Events.

**Why:** A hiring pipeline doesn't need sub-second updates. An applicant checking their queue position tolerates a few seconds of latency. The added complexity of persistent WebSocket connections — connection management, reconnection logic, server-side broadcasting — is not justified for this use case.

**What this means in practice:**

- After submitting an application, the applicant is redirected to their dashboard which fetches fresh data
- After withdrawing, the UI optimistically updates and invalidates the relevant React Query cache key
- The company pipeline view refreshes on navigation and on explicit user actions
- The 5-second decay worker on the server means that even if a user is watching a countdown, the next page load will reflect the correct decayed state

If real-time updates become a requirement, the backend already emits enough structured events (audit logs) to support a `change data capture → SSE` pattern without architectural changes.

---

## Design Tradeoffs

| Decision | Chosen | Alternative | Reason |
|----------|--------|-------------|--------|
| **Frontend updates** | Polling / refetch | WebSockets / SSE | Lower complexity; adequate for hiring pipeline latency needs |
| **Decay trigger** | 5s background interval | PostgreSQL cron / triggers | Logic stays in application layer, fully unit-testable, no DB extension dependencies |
| **Concurrency** | Pessimistic locking (`FOR UPDATE`) | Optimistic locking (version column + retry) | Simpler to reason about; no retry loop needed; correct for the "last slot" scenario |
| **Queue reindex** | Single `UPDATE … FROM CTE` with `ROW_NUMBER()` | Loop-based N+1 updates | O(1) queries vs O(n); scales to large waitlists |
| **Schema validation** | Zod on every route (middleware) | Runtime duck-typing | Catches bad input at the boundary; consistent 400 error format |
| **State transitions** | Centralized adjacency map + `assertValidTransition()` | Ad-hoc per-service checks | Single source of truth; impossible to accidentally create an illegal state |
| **Error handling** | Typed error class hierarchy | Generic `Error` + status codes | Structured JSON output without switch statements; easy to add new error types |
| **Applicant identity** | Email-based find-or-create | Email + password auth | Zero friction for applicants; no auth layer to maintain in a pipeline demo |

---

## Performance Considerations

**Queue reindex is O(1) queries.**
After promoting a candidate, the queue needs to be renumbered. This is done with a single `UPDATE … FROM` statement using a `ROW_NUMBER() OVER (ORDER BY position)` CTE — one round-trip regardless of queue length. The previous loop-based approach sent N individual UPDATE queries.

**Capacity check is a single locked COUNT.**
`getActiveCount()` runs one `SELECT COUNT(*) … FOR UPDATE` inside the transaction. No individual row fetches, no application-level counting.

**Decay worker is lightweight.**
It only runs if there are expired `PENDING_ACKNOWLEDGMENT` rows. If the queue is empty or no deadlines have passed, the query returns zero rows and the worker exits the cycle in microseconds.

**Transactions are scoped tightly.**
Transactions wrap only the state-changing operations, not the validation reads. `getNextInQueue()` with `SKIP LOCKED` means concurrent promotions don't serialize on each other unnecessarily.

---

## Background Worker Design

The decay worker (`lib/decayWorker.ts`) uses a `setInterval` loop polling every 5 seconds. On each tick it:

1. Queries for any job that has at least one expired `PENDING_ACKNOWLEDGMENT` row
2. Runs the full decay + cascade promotion cycle for each affected job inside its own transaction
3. Logs results and exits; the next tick starts fresh regardless of what happened

### Why polling over event-driven

A `setInterval`-based approach was chosen deliberately over DB triggers or an external scheduler for two reasons:

- **Testability** — The decay logic lives in `pipeline.ts` as a pure service function. It can be called directly in tests without spinning up a cron daemon or mocking DB events.
- **No external dependencies** — No Redis, no BullMQ, no pg_cron. The system installs and runs with just Node + PostgreSQL.

### Tradeoffs

| Aspect | Current Behaviour | Implication |
|--------|-------------------|-------------|
| Timing precision | ±5 seconds | Acceptable for a 5-minute acknowledgment window; not suitable for sub-second SLAs |
| Guaranteed execution | Best-effort | A long-running previous tick could delay the next; heavy load can cause drift |
| Horizontal scaling | Single process | Two instances of the API server would both run the worker, causing duplicate decay attempts (mitigated by the state machine rejecting already-transitioned rows, but wasteful) |

### Path to production-grade scheduling

For a multi-instance or high-throughput deployment:

- Replace `setInterval` with **BullMQ** or **pg-boss** — both support distributed locks so only one worker processes a given job at a time
- Alternatively, use **PostgreSQL advisory locks** (`pg_try_advisory_lock`) to elect a single leader among instances before each decay cycle
- Add a dead-man's switch: alert if the decay worker hasn't logged a successful cycle within 30 seconds

---

## Future Improvements

- **Real-time updates** — The audit log already captures every state change. A CDC (Change Data Capture) → Server-Sent Events pipeline could give applicants live queue position updates without polling.
- **Configurable acknowledgment window** — Currently hardcoded at 5 minutes per job. Could be a per-job setting stored in the `jobs` table.
- **Email/SMS notifications** — On promotion, send the applicant a notification with a direct acknowledgment link rather than requiring them to check the dashboard.
- **Batch decay processing** — If thousands of jobs exist, the decay worker could process them in parallel (e.g., `Promise.all`) rather than serially.
- **Rate limiting** — The public `/apply-public` endpoint has no rate limiting, which is the right call for a demo but would need throttling in production.
- **Admin authentication** — The company dashboard currently has no authentication. A simple session-based or JWT auth layer would be needed for real deployment.
- **Distributed worker** — Replace `setInterval` with BullMQ or pg-boss to safely run the decay worker across multiple API server instances.

---
## 🔧 Dependency & Infrastructure Decisions

### Dependency Management

This project uses **pnpm** as the package manager for its monorepo setup.

Reasons:
- Efficient disk usage via content-addressable storage
- Fast installs across multiple workspaces (`artifacts/`, `lib/`)
- Deterministic builds using `pnpm-lock.yaml`

The lockfile is committed to ensure:
- Consistent dependency resolution across environments
- Reproducible builds in CI and local development

---

### Database Choice

**PostgreSQL** was chosen over alternatives (e.g., MySQL, MongoDB) because:

- Supports advanced row-level locking (`FOR UPDATE`, `SKIP LOCKED`)
- Strong transactional guarantees (ACID)
- Required for safe concurrent queue operations

These features are critical for enforcing capacity limits without race conditions.

---

### ORM Choice

**Drizzle ORM** was selected instead of Prisma/TypeORM because:

- Allows direct SQL control when needed (important for locking queries)
- Fully type-safe without heavy abstraction overhead
- Better suited for performance-critical query paths like queue operations

---

### API Layer

**Express 5** is used as the backend framework:

- Minimal and flexible (no over-opinionated structure)
- Easy integration with custom middleware (Zod validation, error handling)
- Keeps routing layer thin while delegating logic to services

---

### Background Worker Design

A **polling-based worker (`setInterval`)** is used instead of event-driven systems.

Reasoning:
- No external dependencies (e.g., Redis, BullMQ)
- Logic remains fully testable within application code
- Sufficient for a system where timing precision is not critical (5-minute windows)

Tradeoff:
- Not ideal for horizontally scaled environments
- Would be replaced with distributed job queues in production

---

### Concurrency Strategy

Instead of optimistic locking or retries, the system uses:

- `FOR UPDATE` → ensures safe capacity checks
- `FOR UPDATE SKIP LOCKED` → prevents duplicate queue promotions

This approach:
- Guarantees correctness without retry loops
- Keeps logic simple and deterministic
- Matches real-world transactional queue systems

---

### Environment Configuration

- `.env` is used for runtime configuration (DB connection, ports)
- `.replit` is included for cloud/dev environment bootstrapping
- Configuration is intentionally minimal to keep setup friction low

---

### Tradeoff Philosophy

Across the system, decisions favor:

- **Correctness over complexity**
- **Explicit control over abstraction**
- **Simplicity over premature scalability**

This ensures the system is easy to reason about while still being production-capable.

## Setup Instructions

### Prerequisites

| Tool | Version |
|------|---------|
| Node.js | ≥ 20 |
| pnpm | ≥ 9 |
| PostgreSQL | ≥ 15 |

### 1. Install

```bash
git clone <repo-url>
cd hiring-pipeline
pnpm install
```

### 2. Configure environment

**Root `.env`** (used by Drizzle migrations):
```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/hiring_pipeline
```

**`artifacts/api-server/.env`** (used by the API server):
```env
DATABASE_URL=postgresql://postgres:password@localhost:5432/hiring_pipeline
PORT=5000
```

### 3. Create the database

```bash
# In psql:
CREATE DATABASE hiring_pipeline;
```

### 4. Push schema

```bash
pnpm --filter @workspace/db push
```

### 5. Start the API server

```bash
pnpm --filter @workspace/api-server dev
```

You should see:
```
Server listening { port: 5000 }
Starting inactivity decay worker { intervalMs: 5000 }
```

### 6. Start the frontend

```bash
# In a separate terminal:
pnpm --filter @workspace/hiring-pipeline dev
```

Open **http://localhost:5173**

### 7. Seed sample data (optional)

```bash
node scripts/seed.mjs
```

Creates 3 jobs, 5 applicants, and sample applications.

### 8. Run tests

```bash
pnpm test
```

Runs all Vitest suites: state machine, error classes, validation middleware, business logic, concurrency, and error handler.

---

---

## Testing Strategy

### Philosophy

The test suite is designed around a layered validation model — each layer tests a single concern in isolation, which makes failures obvious and fixes targeted.

| Suite | Layer | What It Tests |
|-------|-------|---------------|
| `stateMachine.test.ts` | Pure logic | All valid/invalid transitions, immutability of transition result objects |
| `errors.test.ts` | Pure logic | Error class hierarchy, HTTP status codes, JSON serialization format |
| `errorHandler.test.ts` | Middleware | Express error handler, PostgreSQL constraint code mapping (23505, 23503) |
| `validate.test.ts` | Middleware | Zod validation middleware, error format on bad input |
| `businessLogic.test.ts` | Service | applyToJob, withdrawApplication, acknowledgePromotion with mocked DB |
| `concurrency.test.ts` | Service | Race condition logic, duplicate detection, capacity boundary cases |

Pure logic tests (`stateMachine`, `errors`) have no external dependencies and run in milliseconds. Service tests mock the DB layer to keep them fast and deterministic — not because integration matters less, but because unit correctness is a prerequisite for integration correctness.

### Limitations

**Assertion density** — Some suites test the happy path thoroughly but have thinner coverage of error branches (e.g., what happens if the DB throws mid-transaction). These paths are covered by the global error handler but are not individually exercised.

**Concurrency testing is logic-level, not DB-level** — `concurrency.test.ts` validates that the application code makes the right decisions given controlled inputs. It does not spin up two real PostgreSQL connections and race them against each other, so actual lock acquisition is not exercised in CI.

**No end-to-end tests** — There are no browser-level or HTTP-level integration tests. The API is validated through service-level tests only.

### Improvements Planned

- **Concurrent DB integration tests** — Use `Promise.all` to fire simultaneous `POST /api/apply` requests against a real test database and assert that exactly N applications become ACTIVE for a job with capacity N. This would validate that `FOR UPDATE` works as expected under real contention.
- **Increased error branch coverage** — Add explicit test cases for mid-transaction DB failures, constraint violation propagation, and `GoneError` on expired acknowledgment windows.
- **Contract tests** — Use the OpenAPI specification in `lib/api-spec` to validate that every endpoint response matches its declared schema.

---

## License

MIT
