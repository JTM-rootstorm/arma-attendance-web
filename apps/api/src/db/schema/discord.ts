import { boolean, integer, jsonb, pgTable, primaryKey, text, timestamp } from "drizzle-orm/pg-core";

import { players } from "./players.js";

export const discordGuilds = pgTable("discord_guilds", {
  guildId: text("guild_id").primaryKey(),
  name: text("name").notNull(),
  iconUrl: text("icon_url"),
  botUserId: text("bot_user_id"),
  botPresent: boolean("bot_present").notNull().default(true),
  lastRoleSyncAt: timestamp("last_role_sync_at", { withTimezone: true }),
  lastMemberSyncAt: timestamp("last_member_sync_at", { withTimezone: true }),
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
