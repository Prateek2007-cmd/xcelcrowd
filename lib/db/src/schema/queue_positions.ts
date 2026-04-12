import { pgTable, serial, integer, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { jobsTable } from "./jobs";
import { applicationsTable } from "./applications";

export const queuePositionsTable = pgTable(
  "queue_positions",
  {
    id: serial("id").primaryKey(),
    jobId: integer("job_id")
      .notNull()
      .references(() => jobsTable.id),
    applicationId: integer("application_id")
      .notNull()
      .references(() => applicationsTable.id),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
  },
  (table) => [
    index("queue_positions_job_id_idx").on(table.jobId),
    index("queue_positions_position_idx").on(table.jobId, table.position),
  ]
);

export const insertQueuePositionSchema = createInsertSchema(queuePositionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertQueuePosition = z.infer<typeof insertQueuePositionSchema>;
export type QueuePosition = typeof queuePositionsTable.$inferSelect;
