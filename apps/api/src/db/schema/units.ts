import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { appUsers } from "./auth.js";
import { players } from "./players.js";

export const units = pgTable("units", {
  id: uuid("id").defaultRandom().primaryKey(),
  unitKey: text("unit_key").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  isActive: boolean("is_active").notNull().default(true),
  primaryDiscordGuildId: text("primary_discord_guild_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  displayName: text("display_name"),
  callsign: text("callsign"),
  emblemUrl: text("emblem_url"),
  sortOrder: integer("sort_order").notNull().default(0),
  deletedAt: timestamp("deleted_at", { withTimezone: true })
});

export const unitPlayers = pgTable(
  "unit_players",
  {
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    playerUid: text("player_uid")
      .notNull()
      .references(() => players.playerUid, { onDelete: "cascade" }),
    rank: text("rank"),
    rosterName: text("roster_name"),
    isActive: boolean("is_active").notNull().default(true),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    rankSort: integer("rank_sort").notNull().default(0),
    rosterStatus: text("roster_status").notNull().default("active"),
    joinedUnitAt: timestamp("joined_unit_at", { withTimezone: true }),
    leftUnitAt: timestamp("left_unit_at", { withTimezone: true }),
    assignmentSource: text("assignment_source").notNull().default("manual"),
    rankId: uuid("rank_id").references(() => unitRanks.id, { onDelete: "set null" })
  },
  (table) => [primaryKey({ columns: [table.unitId, table.playerUid] })]
);

export const unitRanks = pgTable("unit_ranks", {
  id: uuid("id").defaultRandom().primaryKey(),
  unitId: uuid("unit_id")
    .notNull()
    .references(() => units.id, { onDelete: "cascade" }),
  rankKey: text("rank_key").notNull(),
  name: text("name").notNull(),
  shortName: text("short_name"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const unitSquads = pgTable("unit_squads", {
  id: uuid("id").defaultRandom().primaryKey(),
  unitId: uuid("unit_id")
    .notNull()
    .references(() => units.id, { onDelete: "cascade" }),
  parentSquadId: uuid("parent_squad_id"),
  squadKey: text("squad_key").notNull(),
  name: text("name").notNull(),
  squadType: text("squad_type").notNull().default("squad"),
  hierarchyMode: text("hierarchy_mode").notNull().default("flat"),
  sortOrder: integer("sort_order").notNull().default(0),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const unitRosterAssignments = pgTable("unit_roster_assignments", {
  id: uuid("id").defaultRandom().primaryKey(),
  unitId: uuid("unit_id")
    .notNull()
    .references(() => units.id, { onDelete: "cascade" }),
  playerUid: text("player_uid")
    .notNull()
    .references(() => players.playerUid, { onDelete: "cascade" }),
  squadId: uuid("squad_id").references(() => unitSquads.id, { onDelete: "set null" }),
  billet: text("billet").notNull().default("trooper"),
  sortOrder: integer("sort_order").notNull().default(0),
  isPrimary: boolean("is_primary").notNull().default(true),
  assignmentSource: text("assignment_source").notNull().default("manual"),
  assignedByUserId: uuid("assigned_by_user_id").references(() => appUsers.id, { onDelete: "set null" }),
  assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp("ended_at", { withTimezone: true }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
