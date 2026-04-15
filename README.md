# 🏗️ Hiring Pipeline — Real-Time Queue Management System

A **production-grade, full-stack hiring pipeline** built with the PERN stack (PostgreSQL, Express, React, Node.js). It implements a real-time applicant queue with capacity-limited active slots, automatic waitlist promotion, acknowledgment deadlines, and decay penalties — all with transactional safety and row-level locking.

> **No third-party queue or scheduling libraries.** All queue logic, waitlist promotion, and decay timing is implemented from scratch.

---

## 📸 Features at a Glance

| Feature | Description |
|---------|-------------|
| **Capacity-Limited Jobs** | Each job has a fixed number of active slots |
| **Automatic Waitlisting** | Applicants beyond capacity are queued with position tracking |
| **Promotion Engine** | When a slot opens, the next waitlisted applicant is promoted |
| **Acknowledgment Window** | Promoted applicants must acknowledge within 5 minutes or lose their slot |
| **Decay & Penalty System** | Expired promotions trigger a penalty and re-queue at the back |
| **Audit Log & Replay** | Every state change is logged; pipeline state can be reconstructed at any past timestamp |
| **Concurrency-Safe** | `FOR UPDATE` row-level locking prevents race conditions |
| **Background Decay Worker** | Polls for expired acknowledgments every 5 seconds |

---

## 🏛️ Architecture

```
┌──────────────────────────────────────────────────────┐
│                    Frontend (React)                   │
│         Vite + TailwindCSS + Radix UI + Wouter       │
│                    Port 5173                          │
└──────────────────────┬───────────────────────────────┘
                       │ /api proxy
┌──────────────────────▼───────────────────────────────┐
│                  API Server (Express 5)               │
│              TypeScript + Pino Logger                 │
│                    Port 5000                          │
│  ┌─────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ Routes  │→ │   Services   │→ │    Pipeline     │ │
│  │ (thin)  │  │ (biz logic)  │  │ (state machine) │ │
│  └─────────┘  └──────────────┘  └─────────────────┘ │
│  ┌─────────────────┐  ┌──────────────────────────┐   │
│  │  Error Handler  │  │   Validation Middleware   │   │
│  │  (PG codes)     │  │   (Zod schemas)           │   │
│  └─────────────────┘  └──────────────────────────┘   │
└──────────────────────┬───────────────────────────────┘
                       │ Drizzle ORM
┌──────────────────────▼───────────────────────────────┐
│                   PostgreSQL                          │
│       Jobs · Applicants · Applications ·              │
│       Queue Positions · Audit Logs                    │
└──────────────────────────────────────────────────────┘
```

### Monorepo Structure

```
├── artifacts/
│   ├── api-server/          # Express API server
│   │   ├── src/
│   │   │   ├── routes/      # Thin route handlers (parse → service → respond)
│   │   │   ├── services/    # Business logic (applicationService, pipeline)
│   │   │   ├── lib/         # Errors, state machine, logger, decay worker
│   │   │   ├── middlewares/ # Error handler, validation
│   │   │   └── __tests__/   # Vitest unit + integration tests
│   │   └── vitest.config.ts
│   ├── hiring-pipeline/     # React frontend (Vite)
│   └── mockup-sandbox/      # UI prototyping sandbox
├── lib/
│   ├── db/                  # Drizzle ORM schema + migrations
│   ├── api-zod/             # Shared Zod schemas for API contracts
│   ├── api-spec/            # OpenAPI specification
│   └── api-client-react/    # Generated React Query hooks
├── scripts/
│   └── seed.mjs             # Database seeder (via API)
├── pnpm-workspace.yaml      # Monorepo config
└── package.json
```

---

## 🚀 Getting Started

### Prerequisites

| Tool | Version | Notes |
|------|---------|-------|
| **Node.js** | ≥ 20 | Required for `--env-file` flag |
| **pnpm** | ≥ 9 | Monorepo workspace manager |
| **PostgreSQL** | ≥ 15 | Must be running locally |

### Step 1 — Clone & Install

```bash
git clone https://github.com/Prateek2007-cmd/xcelcrowd.git
cd xcelcrowd
pnpm install
```

### Step 2 — Set Up PostgreSQL

