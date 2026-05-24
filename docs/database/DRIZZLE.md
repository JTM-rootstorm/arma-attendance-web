# Drizzle Database Layer

Drizzle is used as a typed query builder for selected CRUD and simple read paths. It is not the migration owner for this project.

## Policy

- SQL migrations in `sql/migrations/` remain authoritative.
- `pnpm db:migrate` is the only supported migration command for deployed databases.
- Do not run `drizzle-kit push` against shared, staging, or production databases.
- Do not commit generated Drizzle migration output under `sql/drizzle/`.
- Drizzle schema files under `apps/api/src/db/schema/` must mirror the current PostgreSQL schema.
- When a SQL migration adds, removes, or changes a column, update the matching Drizzle schema in the same change.
- Raw SQL remains allowed and preferred for complex paths where it is clearer or safer.

## Current Use

Converted paths:

- Owner/system machine-token routes.

Good Drizzle candidates:

- Simple unit and battalion reads/writes.
- Simple auth/admin lookup helpers.
- Player lookup/list reads that do not rely on large aggregate queries.
- Discord integration CRUD where transactions stay readable.

Raw SQL by policy:

- Operation start/finish ingest.
- Ingest idempotency.
- Operation payload writes.
- Attendance normalization inserts and upserts.
- Dashboard and leaderboard CTEs.
- CSV exports.
- Data-quality checks.
- Attendance and scoreboard backfills.
- Discord role evaluation scoring.
- Migration and deployment scripts.

## Local Checks

Use Drizzle Kit only for local schema validation and introspection:

```bash
pnpm drizzle:check
pnpm typecheck
pnpm build
```

If `drizzle-kit check` creates local files under `sql/drizzle/`, leave them untracked.
