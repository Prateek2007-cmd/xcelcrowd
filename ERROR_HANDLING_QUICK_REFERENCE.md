# Error Handling Helper Functions - Quick Reference

## Overview

Three helper functions for type-safe error handling. Can be used throughout the codebase.

## Helper Functions

### 1. Extract PostgreSQL Error Code

```typescript
/**
 * Extract PostgreSQL error code from various error structures.
 * PostgreSQL errors can appear in multiple places depending on the driver.
 */
function getPgErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;

  const errObj = err as Record<string, unknown>;
  return (errObj.code as string) || (errObj.cause as Record<string, unknown>)?.code as string;
}
```

**Usage**:
```typescript
const errorCode = getPgErrorCode(err);
if (errorCode === "23505") {
  // Handle unique constraint violation
}
```

---

### 2. Type Guard for Error

```typescript
/**
 * Type guard to check if error is an instance of Error.
 */
function isError(err: unknown): err is Error {
  return err instanceof Error;
}
```

**Usage**:
```typescript
if (isError(err)) {
  const message = err.message;  // TypeScript knows this is safe
  const stack = err.stack;      // TypeScript knows this is safe
}
```

---

### 3. Safe Error Message Formatting

```typescript
/**
 * Format unknown error for logging and error messages.
 */
function formatErrorMessage(err: unknown): string {
  if (isError(err)) return err.message;
  if (typeof err === "string") return err;
  if (typeof err === "object" && err !== null && "message" in err) {
    return String((err as Record<string, unknown>).message);
  }
  return String(err);
}
```

**Usage**:
```typescript
const message = formatErrorMessage(err);  // Always returns a string
logger.error({ message }, "Operation failed");
```

---

## Complete Error Handling Pattern

### Pattern 1: Simple Error Classification

```typescript
try {
  // database operation
} catch (err: unknown) {
  if (err instanceof AppError) {
    throw err;  // Re-throw known errors
  }

  const errorCode = getPgErrorCode(err);
  const message = formatErrorMessage(err);

  if (errorCode === "23505") {
    // Handle unique constraint
  } else if (errorCode === "23503") {
    // Handle foreign key constraint
  } else {
    logger.error({ errorCode, message }, "Unknown error");
    throw new DatabaseError("Failed to perform operation", { cause: message });
  }
}
```

### Pattern 2: Nested Error Handling

```typescript
try {
  // Initial operation
} catch (err: unknown) {
  if (err instanceof AppError) {
    throw err;
  }

  const errorCode = getPgErrorCode(err);
  const message = formatErrorMessage(err);

  if (errorCode === "23505") {
    try {
      // Recovery operation (e.g., fetch existing)
    } catch (recoveryErr: unknown) {
      if (recoveryErr instanceof AppError) {
        throw recoveryErr;
      }

      const recoveryMessage = formatErrorMessage(recoveryErr);
      logger.error({ originalError: message, recoveryError: recoveryMessage }, "Recovery failed");
      throw new DatabaseError("Could not recover from error", { cause: recoveryMessage });
    }
  } else {
    throw new DatabaseError("Failed", { cause: message });
  }
}
```

### Pattern 3: Structured Logging

```typescript
try {
  // operation
} catch (err: unknown) {
  logger.error(
    {
      errorCode: getPgErrorCode(err) || "unknown",
      errorMessage: formatErrorMessage(err),
      errorType: isError(err) ? err.constructor.name : typeof err,
      operation: "applicant_creation",
      email,  // context-specific field
    },
    "Database operation failed"
  );

  throw new DatabaseError("Failed to create applicant", {
    cause: formatErrorMessage(err),
    code: getPgErrorCode(err),
  });
}
```

---

## PostgreSQL Error Codes Reference

Common PostgreSQL error codes:

| Code | Error | Example |
|------|-------|---------|
| **23505** | Unique Violation | Duplicate email, duplicate username |
| **23503** | Foreign Key Violation | Job ID not found, invalid reference |
| **42P01** | Undefined Table | Table doesn't exist, schema issue |
| **42703** | Undefined Column | Column name typo |
| **23502** | Not Null Violation | Required field missing |
| **22004** | Null Value Not Allowed | Null in NOT NULL column |

**Full list**: [PostgreSQL Error Codes](https://www.postgresql.org/docs/current/errcodes-appendix.html)

---

## Error Handling Checklist

- [ ] Replace `catch (err: any)` with `catch (err: unknown)`
- [ ] Check for known AppError types first
- [ ] Extract PostgreSQL error code with `getPgErrorCode()`
- [ ] Handle known error codes (23505, 23503, etc.)
- [ ] Format error message with `formatErrorMessage()`
- [ ] Add structured logging with error context
- [ ] Preserve error cause in wrapped errors
- [ ] Handle nested catch blocks with `unknown` type
- [ ] Test with real database errors

---

## Where These Helpers Are Defined

**Location**: [artifacts/api-server/src/services/applicationService.ts](artifacts/api-server/src/services/applicationService.ts#L33-L57)

To use in other files:
1. Copy the three helper functions
2. OR import from applicationService if making them shared
3. Apply the error handling patterns shown above

---

## Examples from Production Code

### Example 1: applicantService.ts (Duplicate Email Handling)

```typescript
catch (err: unknown) {
  if (err instanceof DatabaseError) {
    throw err;
  }

  const pgErrorCode = getPgErrorCode(err);
  
  if (pgErrorCode === "23505") {  // ← Unique constraint
    // Fetch existing applicant
  } else {
    throw new DatabaseError("Failed to create or resolve applicant", {
      cause: formatErrorMessage(err),
      code: pgErrorCode,
    });
  }
}
```

### Example 2: jobService.ts (Foreign Key Constraint)

```typescript
catch (err: unknown) {
  const pgErrorCode = getPgErrorCode(err);
  
  if (pgErrorCode === "23503") {  // ← Foreign key
    throw new NotFoundError("Job", jobId);  // Referenced job not found
  } else {
    throw new DatabaseError("Failed to create job", {
      cause: formatErrorMessage(err),
    });
  }
}
```

---

## Benefits at a Glance

✅ **Type Safety**: No more `any` types  
✅ **Error Classification**: Clear error types and codes  
✅ **Better Logging**: Structured error context  
✅ **Easier Debugging**: Actual error messages preserved  
✅ **Production Ready**: Observable error handling  
✅ **Reusable**: Use same patterns throughout codebase  

---

## Related Documentation

- [Error Handling Refactor Summary](ERROR_HANDLING_REFACTOR_SUMMARY.md)
- [Application Service Implementation](artifacts/api-server/src/services/applicationService.ts)
- [Custom Error Types](artifacts/api-server/src/lib/errors.ts)

