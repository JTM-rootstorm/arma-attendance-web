import { integer, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const debugPokes = pgTable("debug_pokes", {
  id: uuid("id").defaultRandom().primaryKey(),
  requestId: text("request_id").unique(),
  serverKey: text("server_key"),
  message: text("message"),
  sourceIp: text("source_ip"),
  userAgent: text("user_agent"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

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

export const operationPayloads = pgTable("operation_payloads", {
  id: uuid("id").defaultRandom().primaryKey(),
  operationId: uuid("operation_id")
    .notNull()
    .references(() => operations.id, { onDelete: "cascade" }),
  requestId: text("request_id").notNull().unique(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow()
});

export const ingestRequests = pgTable("ingest_requests", {
  requestId: text("request_id").primaryKey(),
  operationId: uuid("operation_id").references(() => operations.id, { onDelete: "set null" }),
  endpoint: text("endpoint").notNull().default("legacy"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  response: jsonb("response").$type<Record<string, unknown>>().notNull().default({}),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow()
});

export const operationIngestJobs = pgTable("operation_ingest_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  requestId: text("request_id")
    .notNull()
    .unique()
    .references(() => ingestRequests.requestId, { onDelete: "cascade" }),
  operationId: uuid("operation_id")
    .notNull()
    .references(() => operations.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull(),
  kind: text("kind").notNull(),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  status: text("status").notNull().default("pending"),
  attemptCount: integer("attempt_count").notNull().default(0),
  availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
  lockedAt: timestamp("locked_at", { withTimezone: true }),
  lockedBy: text("locked_by"),
  lastErrorCode: text("last_error_code"),
  lastErrorMessage: text("last_error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true })
});
