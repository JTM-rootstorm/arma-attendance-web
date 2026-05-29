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

## Boundary Definition Of Done

The Drizzle implementation is complete for the current hybrid architecture when:

- SQL migrations remain authoritative and no deployment flow depends on Drizzle-generated migrations.
- Drizzle schema files mirror the current PostgreSQL schema represented by `sql/migrations/`.
- In-scope simple CRUD/read paths use Drizzle.
- Raw SQL usage is limited to the approved raw-SQL categories and allowlisted files.
- `pnpm drizzle:check`, `pnpm drizzle:boundary`, `pnpm typecheck`, `pnpm build`, and DB smoke tests pass.

Approved raw SQL is not technical debt for this branch. It is an intentional part of the architecture where plain SQL better preserves transactional ingest semantics, aggregate readability, or deployment safety.

## Approved Raw SQL Policy

| Category | Allowed examples | Reason |
|---|---|---|
| Operation ingest | start/finish operations, ingest replay checks, operation payload writes | transactional raw payload durability and idempotency |
| Normalization | operation attendance/stat inserts and upserts | complex upsert behavior across operation/player pairs |
| Reporting | dashboard, leaderboard, CSV, data-quality, player stat aggregates | CTE and aggregate clarity |
| Backfills | scripts under `apps/api/src/scripts/` | migration-safe maintenance and replay tasks |
| Discord scoring | role-evaluation aggregate queries and action audit reporting | rule evaluation CTEs and external reporting state |
| Auth/session bridge | OAuth/test-auth compatibility paths that still mix provider state and audit writes | transitional hybrid surface, candidate for future conversion |
| Admin/user search | multi-filter admin search and role management paths | dynamic filters and audit transactions, candidate for future conversion |
| Migration/deploy | `scripts/db-*.sh`, `sql/migrations/` | SQL migrations remain owner |
| Smoke tests | `scripts/*smoke*.sh` | synthetic setup and assertions |

The allowlist for concrete files lives in `docs/database/DRIZZLE_RAW_SQL_ALLOWLIST.md` and is enforced by `pnpm drizzle:boundary`.

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
- Smoke-test seed SQL.
- Health/readiness probes where raw SQL is clearer.

Hybrid boundaries are intentional. Drizzle may wrap or sit beside raw SQL for a route when the row lookup is simple but the aggregate, CTE, idempotency, or reporting query is easier to reason about in plain SQL.

## Local Checks

Use Drizzle Kit only for local schema validation and introspection:

```bash
pnpm drizzle:check
pnpm drizzle:boundary
pnpm typecheck
pnpm build
```

If `drizzle-kit check` creates local files under `sql/drizzle/`, leave them untracked.

## Local 100% Validation

Use this gate before publishing the Drizzle boundary branch:

```bash
pnpm install --frozen-lockfile
pnpm drizzle:check
pnpm drizzle:boundary
pnpm release:check
RUN_DB_SMOKE=1 pnpm release:check
```

The DB smoke gate requires:

- a migrated local/test PostgreSQL database
- `DATABASE_URL`
- `API_TOKEN`
- `BOT_API_TOKEN` when Discord/bot smoke uses a different machine token
- `ENABLE_TEST_AUTH=true` for synthetic auth routes
- the API server running on `BASE_URL`
