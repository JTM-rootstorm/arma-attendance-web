import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

export const players = pgTable("players", {
  playerUid: text("player_uid").primaryKey(),
  lastName: text("last_name"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  rawLastPlayer: jsonb("raw_last_player").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const operationPlayers = pgTable(
  "operation_players",
  {
    operationId: uuid("operation_id").notNull(),
    playerUid: text("player_uid")
      .notNull()
      .references(() => players.playerUid, { onDelete: "cascade" }),
    nameAtStart: text("name_at_start"),
    nameAtEnd: text("name_at_end"),
    sideAtStart: text("side_at_start"),
    sideAtEnd: text("side_at_end"),
    groupAtStart: text("group_at_start"),
    groupAtEnd: text("group_at_end"),
    roleAtStart: text("role_at_start"),
    roleAtEnd: text("role_at_end"),
    unitClassAtStart: text("unit_class_at_start"),
    unitClassAtEnd: text("unit_class_at_end"),
    vehicleClassAtStart: text("vehicle_class_at_start"),
    vehicleClassAtEnd: text("vehicle_class_at_end"),
    presentAtStart: boolean("present_at_start").notNull().default(false),
    presentAtEnd: boolean("present_at_end").notNull().default(false),
    rawStartPlayer: jsonb("raw_start_player").$type<Record<string, unknown> | null>(),
    rawEndPlayer: jsonb("raw_end_player").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.operationId, table.playerUid] })]
);

export const operationPlayerStats = pgTable(
  "operation_player_stats",
  {
    operationId: uuid("operation_id").notNull(),
    playerUid: text("player_uid").notNull(),
    infantryKills: integer("infantry_kills").notNull().default(0),
    vehicleKills: integer("vehicle_kills").notNull().default(0),
    playerKills: integer("player_kills").notNull().default(0),
    aiKills: integer("ai_kills").notNull().default(0),
    friendlyKills: integer("friendly_kills").notNull().default(0),
    deaths: integer("deaths").notNull().default(0),
    rawStats: jsonb("raw_stats").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.operationId, table.playerUid] })]
);
