import { jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const operations = pgTable("operations", {
  id: uuid("id").defaultRandom().primaryKey(),
  serverKey: text("server_key").notNull(),
  status: text("status").notNull().default("started"),
  missionUid: text("mission_uid"),
  missionName: text("mission_name"),
  worldName: text("world_name"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  rawStartPayload: jsonb("raw_start_payload").$type<Record<string, unknown>>().notNull().default({}),
  rawEndPayload: jsonb("raw_end_payload").$type<Record<string, unknown> | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  unitId: uuid("unit_id")
});
