import { boolean, index, integer, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { appUsers } from "./auth.js";

export const planets = pgTable(
  "planets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    completionPercent: numeric("completion_percent", { precision: 6, scale: 3 }).notNull().default("0.000"),
    displayOrder: integer("display_order").notNull().default(0),
    isActive: boolean("is_active").notNull().default(true),
    createdByUserId: uuid("created_by_user_id").references(() => appUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
  },
  (table) => [
    uniqueIndex("idx_planets_slug_unique").on(table.slug),
    index("idx_planets_public_sort").on(table.isActive, table.displayOrder, table.name)
  ]
);
