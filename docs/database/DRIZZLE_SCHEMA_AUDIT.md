# Drizzle Schema Parity Audit

SQL migrations in `sql/migrations/` remain authoritative. This audit records the Drizzle schema mirror for the current PostgreSQL tables through `0013_base44_oauth_csrf_hardening.sql`.

Indexes, check constraints, partial unique indexes, and migration-runner implementation details are documented instead of fully modeled when they are not needed for typed query building.

| Table | Introduced by | Drizzle module | Status | Notes |
|---|---|---|---|---|
| `debug_pokes` | `0001_debug_pokes.sql` | `operations.ts` | OK | columns/defaults/nullability represented; indexes documented only |
| `operations` | `0002_raw_operations_ingest.sql` | `operations.ts` | OK | base columns plus `unit_id` from `0006_unit_rbac.sql` represented; status check/indexes documented only |
| `operation_payloads` | `0002_raw_operations_ingest.sql` | `operations.ts` | OK | columns/defaults/nullability represented; kind check/indexes documented only |
| `ingest_requests` | `0002_raw_operations_ingest.sql` | `operations.ts` | OK | reconciled columns/defaults/nullability represented; indexes documented only |
| `players` | `0003_normalized_attendance.sql` | `players.ts` | OK | columns/defaults/nullability represented; indexes documented only |
| `operation_players` | `0003_normalized_attendance.sql` | `players.ts` | OK | columns/defaults/nullability represented; composite primary key modeled |
| `operation_player_stats` | `0003_normalized_attendance.sql`, `0010_scoreboard_stats.sql` | `players.ts` | OK | base stat columns and scoreboard stat additions represented; composite FK/checks documented only |
| `discord_guilds` | `0004_discord_integration.sql` | `discord.ts` | OK | columns/defaults/nullability represented |
| `discord_roles` | `0004_discord_integration.sql` | `discord.ts` | OK | columns/defaults/nullability represented; composite primary key modeled |
| `player_discord_links` | `0004_discord_integration.sql` | `discord.ts` | OK | columns/defaults/nullability represented; Discord-user unique index and source check documented only |
| `discord_attendance_rules` | `0004_discord_integration.sql`, `0006_unit_rbac.sql` | `discord.ts` | OK | base columns plus `unit_id` represented; role FK/checks documented only |
| `discord_role_action_audits` | `0004_discord_integration.sql` | `discord.ts` | OK | columns/defaults/nullability represented; action/status checks documented only |
| `app_users` | `0005_auth_identity.sql` | `auth.ts` | OK | columns/defaults/nullability represented |
| `user_identities` | `0005_auth_identity.sql` | `auth.ts` | OK | columns/defaults/nullability represented; provider and uniqueness constraints documented only |
| `user_roles` | `0005_auth_identity.sql`, `0006_unit_rbac.sql` | `auth.ts` | OK | columns/defaults/nullability represented; updated role check documented only |
| `user_sessions` | `0005_auth_identity.sql` | `auth.ts` | OK | columns/defaults/nullability represented; session token uniqueness modeled |
| `oauth_states` | `0005_auth_identity.sql` | `auth.ts` | OK | columns/defaults/nullability represented; provider check documented only |
| `admin_audit_events` | `0005_auth_identity.sql` | `auth.ts` | OK | columns/defaults/nullability represented |
| `units` | `0006_unit_rbac.sql`, `0007_rbac_session_machine_tokens.sql`, `0011_battalion_roster_and_leaderboard.sql` | `units.ts` | OK | base columns plus `slug`, display/callsign/emblem/sort/soft-delete fields represented |
| `unit_memberships` | `0006_unit_rbac.sql` | `units.ts` | OK | columns/defaults/nullability represented; role check documented only |
| `unit_players` | `0006_unit_rbac.sql`, `0011_battalion_roster_and_leaderboard.sql` | `units.ts` | OK | base roster columns plus rank/status/assignment additions represented |
| `unit_discord_guilds` | `0006_unit_rbac.sql` | `units.ts` | OK | columns/defaults/nullability represented; composite primary key modeled |
| `unit_user_roles` | `0007_rbac_session_machine_tokens.sql` | `units.ts` | OK | columns/defaults/nullability represented; role check documented only |
| `operation_units` | `0007_rbac_session_machine_tokens.sql` | `units.ts` | OK | columns/defaults/nullability represented; source check documented only |
| `unit_server_keys` | `0007_rbac_session_machine_tokens.sql` | `units.ts` | OK | columns/defaults/nullability represented; composite primary key modeled |
| `machine_tokens` | `0007_rbac_session_machine_tokens.sql`, `0012_base44_machine_token_kind_and_cors_sessions.sql`, `0020_machine_token_download_secrets.sql` | `machineTokens.ts` | OK | base columns plus Base44 metadata and encrypted token download field represented; token-kind check documented only |
| `unit_ranks` | `0011_battalion_roster_and_leaderboard.sql` | `units.ts` | OK | columns/defaults/nullability represented; unit/rank-key uniqueness documented only |
| `unit_squads` | `0011_battalion_roster_and_leaderboard.sql` | `units.ts` | OK | columns/defaults/nullability represented; hierarchy checks documented only |
| `unit_roster_assignments` | `0011_battalion_roster_and_leaderboard.sql` | `units.ts` | OK | columns/defaults/nullability represented; partial unique active-primary index documented only |
| `session_csrf_tokens` | `0013_base44_oauth_csrf_hardening.sql` | `auth.ts` | OK | columns/defaults/nullability represented; token hash uniqueness modeled |

## Not Modeled As Application Schema

| Table/Object | Owner | Reason |
|---|---|---|
| `schema_migrations` | `scripts/db-migrate.sh`, `scripts/db-status.sh` | migration runner metadata, not application data |
| indexes and partial indexes | SQL migrations | Drizzle schema is used for typed query paths, not as the migration owner |
| check constraints | SQL migrations | documented policy remains SQL-authoritative |
| compatibility DO blocks/preflight logic | SQL migrations and scripts | deployment behavior, not runtime query typing |
