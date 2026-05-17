# Arma Attendance Web

Web/API service for the Arma 3 Attendance Tracker.

Phase 0 proves that the Arma extension can reach a deployed web API, send JSON with bearer-token auth, and receive compact JSON back. Phase 0.5 persists authenticated debug pokes to PostgreSQL so deployment can prove API-to-database connectivity before real attendance ingest begins. Phase 1-A adds raw operation ingest endpoints that persist start/finish operation payloads. Phase 1-B adds authenticated raw-operation observability endpoints. Phase 1-C/1-D adds normalized attendance/player/stat storage derived from raw operation payloads when player arrays are present. Phase 2 readiness adds internal summary APIs, CSV exports, data-quality checks, a rerunnable attendance backfill script, and an internal React dashboard. Discord readiness adds DB/API/admin surfaces for a future bot to sync guild roles and evaluate attendance-based role actions.

Raw payloads remain the source of truth. The service intentionally does not include user accounts, Steam login, role-based permissions, queues, Redis, or required Docker deployment yet.

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
POST /v1/discord/guilds/sync
GET  /v1/discord/guilds
GET  /v1/discord/guilds/:guild_id
GET  /v1/discord/guilds/:guild_id/roles
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
```

`GET /health` is unauthenticated and returns the service name, version, and current time.

`GET /health/db` requires bearer auth and checks PostgreSQL connectivity without exposing secrets.

All `/v1/*` endpoints require:

```http
Authorization: Bearer <API_TOKEN>
```

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

The dashboard is an internal operator surface. It uses the existing bearer token only:

- enter the token in the browser,
- it is stored in `sessionStorage`,
- use "Forget token" to clear it.

Summary endpoints:

```bash
curl -fsS "http://127.0.0.1:3000/v1/dashboard/summary" \
  -H "Authorization: Bearer dev-token"

curl -fsS "http://127.0.0.1:3000/v1/operations/<operation_id>/summary" \
  -H "Authorization: Bearer dev-token"

curl -fsS "http://127.0.0.1:3000/v1/players/<player_uid>/summary" \
  -H "Authorization: Bearer dev-token"
```

CSV export endpoints:

```bash
curl -fsS "http://127.0.0.1:3000/v1/operations/<operation_id>/attendance.csv" \
  -H "Authorization: Bearer dev-token"

curl -fsS "http://127.0.0.1:3000/v1/players.csv?q=Smoke" \
  -H "Authorization: Bearer dev-token"
```

Data-quality checks:

```bash
curl -fsS "http://127.0.0.1:3000/v1/data-quality" \
  -H "Authorization: Bearer dev-token"
```

Backfill/reprocess normalized attendance from existing raw payload rows:

```bash
pnpm db:backfill:attendance
pnpm db:backfill:attendance -- --dry-run
pnpm db:backfill:attendance -- --operation-id <operation_id>
```

The backfill script is safe to rerun. It does not delete raw payload rows and does not mutate raw ingest tables.

## Discord Integration Readiness

Discord readiness provides the database schema, authenticated API contracts, deterministic role evaluation, and the COMMS admin tab needed before a separate bot is built. The app does not store a Discord bot token and does not run a Discord client process.

Bot-facing endpoints accept the normal `API_TOKEN`. If `BOT_API_TOKEN` is set, those same endpoints also accept that token:

- `POST /v1/discord/guilds/sync`
- `GET /v1/discord/guilds/:guild_id/role-actions`
- `POST /v1/discord/guilds/:guild_id/role-action-results`

Admin endpoints use the normal bearer token and cover guild/role snapshots, player links, attendance rules, evaluations, and audit history. The COMMS dashboard tab is an internal operator surface for the same data.

Role evaluation is dry-run by default. It scores finished operations unless a rule opts into started operations, supports lookback/server/mission filters, and emits only planned `grant`, `skip`, and preview-only `revoke_preview` actions. Persisted evaluations create `discord_role_action_audits` rows so a future bot can report action results back.

Synthetic Discord validation:

```bash
pnpm smoke:discord
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

Never commit real `.env` files.

## Database Migrations

SQL migrations live in `sql/migrations/` and use numeric prefixes. Current migrations:

- `0001_debug_pokes.sql`
- `0002_raw_operations_ingest.sql`
- `0003_normalized_attendance.sql`
- `0004_discord_integration.sql`

Applied migration state is tracked in PostgreSQL with `schema_migrations`, including a SHA-256 checksum so edited applied migrations are rejected.

Migration files should be forward-only and idempotent enough to reconcile older manual table shapes when practical. If a migration uses `CREATE TABLE IF NOT EXISTS`, add explicit `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, default, constraint, and validation steps before creating dependent indexes. The migration runner has a preflight hook for pending migrations that need compatibility checks before applying their SQL. Future migrations can also add optional compatibility SQL at `sql/migration-preflight/<migration-filename>.sql`; it will run only while that migration is pending.

Run these only where `DATABASE_URL` points at the intended PostgreSQL database:

```bash
pnpm db:status
pnpm db:migrate
pnpm smoke:db
pnpm smoke:operations
pnpm smoke:operations:observability
pnpm smoke:attendance
pnpm smoke:dashboard
pnpm smoke:exports
pnpm smoke:data-quality
pnpm smoke:discord
```

`pnpm smoke:db` performs HTTP-level checks against `/health/db` and `/v1/debug/poke`; it does not inspect PostgreSQL directly. `pnpm smoke:operations` exercises operation start, idempotent start replay, finish, and fetch. `pnpm smoke:operations:observability` also lists operations, fetches raw payload rows, and fetches saved ingest requests. `pnpm smoke:attendance` creates synthetic player payloads, verifies normalized operation attendance, and verifies player list/detail APIs. `pnpm smoke:dashboard`, `pnpm smoke:exports`, and `pnpm smoke:data-quality` cover the Phase 2 readiness read surfaces. `pnpm smoke:discord` covers the Discord readiness sync/link/rule/evaluation/audit flow. These DB-backed smoke scripts require the service to be running with a reachable database, migrations applied, and `API_TOKEN` supplied.

Normalized attendance tables:

- `players`: one row per identifiable player UID with the latest seen name and raw player object.
- `operation_players`: one row per operation/player pair with start/end presence and role metadata.
- `operation_player_stats`: optional finish stats per operation/player pair.

Release preflight:

```bash
pnpm release:check
RUN_DB_SMOKE=1 pnpm release:check
```

The default release check runs typecheck, lint, build, and local non-DB smoke. `RUN_DB_SMOKE=1` also runs DB-backed smoke scripts, including dashboard, exports, data quality, and Discord readiness.

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
pnpm smoke:dashboard
pnpm smoke:exports
pnpm smoke:data-quality
pnpm smoke:discord
```

Also verify no real env files are staged before opening a pull request.
