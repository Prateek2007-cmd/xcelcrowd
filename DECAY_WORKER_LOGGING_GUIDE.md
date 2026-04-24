# Decay Worker - Enhanced Logging & Operational Visibility

## Overview

Improved logging in `decayWorker.ts` provides comprehensive, structured visibility into worker operations for production debugging and monitoring.

---

## Logging Improvements

### 1. Structured Logging Throughout

All logs use consistent structured format with context objects:

```typescript
logger.info({ jobId, jobTitle, capacity, phase }, "Human-readable message");
```

**Benefits:**
- Easy filtering by jobId, phase, or any field in production systems
- Structured for log aggregation services (ELK, DataDog, CloudWatch)
- Consistent format across all logs

---

### 2. Phases & Flow Tracking

Logs include `phase` field to track execution flow:

| Phase | Purpose | Log Level |
|-------|---------|-----------|
| `discovery` | Finding jobs with expired apps | debug/info |
| `fetch` | Retrieving job details | debug |
| `processing-start` | Beginning decay for a job | info |
| `processing-complete` | Decay completed successfully | info |
| `processing-failed` | Service layer returned failure | error |
| `processing-error` | Exception during processing | error |
| `job-discovery-error` | Error fetching job details | error |
| `cycle-complete` | Full cycle finished | info/warn |
| `cycle-error` | Critical error, no processing done | error |

**Use:** Filter logs by `phase` to find specific operation stages.

---

### 3. Job-Level Visibility

Each job includes contextual information:

```json
{
  "jobId": 42,
  "jobTitle": "Senior Engineer",
  "capacity": 5,
  "phase": "processing-complete",
  "decayed": 2,
  "promoted": 1,
  "processingTimeMs": 234
}
```

**Visible Metrics:**
- Job ID and title (human-readable)
- Job capacity
- Decayed application count
- Promoted application count
- Processing time in milliseconds

---

### 4. Application-Level Metrics

Track application state changes:

```typescript
{
  "jobId": 42,
  "decayed": 2,           // Applications moved from PENDING_ACKNOWLEDGMENT to WAITLIST
  "promoted": 1,          // Applications moved from WAITLIST to PENDING_ACKNOWLEDGMENT
  "processingTimeMs": 234 // Operation duration
}
```

**Interpretation:**
- `decayed > 0` = Expired acknowledgments were handled
- `promoted > 0` = Queue was refilled from waitlist
- Both > 0 = Healthy cycle with changes
- Both = 0 = No activity needed

---

### 5. Error Context & Stack Traces

All errors include:

```typescript
logger.error(
  {
    phase: "processing-error",
    error: "Database connection timeout",
    stack: "Error: timeout...\n at ...",
    jobId: 42,
    jobTitle: "Senior Engineer"
  },
  "Decay worker: error message"
);
```

**Includes:**
- Error message
- Stack trace (important for debugging)
- Job context (which job failed)
- Operation phase (where it failed)

---

### 6. Cycle Summary Metrics

End-of-cycle log includes comprehensive summary:

```json
{
  "phase": "cycle-complete",
  "cycleTimeMs": 1250,
  "jobsDiscovered": 3,
  "jobsProcessed": 3,
  "jobsWithActivity": 2,
  "jobsFailed": 0,
  "successfulJobs": 3,
  "totalDecayed": 5,
  "totalPromoted": 4,
  "details": [
    {
      "jobId": 1,
      "jobTitle": "SWE",
      "success": true,
      "decayed": 2,
      "promoted": 1,
      "error": null
    },
    {
      "jobId": 2,
      "jobTitle": "PM",
      "success": true,
      "decayed": 3,
      "promoted": 3,
      "error": null
    }
  ]
}
```

**Key Metrics:**
- Cycle time elapsed (in milliseconds)
- Jobs discovered vs processed vs successful
- Failed job count
- Total applications decayed/promoted
- Detailed results per job

---

## Log Levels

Configure log detail with `LOG_LEVEL` environment variable:

### Development (`LOG_LEVEL=debug`)
```
debug: discovery starting
debug: fetching job details
info: job processing started
info: job processing complete
debug: job has no changes
info: cycle summary
```

**Use:** Full visibility into every operation

### Production (`LOG_LEVEL=info`)
```
info: jobs discovered
info: job processing started
info: job processing complete
info: cycle summary
```

**Use:** Key milestones without noise

### Critical Errors Only (`LOG_LEVEL=error`)
```
error: job processing failed
error: cycle initialization failed
```

**Use:** Only show failures

---

## Log Filtering Examples

### Find all activity for a specific job:
```bash
grep "jobId\":42" logs/* | grep decay
```

### Find all failed jobs:
```bash
grep '"success":false' logs/* | grep decay
```

### Find slow cycles:
```bash
grep "cycle-complete" logs/* | grep cycleTimeMs | awk '$3 > 5000'
```

