# Pipeline Tests Summary

**Status**: ✅ **30/30 Tests Passing** (100%)

## Overview

This document summarizes the comprehensive unit test suite for the hiring pipeline orchestration layer (`artifacts/api-server/src/services/pipeline.ts`). The tests verify critical queue management, state transitions, and capacity handling logic that ensures fairness and reliability in the candidate processing workflow.

## Test Coverage Structure

### 1. `getActiveCount()` — Count Active Openings
**Purpose**: Verify that active candidate count includes both `ACTIVE` and `PENDING_ACKNOWLEDGMENT` statuses.

| Test | Purpose | Status |
|------|---------|--------|
| returns count of ACTIVE and PENDING_ACKNOWLEDGMENT applications | Validates both statuses counted together | ✅ |
| returns 0 if no active applications | Edge case: empty applicant pool | ✅ |
| only counts ACTIVE and PENDING_ACKNOWLEDGMENT status | Ensures WAITLIST and other statuses ignored | ✅ |

**Key Assertion**: Both ACTIVE and PENDING_ACKNOWLEDGMENT count toward job capacity limit.

---

### 2. `promoteNext()` — Promote Single Candidate
**Purpose**: Move one candidate from WAITLIST → PENDING_ACKNOWLEDGMENT with acknowledgment deadline.

| Test | Purpose | Status |
|------|---------|--------|
| promotes WAITLIST candidate to PENDING_ACKNOWLEDGMENT | Happy path: valid promotion | ✅ |
| returns early if capacity is full | Defensive guard: prevents over-booking | ✅ |
| skips stale queue entries (status not WAITLIST) | Garbage collection: handles orphaned queue records | ✅ |

**Key Assertions**:
- Database `update()` called to change status
- Acknowledgment deadline set (24-48 hours based on config)
- Promotion stops at capacity boundary

---

### 3. `applyPenaltyAndRequeue()` — Requeue with Penalty
**Purpose**: Move expired PENDING_ACKNOWLEDGMENT back to WAITLIST with penalty increment, always appending to end of queue.

| Test | Purpose | Status |
|------|---------|--------|
| moves applicant from PENDING_ACKNOWLEDGMENT back to WAITLIST | Core requeue logic | ✅ |
| appends to end of queue (MAX(position) + 1) | FIFO guarantee: new position = MAX + 1 | ✅ |
| increments penaltyCount when requeuing | Penalty tracking for monitoring | ✅ |
| deletes stale queue entry (defensive cleanup) | Pre-deletion of old position before re-insert | ✅ |

**Key Assertions**:
- DELETE old queue entry
- INSERT new queue entry at position = MAX(existing positions) + 1
- UPDATE application status to WAITLIST
- UPDATE application penaltyCount increment
- Penalty NEVER affects queue position (strict FIFO)

---

### 4. `promoteUntilFull()` — Batch Promotion
**Purpose**: Promote up to `slotsAvailable` candidates in one cycle.

| Test | Purpose | Status |
|------|---------|--------|
| stops promoting when capacity is reached | Respects job capacity limit | ✅ |
| counts only successful promotions | Accurate promotion counter | ✅ |
| returns 0 if no candidates in queue | Edge case: empty queue | ✅ |

**Key Assertions**:
- Calculates `slotsAvailable = jobCapacity - activeCount`
- Fetches exactly that many candidates from queue
- Loops through candidates, calling `promoteNext()` for each
- Stops early if queue exhausted

---

### 5. `checkAndDecayExpiredAcknowledgments()` — Decay Cycle
**Purpose**: Find expired PENDING_ACKNOWLEDGMENT applications, requeue them, and promote new candidates until full.

| Test | Purpose | Status |
|------|---------|--------|
| finds and decays expired PENDING_ACKNOWLEDGMENT applications | Query logic: finds applicants past deadline | ✅ |
| returns 0 if no expired applications | Edge case: no expiry | ✅ |
| promotes from queue after decay | Fills slots freed by decay | ✅ |

**Key Assertions**:
- SELECT applicants where `acknowledgeDeadline < NOW()`
- For each expired: call `applyPenaltyAndRequeue()`
- Then call `promoteUntilFull()` to fill freed capacity
- Return count of decayed applicants

---

### 6. `runDecayForJob()` — Decay Entry Point
**Purpose**: Wrap entire decay cycle in database transaction for ACID guarantees.

| Test | Purpose | Status |
|------|---------|--------|
| wraps decay cycle in database transaction for ACID guarantee | Transaction scoping: atomicity | ✅ |
| returns success: true when decay cycle completes | Success response shape | ✅ |
| returns success: false and counts zero on transaction error | Error handling: graceful degradation | ✅ |
| includes decayed count in response | Response includes metrics | ✅ |

**Key Assertions**:
- All operations wrapped in `db.transaction()`
- Returns `{ success: true, decayed: N }`
- On error: `{ success: false, decayed: 0 }`
- Logs audit trail for all state changes

---

### 7. State Transitions & FIFO Ordering
**Purpose**: Verify correct status changes and deadline handling.

| Test | Purpose | Status |
|------|---------|--------|
| WAITLIST → PENDING_ACKNOWLEDGMENT transition updates status and sets deadline | Promotion state change | ✅ |
| PENDING_ACKNOWLEDGMENT → WAITLIST (decay) clears deadline and increments penalty | Decay state change | ✅ |

