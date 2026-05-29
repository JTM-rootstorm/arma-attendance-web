# Arma Attendance Web

Web/API service for the Arma 3 Attendance Tracker.

Phase 0 proves that the Arma extension can reach a deployed web API, send JSON with bearer-token auth, and receive compact JSON back. Phase 0.5 persists authenticated debug pokes to PostgreSQL so deployment can prove API-to-database connectivity before real attendance ingest begins. Phase 1-A adds raw operation ingest endpoints that persist start/finish operation payloads. Phase 1-B adds authenticated raw-operation observability endpoints. Phase 1-C/1-D adds normalized attendance/player/stat storage derived from raw operation payloads when player arrays are present. Phase 2 readiness adds internal summary APIs, CSV exports, data-quality checks, a rerunnable attendance backfill script, and an internal React dashboard. Discord readiness adds DB/API/admin surfaces for a future bot to sync guild roles and evaluate attendance-based role actions. Auth readiness adds Discord OAuth browser login, server-side sessions, local app roles, admin user management, and Steam identity linking. Battalion readiness treats backend `units` as battalions, adds roster/rank/squad management, and ranks battalions by scoreboard kill totals.

Raw payloads remain the source of truth. Browser access is now session-cookie based with Discord OAuth, Steam identity linking, unit-scoped RBAC, and sensitive identifier redaction. Machine-token bearer auth remains for Arma ingest, smoke scripts, and future bot automation. Queues, Redis, and required Docker deployment are still intentionally out of scope.

## Stack

- Node.js 24 LTS
- pnpm workspaces
- TypeScript
- Fastify API
- Zod config and request validation
- Vite + React internal dashboard
- systemd deployment on Debian 13 LXC
- Existing reverse proxy for HTTPS/TLS

## Local Development

Enable pnpm through Corepack, install dependencies, and create a local env file:

```bash
corepack enable
pnpm install
cp .env.local.example .env
pnpm dev:api
```

If your Node.js package does not include `corepack`, use the pinned pnpm version through npm:

```bash
npm exec pnpm@10.0.0 -- install
npm exec pnpm@10.0.0 -- dev:api
```

In another terminal:

```bash
pnpm smoke:local
```

`pnpm smoke:local` does not require PostgreSQL. It verifies the basic API, auth rejection, and validation rejection. Use `pnpm smoke:db` only when a reachable `DATABASE_URL` has been configured and migrations have been applied.

The web shell can be run separately:

```bash
pnpm dev:web
```

The Vite dev server proxies `/health` and `/v1/*` to the local API at `http://127.0.0.1:3000`, so leave `VITE_API_BASE_URL` unset for normal local dashboard development. Use `VITE_API_BASE_URL` only when intentionally testing against a separately configured API origin.

## Front-end Font Assets

The dashboard vendors the AurekFonts `Aurebesh AF` package under:

`apps/web/public/fonts/aurebesh/`

The default decorative font is `AurebeshAF-Canon.otf`, loaded as `Aurebesh AF Canon`.

To refresh the package:

```bash
pnpm fonts:aurebesh
```

Source:
https://aurekfonts.github.io/?font=AurebeshAF

The AurekFonts catalog lists the package license as:

> Free for all personal and commercial uses.

Aurebesh is used only for decorative tactical-console labels and microtext. Do not use it as the primary UI/body font.

## Build And Typecheck

```bash
pnpm build
pnpm typecheck
```

`pnpm build` produces:

- `apps/api/dist/index.js`
- `apps/web/dist/`

## API Endpoints

