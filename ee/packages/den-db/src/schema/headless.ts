import {
  bigint,
  index,
  int,
  mysqlTable,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";
import { denTypeIdColumn, encryptedMediumTextColumn } from "../columns";

// Content uses the same encryption primitive as cloud automations. No provider credentials live here.
export const HeadlessRunTable = mysqlTable(
  "headless_run",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organization_id: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    member_id: denTypeIdColumn("member", "member_id").notNull(),
    surface: varchar("surface", { length: 16 }).notNull(),
    conversation_key: varchar("conversation_key", { length: 160 }).notNull(),
    idempotency_key: varchar("idempotency_key", { length: 160 }).notNull(),
    fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
    status: varchar("status", { length: 16 }).notNull(),
    created_ms: bigint("created_ms", { mode: "number" }).notNull(),
    lease_owner: varchar("lease_owner", { length: 36 }),
    lease_until: bigint("lease_until", { mode: "number" }),
    content: encryptedMediumTextColumn("content").notNull(),
  },
  (table) => [
    uniqueIndex("headless_run_request").on(
      table.organization_id,
      table.member_id,
      table.surface,
      table.idempotency_key,
    ),
    index("headless_run_conversation").on(
      table.organization_id,
      table.member_id,
      table.surface,
      table.conversation_key,
      table.created_ms,
    ),
    index("headless_run_claim").on(table.status, table.created_ms),
    index("headless_run_owner_status").on(
      table.organization_id,
      table.member_id,
      table.status,
    ),
  ],
);
export const HeadlessEventTable = mysqlTable(
  "headless_event",
  {
    sequence: bigint("sequence", { mode: "number", unsigned: true })
      .autoincrement()
      .primaryKey(),
    run_id: varchar("run_id", { length: 36 }).notNull(),
    content: encryptedMediumTextColumn("content").notNull(),
  },
  (table) => [index("headless_event_run").on(table.run_id, table.sequence)],
);
export const HeadlessScheduleTable = mysqlTable(
  "headless_schedule",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    organization_id: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    member_id: denTypeIdColumn("member", "member_id").notNull(),
    next_ms: bigint("next_ms", { mode: "number" }).notNull(),
    paused: int("paused").notNull(),
    content: encryptedMediumTextColumn("content").notNull(),
  },
  (table) => [
    index("headless_schedule_owner").on(table.organization_id, table.member_id),
    index("headless_schedule_due").on(table.paused, table.next_ms),
  ],
);
export const HeadlessFileTable = mysqlTable(
  "headless_file",
  {
    organization_id: denTypeIdColumn(
      "organization",
      "organization_id",
    ).notNull(),
    member_id: denTypeIdColumn("member", "member_id").notNull(),
    path: varchar("path", { length: 500 }).notNull(),
    content: encryptedMediumTextColumn("content").notNull(),
  },
  (table) => [
    uniqueIndex("headless_file_owner_path").on(
      table.organization_id,
      table.member_id,
      table.path,
    ),
  ],
);
