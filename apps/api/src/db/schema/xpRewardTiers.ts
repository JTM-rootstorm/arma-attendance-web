import { integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { appUsers } from "./auth.js";

export const xpRewardTiers = pgTable("xp_reward_tiers", {
  id: uuid("id").defaultRandom().primaryKey(),
  missionNameMatch: text("mission_name_match").notNull(),
  xpAmount: integer("xp_amount").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => appUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});