```http
GET  /health
GET  /health/db
GET  /
POST /v1/debug/poke
GET  /v1/dashboard/summary
GET  /v1/data-quality
GET  /v1/operations
POST /v1/operations/start
POST /v1/operations/:operation_id/finish
GET  /v1/operations/:operation_id
GET  /v1/operations/:operation_id/attendance
GET  /v1/operations/:operation_id/attendance.csv
GET  /v1/operations/:operation_id/payloads
GET  /v1/operations/:operation_id/summary
GET  /v1/ingest-requests/:request_id
GET  /v1/players
GET  /v1/players.csv
GET  /v1/players/:player_uid
GET  /v1/players/:player_uid/summary
GET  /v1/units
POST /v1/units
PATCH /v1/units/:unit_id
DELETE /v1/units/:unit_id
GET  /v1/units/:unit_id/roster
POST /v1/units/:unit_id/players
PATCH /v1/units/:unit_id/players/:player_uid
DELETE /v1/units/:unit_id/players/:player_uid
GET  /v1/units/:unit_id/ranks
POST /v1/units/:unit_id/ranks
PATCH /v1/units/:unit_id/ranks/:rank_id
DELETE /v1/units/:unit_id/ranks/:rank_id
GET  /v1/units/:unit_id/squads
POST /v1/units/:unit_id/squads
PATCH /v1/units/:unit_id/squads/:squad_id
DELETE /v1/units/:unit_id/squads/:squad_id
PATCH /v1/units/:unit_id/squad-layout
GET  /v1/units/:unit_id/admins
PUT  /v1/units/:unit_id/admins/:user_id
DELETE /v1/units/:unit_id/admins/:user_id
GET  /v1/leaderboard/units
GET  /auth/discord/start
GET  /auth/discord/callback
POST /auth/logout
GET  /auth/csrf
GET  /auth/steam/start
GET  /auth/steam/callback
GET  /v1/me
GET  /v1/me/player
GET  /v1/me/operations
GET  /v1/me/operations/:operation_id
DELETE /v1/me/identities/steam
GET  /v1/admin/users
GET  /v1/admin/users/:user_id
PUT  /v1/admin/users/:user_id/roles/:role
DELETE /v1/admin/users/:user_id/roles/:role
POST /v1/admin/users/:user_id/disable
POST /v1/admin/users/:user_id/enable
GET  /v1/system/machine-tokens
POST /v1/system/machine-tokens
DELETE /v1/system/machine-tokens/:token_id
POST /v1/discord/guilds/sync
GET  /v1/discord/auth-policy
GET  /v1/discord/guilds
GET  /v1/discord/guilds/:guild_id
PUT  /v1/discord/guilds/:guild_id/auth-policy
GET  /v1/discord/guilds/:guild_id/roles
GET  /v1/discord/guilds/:guild_id/member-snapshots
POST /v1/discord/guilds/:guild_id/member-snapshots
GET  /v1/discord/guilds/:guild_id/role-mappings
POST /v1/discord/guilds/:guild_id/role-mappings
PATCH /v1/discord/guilds/:guild_id/role-mappings/:mapping_id
DELETE /v1/discord/guilds/:guild_id/role-mappings/:mapping_id
GET  /v1/discord/player-links
POST /v1/discord/player-links
DELETE /v1/discord/player-links/:discord_user_id
GET  /v1/discord/guilds/:guild_id/rules
POST /v1/discord/guilds/:guild_id/rules
PATCH /v1/discord/guilds/:guild_id/rules/:rule_id
DELETE /v1/discord/guilds/:guild_id/rules/:rule_id
GET  /v1/discord/guilds/:guild_id/role-actions
POST /v1/discord/guilds/:guild_id/role-action-results
GET  /v1/discord/guilds/:guild_id/role-action-audits
POST /v1/discord/reconcile
GET  /v1/discord/assignment-audits
```

`GET /health` is unauthenticated and returns the service name, version, and current time.

`GET /health/db` requires an owner session or machine-token auth and checks PostgreSQL connectivity without exposing secrets.

Browser/user endpoints use the session cookie created by Discord OAuth login. Machine endpoints use bearer auth:

```http
Authorization: Bearer <API_TOKEN>
```

DB-backed machine tokens created by owners at `/v1/system/machine-tokens` are also accepted for the matching automation kind. The full token is shown only once when created.

JSON request bodies also require:

```http
Content-Type: application/json
```

## Debug Poke

`POST /v1/debug/poke` stores a DB-backed debug row and returns its ID.

Example:

```bash
curl -fsS -X POST http://127.0.0.1:3000/v1/debug/poke \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"request_id":"optional-id","message":"hello from curl","server_key":"dev-machine"}'
```

Expected success shape:

```json
{
  "ok": true,
  "received": true,
  "persisted": true,
  "reply": "poke accepted",
  "debug_poke_id": "uuid",
  "created_at": "2026-05-15T00:00:00.000Z",
  "echo": {
    "request_id": "optional-id",
    "message": "hello from curl",
    "server_key": "dev-machine"
  }
}
```

