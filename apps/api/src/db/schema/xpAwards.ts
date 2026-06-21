import { index, integer, numeric, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { operations } from "./operations.js";
import { players } from "./players.js";
import { planets } from "./planets.js";
import { xpRewardTiers } from "./xpRewardTiers.js";

export const operationXpAwards = pgTable(
  "operation_xp_awards",
  {
    operationId: uuid("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    playerUid: text("player_uid")
      .notNull()
      .references(() => players.playerUid, { onDelete: "cascade" }),
    tierId: uuid("tier_id").references(() => xpRewardTiers.id, { onDelete: "set null" }),
    missionName: text("mission_name").notNull(),
    missionNameMatch: text("mission_name_match").notNull(),
    xpAmount: integer("xp_amount").notNull(),
    awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.playerUid] }),
    index("idx_operation_xp_awards_player_uid").on(table.playerUid),
    index("idx_operation_xp_awards_tier_id").on(table.tierId)
  ]
);

export const operationPlanetProgressAwards = pgTable(
  "operation_planet_progress_awards",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    operationId: uuid("operation_id")
      .notNull()
      .references(() => operations.id, { onDelete: "cascade" }),
    planetId: uuid("planet_id")
      .notNull()
      .references(() => planets.id, { onDelete: "cascade" }),
    tierId: uuid("tier_id").references(() => xpRewardTiers.id, { onDelete: "set null" }),
    missionName: text("mission_name").notNull(),
    missionNameMatch: text("mission_name_match").notNull(),
    progressPercent: numeric("progress_percent", { precision: 6, scale: 3 }).notNull(),
    awardedAt: timestamp("awarded_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("idx_operation_planet_progress_awards_operation_planet").on(table.operationId, table.planetId),
    index("idx_operation_planet_progress_awards_planet_id").on(table.planetId),
    index("idx_operation_planet_progress_awards_tier_id").on(table.tierId)
  ]
);