Make sure PostgreSQL is running. Create a database:

```sql
CREATE DATABASE hiring_pipeline;
```

### Step 3 — Configure Environment Variables

**Root `.env`** (used by Drizzle migrations and the DB library):

```env
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/hiring_pipeline
```

**`artifacts/api-server/.env`** (used by the API server at runtime):

```env
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/hiring_pipeline
PORT=5000
```

> ⚠️ **Security:** Never commit `.env` files. They are already in `.gitignore`.

### Step 4 — Push Database Schema

This uses Drizzle Kit to create all tables in PostgreSQL:

```bash
pnpm --filter @workspace/db push
```

### Step 5 — Start the API Server

```bash
pnpm --filter @workspace/api-server dev
```

This builds and starts the Express API at **http://localhost:5000**. You should see:

```
Server listening { port: 5000 }
Decay worker started (interval: 5s)
```

### Step 6 — Start the Frontend

In a **separate terminal**:

```bash
pnpm --filter @workspace/hiring-pipeline dev
```

Open **http://localhost:5173** in your browser. The Vite dev server proxies `/api/*` requests to `localhost:5000`.

### Step 7 — Seed the Database (Optional)

With the API server running, populate sample data:

```bash
node scripts/seed.mjs
```

This creates **3 jobs**, **5 applicants**, and submits sample applications so the dashboard is immediately populated.

### Step 8 — Run Tests

```bash
# From the project root
pnpm test
```

This runs all Vitest suites in `artifacts/api-server/src/__tests__/`.

---

### 🔧 Troubleshooting

| Issue | Solution |
|-------|---------|
| `DATABASE_URL must be set` | Ensure `.env` exists in **both** the project root and `artifacts/api-server/` |
| `PORT environment variable is required` | Ensure `artifacts/api-server/.env` contains `PORT=5000` |
| `FATAL: password authentication failed` | Check your PostgreSQL password in `DATABASE_URL` |
| `relation "jobs" does not exist` | Run `pnpm --filter @workspace/db push` to create tables |
| `ECONNREFUSED 127.0.0.1:5000` on frontend | Start the API server first before the frontend |
| `pnpm: command not found` | Install pnpm: `npm install -g pnpm` |

## 📡 API Reference

All endpoints are prefixed with `/api`.

### Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/healthz` | Health check |

### Jobs

| Method | Endpoint | Description | Request Body | Response |
|--------|----------|-------------|-------------|----------|
| `GET` | `/api/jobs` | List all jobs | — | `Job[]` with activeCount, waitlistCount |
| `POST` | `/api/jobs` | Create a job | `{ title, description?, capacity }` | `201` Created job |
| `GET` | `/api/jobs/:jobId` | Job detail with applicants | — | Job + active/waitlist applicants |

### Applicants

| Method | Endpoint | Description | Request Body | Response |
|--------|----------|-------------|-------------|----------|
| `GET` | `/api/applicants` | List all applicants | — | `Applicant[]` |
| `POST` | `/api/applicants` | Register an applicant | `{ name, email }` | `201` Created applicant |
| `GET` | `/api/applicants/:id` | Get applicant by ID | — | Applicant details |
| `GET` | `/api/status/:id` | Applicant's application status | — | All applications with queue positions |
| `GET` | `/api/timeline/:id` | Applicant's audit event timeline | — | Ordered audit log entries |

### Applications (Pipeline Actions)

| Method | Endpoint | Description | Request Body | Response |
|--------|----------|-------------|-------------|----------|
| `POST` | `/api/apply` | Apply to a job | `{ applicantId, jobId }` | `201` ACTIVE or WAITLIST |
| `POST` | `/api/withdraw` | Withdraw an application | `{ applicationId }` | INACTIVE + triggers promotion |
| `POST` | `/api/acknowledge` | Acknowledge a promotion | `{ applicationId }` | ACTIVE (or `410` if expired) |

### Pipeline Analytics

| Method | Endpoint | Description | Query Params | Response |
|--------|----------|-------------|-------------|----------|
| `GET` | `/api/queue/:jobId` | Waitlist queue for a job | — | Queue entries with positions |
| `GET` | `/api/pipeline/:jobId/summary` | Pipeline stats | — | Counts, avg times, decay events |
| `GET` | `/api/pipeline/:jobId/replay` | Reconstruct past state | `?asOf=ISO8601` | Active/waitlist at that timestamp |