## Operation Ingest

Phase 1-A stores raw operation start/finish JSON. Phase 1-C/1-D also normalizes identifiable player rows and finish stats when a payload includes a `players` array.

Start an operation:

```bash
curl -fsS -X POST http://127.0.0.1:3000/v1/operations/start \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "server-01:test-op:start",
    "server_key": "server-01",
    "mission": {
      "mission_uid": "test-op",
      "mission_name": "Operation Test",
      "world_name": "VR"
    },
    "players": []
  }'
```

Finish an operation:

```bash
curl -fsS -X POST http://127.0.0.1:3000/v1/operations/<operation_id>/finish \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{
    "request_id": "server-01:test-op:finish",
    "server_key": "server-01",
    "players": []
  }'
```

Fetch an operation:

```bash
curl -fsS http://127.0.0.1:3000/v1/operations/<operation_id> \
  -H "Authorization: Bearer dev-token"
```

Operation ingest requests require `request_id` and `server_key`. Extra payload fields are accepted and stored as raw JSON. Reusing the same `request_id` returns the saved response with `idempotent: true`.

Normalization is tolerant:

- Missing `players` arrays are accepted.
- Player entries without `player_uid`, `arma_uid`, `steam_id`, or `uid` are ignored by normalized tables but kept in raw JSON.
- Weird or missing stat values default to `0` in normalized stats while raw stats remain inspectable.

## Operation Observability

Phase 1-B exposes raw-operation observability. Phase 1-C/1-D adds normalized read APIs beside it.

List recent operations:

```bash
curl -fsS "http://127.0.0.1:3000/v1/operations?server_key=server-01&status=finished&limit=25" \
  -H "Authorization: Bearer dev-token"
```

Unauthenticated callers may also read `GET /v1/operations`. Anonymous responses are limited to the most recent 20 rows, force `offset=0`, ignore sensitive filters such as `server_key` and `mission_uid`, and redact internal IDs and payload counts.

Supported query parameters:

- `server_key`
- `status`: `started`, `finished`, or `abandoned`
- `mission_uid`
- `limit`: default `50`, max `200`
- `offset`: default `0`

Fetch raw operation payload rows:

```bash
curl -fsS "http://127.0.0.1:3000/v1/operations/<operation_id>/payloads" \
  -H "Authorization: Bearer dev-token"
```

Fetch the saved ingest request and response for idempotency debugging:

```bash
curl -fsS "http://127.0.0.1:3000/v1/ingest-requests/$(python3 -c 'import urllib.parse; print(urllib.parse.quote("server-01:test-op:start", safe=""))')" \
  -H "Authorization: Bearer dev-token"
```

`request_id` path parameters should be URL-encoded because request IDs may contain characters such as `:` or `/`.

Fetch normalized attendance for an operation:

```bash
curl -fsS "http://127.0.0.1:3000/v1/operations/<operation_id>/attendance" \
  -H "Authorization: Bearer dev-token"
```

List normalized players:

```bash
curl -fsS "http://127.0.0.1:3000/v1/players?q=Smoke&limit=50" \
  -H "Authorization: Bearer dev-token"
```

Fetch one normalized player and recent operations:

```bash
curl -fsS "http://127.0.0.1:3000/v1/players/<player_uid>" \
  -H "Authorization: Bearer dev-token"
```

This does not require Arma manual testing. The new normalization layer is verified with synthetic HTTP payloads. Real Arma payload collection and extension-side operation modules remain future work.

## Dashboard, Summaries, And Exports

The built Vite dashboard is served by Fastify from `apps/web/dist` when `pnpm build` has run. If the web build is missing, `GET /` falls back to a minimal HTML status page. API routes under `/v1/*` and `/health*` remain API-only and are not swallowed by the dashboard fallback.

The dashboard is a logged-in browser app. Anonymous visitors see only the login screen. Normal users see their own stats, operations, and identity linking. Officers and unit admins see assigned-unit command surfaces. Owners also see global identity/admin and System machine-token pages.

Summary endpoints:

