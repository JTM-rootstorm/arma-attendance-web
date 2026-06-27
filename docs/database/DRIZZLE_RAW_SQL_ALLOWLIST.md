# Drizzle Raw SQL Allowlist

`pnpm drizzle:boundary` enforces this boundary for raw SQL usage in application and script files. SQL migrations remain authoritative and are not scanned as application query code.

| Path | Category | Reason | Policy |
|---|---|---|---|
| `apps/api/src/db/pool.ts` | db plumbing | central PostgreSQL pool wrapper | permanent |
| `apps/api/src/db/transactions.ts` | db plumbing | central transaction wrapper | permanent |
| `apps/api/src/routes/operations.ts` | operation routes | operation route registrar | permanent |
| `apps/api/src/operations/*.ts` | operation services | start/finish ingest, idempotency, payload durability, delete cascade, XP rollback, and detail aggregates | permanent for ingest/aggregate sections |
| `apps/api/src/routes/ingestRequests.ts` | operation ingest | ingest request observability | permanent |
| `apps/api/src/routes/summaries.ts` | reporting | dashboard aggregates and player summary projections | permanent |
| `apps/api/src/routes/leaderboards.ts` | reporting | ranking CTEs and aggregate leaderboard math | permanent |
| `apps/api/src/routes/exports.ts` | reporting | CSV export query shaping | permanent |
| `apps/api/src/routes/dataQuality.ts` | reporting | data-quality aggregate checks | permanent |
| `apps/api/src/routes/healthDb.ts` | health | readiness probe is clearer as direct SQL | permanent |
| `apps/api/src/routes/players.ts` | reporting | player list/detail aggregate projections and privacy-gated summaries | permanent for aggregate sections |
| `apps/api/src/routes/units.ts` | unit hybrid | Drizzle route with limited raw SQL for counts, hierarchy CTE deletion, and aggregate checks | candidate for narrower helper extraction |
| `apps/api/src/routes/discord.ts` | discord hybrid | Discord route registrar | permanent |
| `apps/api/src/routes/discord/*.ts` | discord hybrid | Discord admin CRUD, sync, role action, and audit route modules | candidate for narrower helper extraction |
| `apps/api/src/routes/auth.ts` | auth/session bridge | OAuth and synthetic auth bridge with provider-state, self-stat aggregates, and audit transactions | candidate for future conversion |
| `apps/api/src/routes/bot.ts` | bot reporting | bot-authenticated player lookup, stat aggregates, and attended operation projections | candidate for future conversion |
| `apps/api/src/routes/admin.ts` | admin/user search | admin multi-filter search, role transactions, audit writes, and player-name reset projections | candidate for future conversion |
| `apps/api/src/auth/csrf.ts` | auth/session bridge | CSRF token compatibility path | candidate for future conversion |
| `apps/api/src/auth/operationAccess.ts` | auth/session bridge | operation visibility bridge joining identities to attendance | candidate for future conversion |
| `apps/api/src/identity/playerCanonicalization.ts` | identity merge | Discord placeholder player canonicalization moves related rows across identity, unit, operation, and audit tables | permanent |
| `apps/api/src/normalization/operationAttendance.ts` | normalization | attendance/stat upserts across normalized operation rows | permanent |
| `apps/api/src/normalization/operationUnits.ts` | normalization | operation-player unit attribution from represented unit snapshots and primary operation fallback | permanent |
| `apps/api/src/xp/operationXpAwards.ts` | operation ingest | finish-time XP award ledger and aggregate update transaction | permanent |
| `apps/api/src/discord/scoring.ts` | Discord scoring | rule evaluation CTEs and action audit reporting | permanent |
| `apps/api/src/discord/membershipResolver.ts` | Discord auth sync | Discord guild role claim resolution and assignment reconciliation | permanent |
| `apps/api/src/scripts/backfillAttendance.ts` | backfill | maintenance backfill | permanent |
| `apps/api/src/scripts/backfillScoreboardStats.ts` | backfill | maintenance backfill | permanent |
| `apps/api/src/scripts/backfillUnits.ts` | backfill | maintenance backfill | permanent |
| `scripts/admin-grant.ts` | admin CLI | local owner/admin bootstrap and audit helper | candidate for future conversion |
| `scripts/admin-list.ts` | admin CLI | local administrative inspection helper | candidate for future conversion |
| `scripts/db-migrate.sh` | migration/deploy | SQL migration runner | permanent |
| `scripts/db-status.sh` | migration/deploy | SQL migration status checker | permanent |
| `scripts/*smoke*.sh` | smoke tests | synthetic setup and assertions | permanent |

## Maintenance Rules

- New raw SQL in a non-allowlisted file should fail `pnpm drizzle:boundary`.
- New raw SQL in an allowlisted hybrid file still needs review against `docs/database/DRIZZLE.md`; the allowlist is not permission to expand raw SQL casually.
- If a future change converts a candidate path fully to Drizzle, remove or narrow the corresponding allowlist entry in the same change.
- Generated Drizzle migration output under `sql/drizzle/` must remain untracked and unstaged.