### Error Response Format

All errors return a consistent structure:

```json
{
  "error": {
    "message": "Human-readable description",
    "code": "MACHINE_READABLE_CODE"
  }
}
```

| Code | HTTP | Description |
|------|------|-------------|
| `VALIDATION_ERROR` | 400 | Invalid input (Zod validation failure) |
| `NOT_FOUND` | 404 | Resource does not exist |
| `CONFLICT` | 409 | Duplicate or invalid state |
| `DUPLICATE_SUBMISSION` | 409 | Active application already exists |
| `GONE` | 410 | Acknowledgment window expired |
| `INVALID_TRANSITION` | 422 | Illegal state change |
| `DATABASE_ERROR` | 500 | Internal error |

---

## 🔄 State Machine

Every application follows this state machine:

```
                 ┌─────────────────┐
        ┌───────►│    INACTIVE      │◄──────────────┐
        │        │  (withdrawn)     │               │
        │        └─────────────────┘               │
        │               │                          │
        │         re-apply                    withdraw
        │               ▼                          │
        │        ┌──────────────┐                  │
   withdraw      │   WAITLIST    │──────────────────┤
        │        │  (queued)     │                  │
        │        └──────┬───────┘                  │
        │               │                          │
        │          promote (auto)                   │
        │               ▼                          │
        │     ┌─────────────────────┐              │
        ├─────│ PENDING_ACKNOWLEDGMENT│─────────────┤
        │     │  (5 min deadline)    │              │
        │     └────────┬──────┬─────┘              │
        │              │      │                    │
        │        acknowledge  expire (decay)        │
        │              ▼      ▼                    │
        │        ┌──────┐  ┌────────┐              │
        └────────│ACTIVE│  │WAITLIST │ (with penalty)
                 │      │  │ (back) │
                 └──────┘  └────────┘
```

### Valid Transitions

| From | To | Trigger |
|------|----|---------|
| INACTIVE | ACTIVE | Apply (capacity available) |
| INACTIVE | WAITLIST | Apply (capacity full) |
| WAITLIST | PENDING_ACKNOWLEDGMENT | Auto-promotion |
| WAITLIST | INACTIVE | Withdraw |
| PENDING_ACKNOWLEDGMENT | ACTIVE | Acknowledge |
| PENDING_ACKNOWLEDGMENT | WAITLIST | Deadline expired (decay) |
| PENDING_ACKNOWLEDGMENT | INACTIVE | Withdraw |
| ACTIVE | INACTIVE | Withdraw |

---

## 🧪 Testing

```bash
# Run all tests
pnpm test

# Run with watch mode
pnpm --filter @workspace/api-server test:watch
```

### Test Suites

| Suite | Tests | Coverage |
|-------|-------|----------|
| `stateMachine.test.ts` | 16 | All valid/invalid transitions, immutability |
| `errors.test.ts` | 12 | Error classes, status codes, JSON format |
| `errorHandler.test.ts` | 10 | Middleware, PG constraint mapping (23505, 23503) |
| `concurrency.test.ts` | 20 | Race conditions, edge cases, duplicate detection |
| `businessLogic.test.ts` | 13 | Service functions with mocked DB |
| `validate.test.ts` | 5 | Validation middleware |

---

## 🔒 Concurrency Safety

All capacity-critical operations use PostgreSQL row-level locking:

- **`FOR UPDATE`** on `getActiveCount()` — locks application rows during capacity checks, preventing two concurrent `/apply` requests from both getting active slots when only one is available
- **`FOR UPDATE SKIP LOCKED`** on `getNextInQueue()` — safely selects the next waitlist candidate without blocking other concurrent promotions; skips rows already locked by another transaction
- **All state mutations** run inside `db.transaction()` with the `tx` parameter propagated through the entire call chain, ensuring reads and writes are always transactionally consistent
- **Duplicate detection** — before inserting a new application, existing active applications are checked within the same transaction to prevent double-submission

### Concurrency Test Scenario