```bash
curl -fsS "http://127.0.0.1:3000/v1/dashboard/summary" \
  -b cookie-jar.txt

curl -fsS "http://127.0.0.1:3000/v1/operations/<operation_id>/summary" \
  -b cookie-jar.txt

curl -fsS "http://127.0.0.1:3000/v1/players/<player_uid>/summary" \
  -b cookie-jar.txt
```

CSV export endpoints:

```bash
curl -fsS "http://127.0.0.1:3000/v1/operations/<operation_id>/attendance.csv" \
  -b cookie-jar.txt

curl -fsS "http://127.0.0.1:3000/v1/players.csv?q=Smoke" \
  -b cookie-jar.txt
```

Data-quality checks:

```bash
curl -fsS "http://127.0.0.1:3000/v1/data-quality" \
  -b cookie-jar.txt
```

Backfill/reprocess normalized attendance from existing raw payload rows:

```bash
pnpm db:backfill:attendance
pnpm db:backfill:attendance -- --dry-run
pnpm db:backfill:attendance -- --operation-id <operation_id>
pnpm db:backfill:units -- --map-operations --map-players
```

The backfill script is safe to rerun. It does not delete raw payload rows and does not mutate raw ingest tables.

`pnpm db:backfill:units` creates or updates a default unit from `DEFAULT_UNIT_SLUG` / `DEFAULT_UNIT_NAME` or safe defaults. Mapping existing operations and players is opt-in through flags.

## Battalion Command And Leaderboard

Battalions are stored as backend `units`. The BTN page labels them as battalions and exposes roster, rank, squad, and placement management through session-cookie RBAC.

Role behavior:

- Owners manage the full battalion lifecycle, including create/deactivate and battalion admin assignments.
- TCW admins can administer assigned battalions and see sensitive identifiers within their scope.
- Unit admins can manage assigned battalion roster entries, ranks, squads, and squad placements.
- Officers and members can read assigned battalion rosters.
- Plain authenticated users with no unit assignment see no battalion roster.

Roster management supports manual player adds/removals, battalion rank assignment, flat squads, nested squad/fireteam trees, squad lead/fireteam lead/trooper billets, and an unassigned intake section. The web page uses dropdown layout controls as the no-dependency fallback path for squad placement saves; a future Discord bot can import assignments through the same source-aware schema.

The LDR page ranks active battalions by current active roster stats:

```text
total_kills = infantry_kills + soft_vehicle_kills + armor_kills + air_kills
```

Deaths are displayed separately and are not subtracted.

The battalion leaderboard API (`GET /v1/leaderboard/units`) is public for unauthenticated callers. Anonymous responses keep aggregate scores and names but redact internal unit IDs and unit keys.

Synthetic battalion validation:

```bash
pnpm smoke:battalions
pnpm smoke:leaderboard
```

These scripts require a running API, migrated PostgreSQL database, and test auth enabled through non-production mode or `ENABLE_TEST_AUTH=true`.

## Authentication And Identity

Discord OAuth is the primary browser login. The app stores local `app_users`, linked provider identities, app roles, and opaque server-side sessions. It does not store local passwords or Discord access tokens.

Steam OpenID is a linked identity only. Steam login does not grant app permissions by itself and the app never asks for a Steam username or password.

Machine-token bearer auth remains available for Arma ingest, smoke scripts, and bot-facing automation endpoints. Browser/admin workflows should use the session cookie created by Discord login.

Session cookies are `HttpOnly`, `Path=/`, use `SESSION_SAME_SITE` (`Lax` by default), and are `Secure` when `SESSION_SECURE=true`.

## Base44 Integration

Base44 is a frontend for human users. User-facing Base44 screens should redirect through the API Discord OAuth flow, rely on the HttpOnly session cookie, and call the API with `credentials: "include"`. API keys and machine tokens must not be placed in Base44 client-side code.

Base44 can still use two auth paths, but only the session path is appropriate for browser UI:

```text
Human users:
  Base44 UI -> /auth/discord/start?return_to=... -> Discord OAuth -> session cookie -> RBAC

Automated/server-side Base44 actions, only if Base44 can store secrets server-side:
  dedicated DB-backed base44_integration machine token
```

The API supports both `return_to` and `redirect_after` on `/auth/discord/start` and `/auth/steam/start`. Absolute return URLs are allowed only when their origin is listed in `OAUTH_ALLOWED_RETURN_ORIGINS`; relative app paths remain supported for the native/self-hosted web UI.

