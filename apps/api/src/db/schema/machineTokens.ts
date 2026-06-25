import { boolean, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { appUsers } from "./auth.js";

export const machineTokens = pgTable("machine_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenCiphertext: text("token_ciphertext"),
  tokenPrefix: text("token_prefix").notNull(),
  tokenKind: text("token_kind").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdByUserId: uuid("created_by_user_id").references(() => appUsers.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => appUsers.id, { onDelete: "set null" }),
  description: text("description"),
  allowedOrigin: text("allowed_origin"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([])
});