```
Job capacity = 1 (1 active slot)
Two users apply simultaneously:
  Thread A: reads activeCount = 0, acquires FOR UPDATE lock
  Thread B: reads activeCount = 0, BLOCKS waiting for lock
  Thread A: inserts ACTIVE application, commits
  Thread B: lock released, re-reads activeCount = 1 → inserts WAITLIST
Result: exactly 1 ACTIVE, 1 WAITLIST — no double-booking
```

---

## ⏱️ Inactivity Decay Logic

The decay system automatically handles applicants who fail to acknowledge a promotion:

### Trigger Condition
```
status = 'PENDING_ACKNOWLEDGMENT' AND acknowledgeDeadline < NOW()
```

### Decay Sequence (atomic transaction per job)

1. **Detect** — background worker queries for expired `PENDING_ACKNOWLEDGMENT` rows every 5 seconds
2. **Penalize** — `PENDING_ACKNOWLEDGMENT → WAITLIST` with `penaltyCount++`
3. **Re-queue at back** — new waitlist position = `MAX(position) + 1 + penaltyCount` (penalty pushes further back on repeat offenses)
4. **Clear state** — `promotedAt`, `acknowledgeDeadline` both set to `NULL`
5. **Cascade promote** — fills all vacated slots by promoting next WAITLIST candidates to `PENDING_ACKNOWLEDGMENT` with fresh 5-minute deadlines
6. **Audit log** — `DECAY_TRIGGERED` event recorded for every decayed application

### Important: No "EXPIRED" State

`EXPIRED` is **never stored** in the database. It only exists as a transient UI concept. The moment a deadline passes and the worker runs, the status immediately transitions to `WAITLIST`. There is no frozen/stuck state.

---

## ⚖️ Design Tradeoffs

| Decision | Chosen Approach | Alternative | Reason |
|----------|----------------|-------------|--------|
| **Real-time updates** | Polling (React Query refetch) | WebSockets / SSE | Simpler, no persistent connection management; acceptable for hiring pipeline latency |
| **Decay trigger** | Background interval (5s poll) | DB triggers / cron | Keeps logic in application layer, fully testable, no DB-specific extensions |
| **Concurrency** | `FOR UPDATE` row locking | Optimistic locking / SKIP LOCKED everywhere | Pessimistic locking is safer for the final slot scenario; simpler to reason about |
| **State machine** | Centralized adjacency map | Distributed checks per service | Single source of truth; all illegal transitions throw before any DB write |
| **Queue ordering** | Position integer + re-index on promote | Linked list / priority queue | Simple to query, easy to reason about, re-indexing cost is acceptable at pipeline scale |
| **Error format** | `{ error: { message, code } }` | HTTP status only | Machine-readable codes enable precise frontend handling without parsing strings |

---

## 🛠️ Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | React 19, Vite, TailwindCSS 4, Radix UI, Wouter, React Query |
| **Backend** | Node.js, Express 5, TypeScript |
| **Database** | PostgreSQL, Drizzle ORM |
| **Validation** | Zod (shared schemas) |
| **Testing** | Vitest |
| **Logging** | Pino + pino-pretty |
| **Build** | ESBuild, pnpm workspaces |

---

## 📁 Key Design Decisions

1. **Service Layer Pattern** — Routes are thin wrappers (parse → call service → respond). All business logic lives in `services/applicationService.ts` and `services/pipeline.ts`.

2. **Pure Result Objects** — Service functions return new objects, never mutating inputs. Makes the code predictable and testable.

3. **Centralized State Machine** — `lib/stateMachine.ts` defines the ONLY legal transitions. Every status change is validated through `assertValidTransition()`.

4. **Structured Error Hierarchy** — Custom `AppError` subclasses (`NotFoundError`, `ConflictError`, `GoneError`, `InvalidTransitionError`) with consistent JSON output.

5. **Global Error Handler** — Express middleware that catches errors, maps PostgreSQL constraint codes (23505, 23503, etc.) to proper HTTP responses, and ensures no unstructured errors leak to clients.

6. **Transaction Safety** — Every state-changing operation uses `FOR UPDATE` locking inside transactions. The `tx` parameter is dependency-injected through the call chain to ensure all reads/writes are transactionally consistent.

---

## 📜 License

MIT
