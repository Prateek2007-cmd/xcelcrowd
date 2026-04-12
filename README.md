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
| **Background Decay Worker** | Polls for expired acknowledgments every 30 seconds |

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

- **Node.js** ≥ 20
- **pnpm** ≥ 9
- **PostgreSQL** ≥ 15 (running locally)

### 1. Clone & Install

```bash
git clone https://github.com/Prateek2007-cmd/xcelcrowd.git
cd xcelcrowd
pnpm install
```

### 2. Configure Environment

Create `.env` in the project root:

```env
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/hiring_pipeline
```

Create `artifacts/api-server/.env`:

```env
DATABASE_URL=postgresql://postgres:your_password@localhost:5432/hiring_pipeline
PORT=5000
```

### 3. Database Setup

```bash
# Push schema to PostgreSQL
pnpm --filter db push
```

### 4. Start the API Server

```bash
pnpm --filter @workspace/api-server dev
```

The API is now running at `http://localhost:5000/api`.

### 5. Start the Frontend

```bash
pnpm --filter @workspace/hiring-pipeline dev
```

Open `http://localhost:5173` in your browser.

### 6. Seed the Database (Optional)

With the API server running:

```bash
node scripts/seed.mjs
```

This creates 3 jobs, 5 applicants, and submits sample applications.

---

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

- **`FOR UPDATE`** on `getActiveCount()` — locks application rows during capacity checks, preventing two concurrent `/apply` requests from both getting active slots
- **`FOR UPDATE SKIP LOCKED`** on `getNextInQueue()` — safely promotes from the queue without blocking concurrent promotions
- **All state mutations** run inside `db.transaction()` with the `tx` parameter propagated through the entire call chain

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