For unsafe session-authenticated requests (`POST`, `PUT`, `PATCH`, `DELETE`), fetch `/auth/csrf` and send the returned value as `X-CSRF-Token`. Unsafe session requests also require an allowed browser `Origin`. Machine-token requests skip CSRF.

The Base44 agent handoff is committed at [`docs/base44/BASE44_AGENT.md`](docs/base44/BASE44_AGENT.md).

Required production Base44 env:

```env
CORS_ALLOWED_ORIGINS=https://tcwa3-galaxy-map.base44.app,https://preview-sandbox--6986a916d70fdb8646418766.base44.app
CORS_ALLOW_CREDENTIALS=true
SESSION_SAME_SITE=None
SESSION_SECURE=true
OAUTH_ALLOWED_RETURN_ORIGINS=https://tcwa3-galaxy-map.base44.app,https://preview-sandbox--6986a916d70fdb8646418766.base44.app
CSRF_ENABLED=true
CSRF_TOKEN_TTL_MINUTES=120
```

Fetch pattern:

```js
await fetch("https://arma-stats.root-storm.com/v1/me", {
  credentials: "include"
});
```

Create a Base44 token from the browser:

1. Login as an owner.
2. Open SYSTEM.
3. Create a machine token.
4. Select `Base44 integration`.
5. Copy the one-time token and store it only in Base44 secret/server-side integration settings.

Do not place Base44 tokens in `.env`, frontend code, or browser/client-side Base44 code. The `base44_integration` token kind is limited to safe read surfaces such as dashboard summary, leaderboard, unit list, operation list, and player list. Owner/system token management remains session-owner only.

After deploy, run:

```bash
BASE_URL=https://YOUR_PUBLIC_HOST pnpm smoke:cors
BASE_URL=https://YOUR_PUBLIC_HOST pnpm smoke:base44
BASE_URL=https://YOUR_PUBLIC_HOST pnpm smoke:base44:oauth
BASE_URL=https://YOUR_PUBLIC_HOST pnpm smoke:csrf
```

Reverse proxies in front of the API must allow and forward `OPTIONS`, `Origin`, `Authorization`, `Content-Type`, `X-CSRF-Token`, `Access-Control-Request-Method`, `Access-Control-Request-Headers`, `Cookie`, and `Set-Cookie`.

Role summary:

| Actor | Browser access | Exports | Sensitive IDs | System tokens |
|---|---|---:|---:|---:|
| Anonymous | Login only | No | No | No |
| Viewer | Own stats, own operations, identity | No | Self only | No |
| Officer | Assigned-unit roster and operations, read-only | No | No | No |
| Unit admin | Assigned-unit roster, mappings, attendance rules, battalion layout | Assigned units | Assigned roster UID only | No |
| TCW admin | Assigned multi-unit admin surfaces | Assigned units | Yes, within scope | No |
| Owner | All surfaces | Yes | Yes | Yes |

Sensitive identifiers are visible only to TCW admins and owners except for a user's own linked player identity. Restricted fields include player UID, Steam ID, Discord ID, server key, mission UID, operation UUID where exposed as a raw ID, and raw payload identifiers containing those values.

First admin setup is server-side:

```bash
# Have the user log in with Discord once first.
pnpm admin:grant -- --provider discord --provider-user-id <discord_user_id> --role owner
pnpm admin:list
```

If the local app user UUID is known:

```bash
pnpm admin:grant -- --user-id <uuid> --role owner
```

Emergency recovery fallback:

```env
INITIAL_ADMIN_DISCORD_IDS=<discord_user_id>
```

This fallback grants `owner` during Discord login, writes an audit event with `actor_label = system/env-bootstrap`, and logs a server warning. Prefer the `pnpm admin:grant` path and remove the env fallback after recovery when practical.

Synthetic auth validation:

```bash
pnpm smoke:auth
pnpm smoke:rbac
```

`pnpm smoke:auth` requires a running API with a migrated database and test auth enabled through non-production mode or `ENABLE_TEST_AUTH=true`. It uses fake Discord/Steam identities and does not contact real OAuth providers.

