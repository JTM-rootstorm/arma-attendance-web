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
- Unit and battalion reads, roster reads, rank reads, squad reads, and admin-list reads.
- Unit and battalion write paths, including roster/rank/squad/admin mutations and their audit writes.
- Selected auth/session reads, including current-user lookup, machine-token lookup, and unit-role visibility helpers.
- Selected player reads, including player detail lookup, linked-player lookup, self operation reads, and simple roster visibility checks.
- Selected Discord integration CRUD, including guild sync, role reads, player-link CRUD, and attendance-rule CRUD.

Raw SQL by policy:

- Operation start/finish ingest.
- Ingest idempotency.
- Operation payload writes.
- Attendance normalization inserts and upserts.
- Dashboard and leaderboard CTEs.
- Player/self stat aggregate totals and recent-operation aggregate projections when raw SQL is clearer.
- CSV exports.
- Data-quality checks.
- Attendance and scoreboard backfills.
- Discord role evaluation scoring.
- Migration and deployment scripts.

Hybrid boundaries are intentional. Drizzle may wrap or sit beside raw SQL for a route when the row lookup is simple but the aggregate, CTE, idempotency, or reporting query is easier to reason about in plain SQL.

## Local Checks

Use Drizzle Kit only for local schema validation and introspection:

```bash
pnpm drizzle:check
pnpm typecheck
pnpm build
```

If `drizzle-kit check` creates local files under `sql/drizzle/`, leave them untracked.
