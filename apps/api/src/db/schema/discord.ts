import { boolean, integer, jsonb, numeric, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { appUsers } from "./auth.js";
import { players } from "./players.js";
import { unitRanks, units } from "./units.js";

export const discordGuilds = pgTable("discord_guilds", {
  guildId: text("guild_id").primaryKey(),
  name: text("name").notNull(),
  iconUrl: text("icon_url"),
  botUserId: text("bot_user_id"),
  botPresent: boolean("bot_present").notNull().default(true),
  lastRoleSyncAt: timestamp("last_role_sync_at", { withTimezone: true }),
  lastMemberSyncAt: timestamp("last_member_sync_at", { withTimezone: true }),
  guildType: text("guild_type").notNull().default("unknown"),
  grantsLogin: boolean("grants_login").notNull().default(false),
  syncMembers: boolean("sync_members").notNull().default(false),
  isFallback: boolean("is_fallback").notNull().default(false),
  unitPriority: integer("unit_priority").notNull().default(0),
  rankPriority: integer("rank_priority").notNull().default(0),
  permissionPriority: integer("permission_priority").notNull().default(0),
  configOrder: integer("config_order").notNull().default(1000),
  configSource: text("config_source").notNull().default("db"),
  lastConfigLoadedAt: timestamp("last_config_loaded_at", { withTimezone: true }),
  rawGuild: jsonb("raw_guild").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const discordRoles = pgTable(
  "discord_roles",
  {
    guildId: text("guild_id")
      .notNull()
      .references(() => discordGuilds.guildId, { onDelete: "cascade" }),
    roleId: text("role_id").notNull(),
    name: text("name").notNull(),
    color: integer("color"),
    position: integer("position"),
    managed: boolean("managed").notNull().default(false),
    assignable: boolean("assignable").notNull().default(true),
    isDeleted: boolean("is_deleted").notNull().default(false),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    rawRole: jsonb("raw_role").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.guildId, table.roleId] })]
);

export const playerDiscordLinks = pgTable(
  "player_discord_links",
  {
    playerUid: text("player_uid")
      .notNull()
      .references(() => players.playerUid, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id").notNull(),
    discordUsername: text("discord_username"),
    discordDisplayName: text("discord_display_name"),
    source: text("source").notNull().default("manual"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    rawLink: jsonb("raw_link").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.playerUid, table.discordUserId] })]
);

export const discordAttendanceRules = pgTable("discord_attendance_rules", {
  id: uuid("id").defaultRandom().primaryKey(),
  guildId: text("guild_id")
    .notNull()
    .references(() => discordGuilds.guildId, { onDelete: "cascade" }),
  roleId: text("role_id").notNull(),
  name: text("name").notNull(),
  description: text("description"),
  isEnabled: boolean("is_enabled").notNull().default(true),
  minAttendancePoints: integer("min_attendance_points").notNull().default(0),
  minOperationCount: integer("min_operation_count").notNull().default(0),
  minAttendancePercent: numeric("min_attendance_percent", { precision: 5, scale: 2 }),
  lookbackDays: integer("lookback_days"),
  serverKey: text("server_key"),
  missionUidPattern: text("mission_uid_pattern"),
  requirePresentAtEnd: boolean("require_present_at_end").notNull().default(false),
  includeStartedOperations: boolean("include_started_operations").notNull().default(false),
  grantMode: text("grant_mode").notNull().default("grant_only"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  unitId: uuid("unit_id")
});

export const discordRoleActionAudits = pgTable("discord_role_action_audits", {
  id: uuid("id").defaultRandom().primaryKey(),
  guildId: text("guild_id")
    .notNull()
    .references(() => discordGuilds.guildId, { onDelete: "cascade" }),
  ruleId: uuid("rule_id").references(() => discordAttendanceRules.id, { onDelete: "set null" }),
  playerUid: text("player_uid").references(() => players.playerUid, { onDelete: "set null" }),
  discordUserId: text("discord_user_id"),
  roleId: text("role_id").notNull(),
  action: text("action").notNull(),
  status: text("status").notNull().default("planned"),
  reason: text("reason"),
  errorMessage: text("error_message"),
  evaluationId: uuid("evaluation_id"),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  reportedAt: timestamp("reported_at", { withTimezone: true })
});

export const discordMemberSnapshots = pgTable(
  "discord_member_snapshots",
  {
    guildId: text("guild_id")
      .notNull()
      .references(() => discordGuilds.guildId, { onDelete: "cascade" }),
    discordUserId: text("discord_user_id").notNull(),
    userId: uuid("user_id").references(() => appUsers.id, { onDelete: "set null" }),
    roleIds: jsonb("role_ids").$type<string[]>().notNull().default([]),
    nick: text("nick"),
    joinedAt: timestamp("joined_at", { withTimezone: true }),
    memberPayload: jsonb("member_payload").$type<Record<string, unknown>>().notNull().default({}),
    source: text("source").notNull().default("oauth_login"),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [primaryKey({ columns: [table.guildId, table.discordUserId] })]
);

export const discordRoleMappings = pgTable("discord_role_mappings", {
  id: uuid("id").defaultRandom().primaryKey(),
  guildId: text("guild_id")
    .notNull()
    .references(() => discordGuilds.guildId, { onDelete: "cascade" }),
  roleId: text("role_id").notNull(),
  mappingType: text("mapping_type").notNull(),
  unitId: uuid("unit_id").references(() => units.id, { onDelete: "cascade" }),
  rankId: uuid("rank_id").references(() => unitRanks.id, { onDelete: "set null" }),
  unitRole: text("unit_role"),
  appRole: text("app_role"),
  rosterStatus: text("roster_status"),
  priority: integer("priority").notNull().default(0),
  isEnabled: boolean("is_enabled").notNull().default(true),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const discordAssignmentAudits = pgTable("discord_assignment_audits", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: uuid("user_id").references(() => appUsers.id, { onDelete: "set null" }),
  playerUid: text("player_uid").references(() => players.playerUid, { onDelete: "set null" }),
  discordUserId: text("discord_user_id"),
  action: text("action").notNull(),
  field: text("field").notNull(),
  previousValue: jsonb("previous_value").$type<Record<string, unknown> | null>(),
  nextValue: jsonb("next_value").$type<Record<string, unknown> | null>(),
  winningClaim: jsonb("winning_claim").$type<Record<string, unknown> | null>(),
  ignoredClaims: jsonb("ignored_claims").$type<Record<string, unknown>[]>().notNull().default([]),
  source: text("source").notNull().default("discord_reconcile"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});