`pnpm smoke:rbac` creates synthetic users, units, attendance rows, and owner machine tokens. It verifies anonymous rejection, self-only viewer pages, officer read-only access, unit admin boundaries, TCW sensitive-ID access, owner-only System token management, and DB-backed machine-token auth.

## Discord Integration Readiness

Discord readiness provides the database schema, authenticated API contracts, deterministic role evaluation, and the COMMS admin tab needed before a separate bot is built. The app does not store a Discord bot token and does not run a Discord client process.

Discord auth can be restricted to one or more configured guilds with `DISCORD_AUTH_ENABLED=true` and `DISCORD_AUTH_REQUIRE_GUILD=true`. The OAuth flow requests `identify guilds.members.read`, stores per-guild member-role snapshots at login, and can reconcile unit/rank assignments from role mappings. Partner guild mappings should use higher unit/rank priorities than fallback guilds; explicit app-role mappings are required for global permissions. A sample policy lives at `config/discord-guild-auth.example.json`.

Bot-facing endpoints accept the normal `API_TOKEN`. If `BOT_API_TOKEN` is set, those same endpoints also accept that token:

- `POST /v1/discord/guilds/sync`
- `POST /v1/discord/guilds/:guild_id/member-snapshots`
- `POST /v1/discord/reconcile`
- `GET /v1/discord/guilds/:guild_id/role-actions`
- `POST /v1/discord/guilds/:guild_id/role-action-results`

Admin endpoints use session-cookie RBAC and cover guild/role snapshots, player links, attendance rules, evaluations, and audit history. Owners can manage all guilds. TCW admins and unit admins can manage assigned-unit guilds; unassigned guilds are owner-only until associated with a unit. The COMMS dashboard tab is the browser operator surface for the same data.

Role evaluation is dry-run by default. It scores finished operations unless a rule opts into started operations, supports lookback/server/mission filters, and emits only planned `grant`, `skip`, and preview-only `revoke_preview` actions. Persisted evaluations create `discord_role_action_audits` rows so a future bot can report action results back.

Synthetic Discord validation:

```bash
pnpm smoke:discord
pnpm smoke:discord-auth-policy
```

`pnpm smoke:discord` requires the API to be running against a migrated PostgreSQL database. It creates synthetic attendance, syncs a fake guild and role, links a player, creates a rule, dry-runs role actions, persists an audit, reports a bot result, and fetches the audit trail.

Errors use:

```json
{
  "ok": false,
  "error": {
    "code": "string_code",
    "message": "Human-readable message."
  }
}
```

## Environment

For local development:

```bash
cp .env.local.example .env
```

The local example uses `API_TOKEN=dev-token` and binds to `127.0.0.1`.

For production on the LXC:

```bash
cp .env.example /opt/arma-attendance/.env
openssl rand -hex 32
```

Replace `API_TOKEN`, `PUBLIC_BASE_URL`, and any real database password before starting the service. Phase 0.5 uses `DATABASE_URL` for DB-backed debug pokes, `/health/db`, and migration scripts.

Set `BOT_API_TOKEN` only if the future Discord bot should authenticate with a token separate from `API_TOKEN`. Leave it blank to use the normal API token for smoke tests and manual readiness checks.

Auth variables:

```env
DISCORD_CLIENT_ID=
DISCORD_CLIENT_SECRET=
DISCORD_REDIRECT_URI=https://arma-stats.example.com/auth/discord/callback
STEAM_RETURN_URL=https://arma-stats.example.com/auth/steam/callback
STEAM_REALM=https://arma-stats.example.com/
SESSION_COOKIE_NAME=arma_attendance_session
SESSION_SECRET=change-this-session-secret
SESSION_TTL_HOURS=168
SESSION_SECURE=true
SESSION_SAME_SITE=Lax
CORS_ALLOWED_ORIGINS=https://tcwa3-galaxy-map.base44.app,https://preview-sandbox--6986a916d70fdb8646418766.base44.app
CORS_ALLOW_CREDENTIALS=true
OAUTH_ALLOWED_RETURN_ORIGINS=https://tcwa3-galaxy-map.base44.app,https://preview-sandbox--6986a916d70fdb8646418766.base44.app
CSRF_ENABLED=true
CSRF_TOKEN_TTL_MINUTES=120
INITIAL_ADMIN_DISCORD_IDS=
ENABLE_TEST_AUTH=false
```