### Find errors with stack traces:
```bash
grep "phase.*error" logs/* | grep stack
```

### Track total applications decayed per hour:
```bash
grep "cycle-complete" logs/* | jq '.totalDecayed' | add
```

---

## Operational Dashboards

### Reconstruction Example (Datadog/ELK)

**Count of decayed applications per job per hour:**
```
SELECT jobTitle, SUM(totalDecayed) FROM decay_worker_logs 
WHERE phase='cycle-complete' 
GROUP BY jobTitle, HOUR
```

**Failed job ratio:**
```
SELECT (jobsFailed / jobsDiscovered) * 100 as failure_rate 
FROM decay_worker_logs 
WHERE phase='cycle-complete'
```

**Average processing time per job:**
```
SELECT jobTitle, AVG(processingTimeMs) 
FROM decay_worker_logs 
WHERE phase='processing-complete' 
GROUP BY jobTitle
```

**Cycle health timeline:**
```
SELECT time, cycleTimeMs, jobsFailed, totalDecayed 
FROM decay_worker_logs 
WHERE phase='cycle-complete' 
ORDER BY time DESC
```

---

## Debugging Scenarios

### Scenario 1: Job keeps failing

**Steps:**
1. Filter by `jobId` and `phase=='processing-error'`
2. Look for `error` and `stack` fields
3. Check if it's service layer (logged there) vs job discovery issue
4. Correlate with job capacity and application count

### Scenario 2: Decay cycle takes too long

**Steps:**
1. Find cycles where `cycleTimeMs > expected`
2. Check `jobsDiscovered` and `jobsProcessed`
3. Look for jobs with high `processingTimeMs`
4. May indicate database performance issue

### Scenario 3: Applications not being promoted

**Steps:**
1. Find cycles with `totalDecayed > 0` but `totalPromoted = 0`
2. Check job capacity - might be full
3. Check for errors in `details[].error` field
4. May indicate queue is already saturated

### Scenario 4: Silent failures

**Before:** No logs if cycle errored at discovery phase
**After:** Always logs with error, message, and stack trace

---

## Sample Log Output

### Healthy Cycle (development, LOG_LEVEL=debug)
```
[2026-04-24T10:15:30Z] DEBUG: Decay worker: starting cycle - discovering jobs with expired acknowledgments
  {phase: "discovery"}

[2026-04-24T10:15:30Z] INFO: Decay worker: discovered 2 job(s) with expired acknowledgments
  {phase: "discovery", jobsFound: 2}

[2026-04-24T10:15:30Z] DEBUG: Decay worker: fetching job details
  {jobId: 1, phase: "fetch"}

[2026-04-24T10:15:30Z] INFO: Decay worker: starting decay cycle for job "Senior Engineer" (capacity: 5)
  {jobId: 1, jobTitle: "Senior Engineer", capacity: 5, phase: "processing-start"}

[2026-04-24T10:15:31Z] INFO: Decay worker: job "Senior Engineer" processed - decayed: 2, promoted: 2
  {jobId: 1, jobTitle: "Senior Engineer", decayed: 2, promoted: 2, processingTimeMs: 450, phase: "processing-complete"}

[2026-04-24T10:15:31Z] INFO: Decay worker: cycle complete - processed 2/2 jobs, decayed: 5, promoted: 4, time: 789ms
  {phase: "cycle-complete", cycleTimeMs: 789, jobsDiscovered: 2, jobsProcessed: 2, jobsWithActivity: 2, jobsFailed: 0, successfulJobs: 2, totalDecayed: 5, totalPromoted: 4, details: [...]}
```

---

## Performance Tips

### 1. Use appropriate log level
- Production: `LOG_LEVEL=info` (much less overhead than debug)
- Development: `LOG_LEVEL=debug` (full visibility)

### 2. Filter at log aggregator level
- Don't log to disk then filter
- Filter in DataDog/CloudWatch queries
- Reduces I/O impact

### 3. Monitor cycle metrics
- Alert if `cycleTimeMs > 10000` (hanging)
- Alert if `jobsFailed > 0` (failures)
- Alert if `totalDecayed > threshold` (too many expirations)

---

## Backward Compatibility

✅ **100% Backward Compatible**
- No changes to decayWorker behavior
- Same output results
- Only logging improved

✅ **Opt-in Detail**
- Control log level via environment variable
- Never forces verbose output
- Production deployments unaffected

---

## Summary

**Before:**
- Generic log messages
- Limited context
- Hard to find failed jobs
- No cycle metrics

**After:**
- Structured, filterable logs
- Rich context (jobId, jobTitle, phase, timing)
- Clear success/failure states
- Comprehensive cycle summary
- Stack traces for errors
- Easy dashboard integration

**Result:** Quick debugging, better monitoring, improved operational visibility.
