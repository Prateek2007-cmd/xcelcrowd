# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## Project: Self-Moving Hiring Pipeline

### Purpose
A backend-heavy full-stack app that manages a hiring pipeline automatically. Applicants flow from waitlist to active slots, with inactivity decay, automatic cascading promotion, and full audit traceability.

### Architecture

#### DB Schema (lib/db/src/schema/)
- `jobs` — job openings with fixed ACTIVE capacity
- `applicants` — registered applicants
- `applications` — application lifecycle (ACTIVE, WAITLIST, PENDING_ACKNOWLEDGMENT, INACTIVE)
- `queue_positions` — ordered waitlist per job (FIFO with penalty reordering)
- `audit_logs` — immutable event log, every state transition recorded

#### Application Status State Machine
```
APPLIED → ACTIVE (if capacity available)
APPLIED → WAITLIST (if at capacity)
WAITLIST → PENDING_ACKNOWLEDGMENT (when promoted, must acknowledge within 5 min)
PENDING_ACKNOWLEDGMENT → ACTIVE (on acknowledge)
PENDING_ACKNOWLEDGMENT → WAITLIST (decay: penalty position applied, next promoted)
ACTIVE/WAITLIST/PENDING_ACKNOWLEDGMENT → INACTIVE (on withdraw)
```

#### Backend (artifacts/api-server/src/)
- `routes/jobs.ts` — create jobs, list jobs, get job with pipeline
- `routes/applicants.ts` — register applicants, status, timeline
- `routes/applications.ts` — apply, withdraw, acknowledge
- `routes/pipeline.ts` — queue view, summary metrics, event replay
- `services/pipeline.ts` — core state machine logic: promote, decay, requeue
- `lib/decayWorker.ts` — background poller (30s interval) for expired acknowledgments

#### Frontend (artifacts/hiring-pipeline/src/)
- `/` — Company Dashboard: all jobs with pipeline health
- `/jobs/:jobId` — Job Pipeline: active applicants + waitlist queue
- `/applicants` — Applicant Registry
- `/applicants/:applicantId` — Applicant Detail: status, timeline, actions
- `/pipeline/:jobId/replay` — Pipeline Replay: reconstruct state from audit logs

### Key Design Decisions
- **Transaction-safe**: all state transitions in DB transactions to prevent over-filling
- **Concurrency-safe**: active count checked within transaction before promoting
- **Decay cascade**: expired PENDING_ACKNOWLEDGMENT → penalty back to waitlist → next waitlist promoted automatically
- **Event-driven audit**: every state change recorded in audit_logs with from/to status
- **Event replay**: full pipeline state can be reconstructed from audit logs at any timestamp
- **No external queue libs**: pure PostgreSQL + setInterval background worker