Use `ENABLE_TEST_AUTH=true` only for local/synthetic smoke validation. Do not expose test auth helpers in production.

Never commit real `.env` files.

## Database Migrations

SQL migrations live in `sql/migrations/` and use numeric prefixes. Current migrations:

- `0001_debug_pokes.sql`
- `0002_raw_operations_ingest.sql`
- `0003_normalized_attendance.sql`
- `0004_discord_integration.sql`
- `0005_auth_identity.sql`
- `0006_unit_rbac.sql`
- `0007_rbac_session_machine_tokens.sql`
- `0008_authenticated_roster_defaults.sql`
- `0009_discord_default_player_names.sql`
- `0010_scoreboard_stats.sql`
- `0011_battalion_roster_and_leaderboard.sql`
- `0012_base44_machine_token_kind_and_cors_sessions.sql`
- `0013_base44_oauth_csrf_hardening.sql`

Applied migration state is tracked in PostgreSQL with `schema_migrations`, including a SHA-256 checksum so edited applied migrations are rejected.

Migration files should be forward-only and idempotent enough to reconcile older manual table shapes when practical. If a migration uses `CREATE TABLE IF NOT EXISTS`, add explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, default, constraint, and validation steps before creating dependent indexes. The migration runner has a preflight hook for pending migrations that need compatibility checks before applying their SQL. Future migrations can also add optional compatibility SQL at `sql/migration-preflight/<migration-filename>.sql`; it will run only while that migration is pending.

## Drizzle ORM

The API uses Drizzle as an optional typed query layer for selected routes. SQL migrations in `sql/migrations/` remain authoritative, and `pnpm db:migrate` is the only supported migration command for deployed databases.

For Drizzle usage boundaries and completion checks, see `docs/database/DRIZZLE.md`.

Current policy:

- Drizzle schema files mirror existing PostgreSQL tables.
- Drizzle Kit is allowed for local checks and introspection, but must not push schema changes to shared or deployed databases.
- Raw SQL remains acceptable and preferred for complex CTE, reporting, ingest, export, and backfill paths.
- Do not commit generated Drizzle migration output under `sql/drizzle/`.

Recommended development flow:

```bash
pnpm db:status
pnpm db:migrate
pnpm typecheck
pnpm build
```

When adding a SQL migration, add the forward-only SQL first, update the matching Drizzle schema mirror, update route or service code, and run the focused smoke scripts for the touched surface.

Run these only where `DATABASE_URL` points at the intended PostgreSQL database:

```bash
pnpm db:status
pnpm db:migrate
pnpm smoke:db
pnpm smoke:operations
pnpm smoke:operations:observability
pnpm smoke:attendance
pnpm smoke:scoreboard
pnpm smoke:battalions
pnpm smoke:leaderboard
pnpm smoke:cors
pnpm smoke:base44
pnpm smoke:dashboard
pnpm smoke:exports
pnpm smoke:data-quality
pnpm smoke:discord
pnpm smoke:auth
pnpm smoke:rbac
```

`pnpm smoke:db` performs HTTP-level checks against `/health/db` and `/v1/debug/poke`; it does not inspect PostgreSQL directly. `pnpm smoke:operations` exercises operation start, idempotent start replay, finish, and fetch. `pnpm smoke:operations:observability` also lists operations, fetches raw payload rows, and fetches saved ingest requests. `pnpm smoke:attendance` creates synthetic player payloads, verifies normalized operation attendance, and verifies player list/detail APIs. `pnpm smoke:scoreboard` covers split scoreboard stats. `pnpm smoke:battalions` covers battalion creation, roster, ranks, squads, assignments, unit-admin management, and member read-only access. `pnpm smoke:leaderboard` covers battalion ranking and the total-kills formula. `pnpm smoke:cors` checks the Base44 CORS allowlist. `pnpm smoke:base44` creates and revokes a `base44_integration` token and verifies it can read the leaderboard but cannot manage owner system tokens. `pnpm smoke:dashboard`, `pnpm smoke:exports`, and `pnpm smoke:data-quality` cover the Phase 2 readiness read surfaces. `pnpm smoke:discord` covers the Discord readiness sync/link/rule/evaluation/audit flow. `pnpm smoke:auth` covers synthetic Discord login, CLI owner grant, admin role management, Steam identity link/unlink, and logout revocation. `pnpm smoke:rbac` covers session-cookie RBAC, unit scoping, redaction boundaries, and owner machine-token management. These DB-backed smoke scripts require the service to be running with a reachable database, migrations applied, and `API_TOKEN` supplied when the script calls machine-token endpoints.

