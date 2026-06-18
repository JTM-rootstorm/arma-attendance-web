import { index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { operations } from "./operations.js";
import { players } from "./players.js";
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
