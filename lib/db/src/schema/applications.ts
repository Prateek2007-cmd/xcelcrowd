import { pgTable, text, serial, integer, timestamp, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";
import { applicantsTable } from "./applicants";

export const applicationStatusEnum = pgEnum("application_status", [
  "ACTIVE",
  "WAITLIST",
  "PENDING_ACKNOWLEDGMENT",
  "INACTIVE",
]);

export const applicationsTable = pgTable("applications", {
  id: serial("id").primaryKey(),
  jobId: integer("job_id")
    .notNull()
    .references(() => jobsTable.id),
  applicantId: integer("applicant_id")
    .notNull()
    .references(() => applicantsTable.id),
  status: applicationStatusEnum("status").notNull().default("WAITLIST"),
  penaltyCount: integer("penalty_count").notNull().default(0),
  promotedAt: timestamp("promoted_at", { withTimezone: true }),
  acknowledgeDeadline: timestamp("acknowledge_deadline", { withTimezone: true }),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  withdrawnAt: timestamp("withdrawn_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertApplicationSchema = createInsertSchema(applicationsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertApplication = z.infer<typeof insertApplicationSchema>;
export type Application = typeof applicationsTable.$inferSelect;

export const applicationStatusValues = ["ACTIVE", "WAITLIST", "PENDING_ACKNOWLEDGMENT", "INACTIVE"] as const;
export type ApplicationStatus = typeof applicationStatusValues[number];
