import { pgTable, text, serial, integer, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { applicationsTable } from "./applications";

export const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: serial("id").primaryKey(),
    applicationId: integer("application_id")
      .notNull()
      .references(() => applicationsTable.id),
    eventType: text("event_type").notNull(),
    fromStatus: text("from_status"),
    toStatus: text("to_status").notNull(),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_logs_application_id_idx").on(table.applicationId),
    index("audit_logs_created_at_idx").on(table.createdAt),
  ]
);

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({ id: true, createdAt: true });
export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;

export const AuditEventType = {
  APPLIED: "APPLIED",
  PROMOTED: "PROMOTED",
  ACKNOWLEDGED: "ACKNOWLEDGED",
  WITHDRAWN: "WITHDRAWN",
  DECAY_TRIGGERED: "DECAY_TRIGGERED",
  PENALTY_APPLIED: "PENALTY_APPLIED",
  STATUS_CHANGED: "STATUS_CHANGED",
} as const;
export type AuditEventType = typeof AuditEventType[keyof typeof AuditEventType];