**Key Business Rules Verified**:
- Promotion: Sets `acknowledgeDeadline = NOW() + DEADLINE_CONFIG`
- Decay: Clears `acknowledgeDeadline`, increments `penaltyCount`
- No direct state transitions between ACTIVE and WAITLIST (only PENDING_ACKNOWLEDGMENT)

---

### 8. FIFO Queue Fairness & Position Ordering
**Purpose**: Ensure expired applicants NEVER jump ahead of earlier applicants.

| Test | Purpose | Status |
|------|---------|--------|
| requeued applicant always goes to END of queue (MAX position + 1) | Fixed position calculation | ✅ |
| ensures expired applicants never jump ahead of earlier applicants | Long-term fairness guarantee | ✅ |

**Critical Business Rule**:
```
position_new = MAX(existing positions) + 1
```
- Expired applicants added at END, never inserted mid-queue
- Prevents unfair jump-ahead scenarios
- Example: Queue has [1, 3, 5] → expired app gets position 6 (not 2 or 4)

---

### 9. Capacity Handling & Slot Management
**Purpose**: Verify capacity constraints and slot availability logic.

| Test | Purpose | Status |
|------|---------|--------|
| rejects promotion when capacity is at maximum | Hard capacity limit | ✅ |
| promotes exactly slotsAvailable candidates (not more) | Precise slot calculation | ✅ |
| counts both ACTIVE and PENDING_ACKNOWLEDGMENT toward capacity | Combined capacity counting | ✅ |

**Key Assertion**:
```
slotsAvailable = jobCapacity - (ACTIVE_count + PENDING_ACKNOWLEDGMENT_count)
promote_count ≤ slotsAvailable
```

---

### 10. Side Effects Verification
**Purpose**: Verify correct database operation sequences and audit logging.

| Test | Purpose | Status |
|------|---------|--------|
| promotion deletes queue entry after updating status | DELETE + UPDATE sequence | ✅ |
| penalty-and-requeue performs: delete + insert + update sequence | DELETE + INSERT + UPDATE sequence | ✅ |
| decay writes audit log for every decayed application | Audit trail creation | ✅ |

**Key Assertions**:
- DELETE/INSERT/UPDATE called in correct order
- Audit log records all state changes
- No orphaned queue entries or dangling references

---

## Test Implementation Patterns

### Mock Database Setup
All tests use a mocked Drizzle ORM transaction interface with the following structure:

```typescript
const mockTx = {
  execute: vi.fn()
    .mockImplementation(() => { /* resolves to { rows: [...] } */ }),
  select: vi.fn().mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue([/* result */]),
    }),
  }),
  delete: vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  }),
  insert: vi.fn().mockReturnValue({
    values: vi.fn().mockResolvedValue(undefined),
  }),
  update: vi.fn().mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
  }),
};
```

### Helper Functions
- `createMockApplication()` — Creates test application with customizable properties
- `createMockQueueEntry()` — Creates test queue position entry

### Assertion Patterns
- **Status changes**: Verify `update()` called with correct status
- **Side effects**: Verify DELETE/INSERT/UPDATE call order and parameters
- **State transitions**: Check deadline set/cleared correctly
- **Capacity**: Verify count calculations and boundaries

---

## Coverage Summary

**Total Tests**: 30  
**Passing**: 30 ✅  
**Pass Rate**: 100%

### By Function:
| Function | Tests | Status |
|----------|-------|--------|
| `getActiveCount()` | 3 | ✅ 3/3 |
| `promoteNext()` | 3 | ✅ 3/3 |
| `applyPenaltyAndRequeue()` | 4 | ✅ 4/4 |
| `promoteUntilFull()` | 3 | ✅ 3/3 |
| `checkAndDecayExpiredAcknowledgments()` | 3 | ✅ 3/3 |
| `runDecayForJob()` | 4 | ✅ 4/4 |
| State Transitions & FIFO Ordering | 2 | ✅ 2/2 |
| FIFO Queue Fairness | 2 | ✅ 2/2 |
| Capacity Handling | 3 | ✅ 3/3 |
| Side Effects Verification | 3 | ✅ 3/3 |

---

## Critical Business Logic Verified

✅ **FIFO Queue Ordering**: Expired applicants always appended to queue end  
✅ **Capacity Constraints**: Both ACTIVE and PENDING_ACKNOWLEDGMENT count toward limit  
✅ **Penalty Tracking**: Requeue increments penalty without affecting position  
✅ **State Transitions**: Proper status changes with deadline management  
✅ **Transaction Safety**: All decay operations atomic (ACID guarantee)  
✅ **Stale Entry Handling**: Defensive cleanup of orphaned queue records  
✅ **Audit Logging**: All state changes recorded for compliance/debugging  

---

## Running the Tests

```bash
# Run pipeline tests only
pnpm test pipeline.test.ts

# Run with verbose output
pnpm test pipeline.test.ts -- --reporter=verbose

# Run in watch mode
pnpm test pipeline.test.ts -- --watch
```

---

## Related Documentation

- **Pipeline Source**: [artifacts/api-server/src/services/pipeline.ts](artifacts/api-server/src/services/pipeline.ts)
- **Test File**: [artifacts/api-server/src/__tests__/pipeline.test.ts](artifacts/api-server/src/__tests__/pipeline.test.ts)
- **Applicant Reuse Tests**: [APPLICANT_REUSE_TESTS_SUMMARY.md](APPLICANT_REUSE_TESTS_SUMMARY.md)

