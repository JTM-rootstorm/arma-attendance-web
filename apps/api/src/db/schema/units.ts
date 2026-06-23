import { boolean, integer, pgTable, primaryKey, text, timestamp, uuid, type AnyPgColumn } from "drizzle-orm/pg-core";

import { appUsers } from "./auth.js";
import { operations } from "./operations.js";
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
  slug: text("slug"),
  displayName: text("display_name"),
  callsign: text("callsign"),
  emblemUrl: text("emblem_url"),
  squadXmlTitle: text("squad_xml_title"),
  squadXmlWebUrl: text("squad_xml_web_url"),
  squadXmlPictureFilename: text("squad_xml_picture_filename").notNull().default("logo.paa"),
  sortOrder: integer("sort_order").notNull().default(0),
  deletedAt: timestamp("deleted_at", { withTimezone: true })
});

export const unitMemberships = pgTable(
  "unit_memberships",
  {
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    grantedByUserId: uuid("granted_by_user_id").references(() => appUsers.id, { onDelete: "set null" }),
    grantSource: text("grant_source").notNull().default("manual"),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.unitId, table.userId, table.role] })]
);

export const unitUserRoles = pgTable(
  "unit_user_roles",
  {
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => appUsers.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    grantedByUserId: uuid("granted_by_user_id").references(() => appUsers.id, { onDelete: "set null" }),
    grantSource: text("grant_source").notNull().default("manual")
  },
  (table) => [primaryKey({ columns: [table.unitId, table.userId, table.role] })]
);

export const unitServerKeys = pgTable(
  "unit_server_keys",
  {
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    serverKey: text("server_key").notNull(),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.unitId, table.serverKey] })]
);

export const operationUnits = pgTable(
  "operation_units",
  {
    operationId: uuid("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("manual"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.operationId, table.unitId] })]
);

export const operationPlayerUnits = pgTable(
  "operation_player_units",
  {
    operationId: uuid("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    playerUid: text("player_uid")
      .notNull()
      .references(() => players.playerUid, { onDelete: "cascade" }),
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("represented_unit"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.operationId, table.playerUid] })]
);

export const playerUnitPreferences = pgTable("player_unit_preferences", {
  playerUid: text("player_uid")
    .primaryKey()
    .references(() => players.playerUid, { onDelete: "cascade" }),
  representedUnitId: uuid("represented_unit_id").references(() => units.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => appUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const unitDiscordGuilds = pgTable(
  "unit_discord_guilds",
  {
    unitId: uuid("unit_id")
      .notNull()
      .references(() => units.id, { onDelete: "cascade" }),
    guildId: text("guild_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.unitId, table.guildId] })]
);

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
    rankId: uuid("rank_id").references(() => unitRanks.id, { onDelete: "set null" }),
    assignmentLocked: boolean("assignment_locked").notNull().default(false),
    assignmentPriority: integer("assignment_priority").notNull().default(0),
    sourceGuildId: text("source_guild_id"),
    sourceRoleId: text("source_role_id")
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
  parentSquadId: uuid("parent_squad_id").references((): AnyPgColumn => unitSquads.id, { onDelete: "cascade" }),
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
