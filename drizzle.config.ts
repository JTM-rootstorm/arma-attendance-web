import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { defineConfig } from "drizzle-kit";

const repoRoot = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  schema: join(repoRoot, "apps/api/src/db/schema/index.ts"),
  out: join(repoRoot, "sql/drizzle"),
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL ?? "postgres://placeholder/placeholder"
  },
  strict: true,
  verbose: true
});