Normalized attendance tables:

- `players`: one row per identifiable player UID with the latest seen name and raw player object.
- `operation_players`: one row per operation/player pair with start/end presence and role metadata.
- `operation_player_stats`: optional finish stats per operation/player pair.

Release preflight:

```bash
pnpm release:check
RUN_DB_SMOKE=1 pnpm release:check
```

The default release check runs typecheck, lint, build, and local non-DB smoke. `RUN_DB_SMOKE=1` also runs DB-backed smoke scripts, including scoreboard stats, battalion management, leaderboard, dashboard, exports, data quality, Discord readiness, and auth readiness.

## Debian 13 LXC Setup

Recommended minimum resources:

- Debian 13 unprivileged LXC
- 1 CPU core minimum
- 512 MB RAM minimum, 1 GB recommended
- 8 GB disk minimum, 16 GB recommended
- Static IP recommended
- Docker and nesting are not required

Install system dependencies:

```bash
apt update
apt upgrade -y

apt install -y \
  ca-certificates \
  curl \
  gnupg \
  git \
  build-essential \
  python3 \
  make \
  g++ \
  jq \
  nano \
  htop \
  logrotate \
  openssl
```

Install Node.js 24:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
node --version
npm --version
corepack enable
corepack prepare pnpm@latest --activate
pnpm --version
```

If `corepack` is unavailable in the installed Node.js package, the deployment script falls back to:

```bash
npm exec pnpm@10.0.0 -- <command>
```

Set up the app directory and service user:

```bash
useradd --system --home /opt/arma-attendance --shell /usr/sbin/nologin arma-attendance
mkdir -p /opt/arma-attendance
chown arma-attendance:arma-attendance /opt/arma-attendance
git clone <repo-url> /opt/arma-attendance
chown -R arma-attendance:arma-attendance /opt/arma-attendance
```

Create the production env:

```bash
cd /opt/arma-attendance
cp .env.example .env
openssl rand -hex 32
nano .env
```

Build:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm db:status
pnpm db:migrate
pnpm build
pnpm smoke:auth
pnpm smoke:rbac
```

Install and start the service:

```bash
cp systemd/arma-attendance-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now arma-attendance-api
systemctl status arma-attendance-api
```

Logs:

```bash
journalctl -u arma-attendance-api -f
```

Deploy later updates:

```bash
git checkout web-frontend
git pull --ff-only
pnpm install --frozen-lockfile
pnpm db:status
pnpm db:migrate
pnpm build
systemctl restart arma-attendance-api
pnpm smoke:rbac
```

The helper script wraps the same source-update/build/restart path for the LXC:

```bash
bash scripts/deploy-lxc.sh
```

## Reverse Proxy

Point the existing reverse proxy to:

```text
http://<LXC_STATIC_IP>:3000
```

The proxy must forward:

```text
Host
X-Forwarded-For
X-Forwarded-Proto
Authorization
Content-Type
X-CSRF-Token
Origin
Cookie
Set-Cookie
Access-Control-Request-Method
Access-Control-Request-Headers
```

`Authorization` is required for `/v1/debug/poke`.

## Validation Checklist

```bash
pnpm install
pnpm build
pnpm typecheck
cp .env.local.example .env
pnpm dev:api
pnpm smoke:local
```

When a database is available, also run:

```bash
pnpm db:status
pnpm db:migrate
pnpm smoke:db
pnpm smoke:operations
pnpm smoke:operations:observability
pnpm smoke:attendance
pnpm smoke:scoreboard
pnpm smoke:battalions
pnpm smoke:leaderboard
pnpm smoke:cors
pnpm smoke:base44:oauth
pnpm smoke:csrf
pnpm smoke:dashboard
pnpm smoke:exports
pnpm smoke:data-quality
pnpm smoke:discord
pnpm smoke:auth
pnpm smoke:rbac
```

Also verify no real env files are staged before opening a pull request.
