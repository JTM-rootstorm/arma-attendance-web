# Arma Attendance Web

Web/API service for the Arma 3 Attendance Tracker.

Phase 0 proves that the Arma extension can reach a deployed web API, send JSON with bearer-token auth, and receive compact JSON back. Phase 0.5 persists authenticated debug pokes to PostgreSQL so deployment can prove API-to-database connectivity before real attendance ingest begins. Phase 1-A adds raw operation ingest endpoints that persist start/finish operation payloads before normalized attendance/stat tables are designed.

The service intentionally does not include normalized player stats, dashboards, user authentication, queues, Redis, or Docker yet.

## Stack

- Node.js 24 LTS
- pnpm workspaces
- TypeScript
- Fastify API
- Zod config and request validation
- Vite + React web shell
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
POST /v1/operations/start
POST /v1/operations/:operation_id/finish
GET  /v1/operations/:operation_id
```

`GET /health` is unauthenticated and returns the service name, version, and current time.

`GET /health/db` requires bearer auth and checks PostgreSQL connectivity without exposing secrets.

All `/v1/*` endpoints require:

```http
Authorization: Bearer <API_TOKEN>
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

Phase 1-A stores raw operation start/finish JSON. It does not normalize players or stats yet.

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

Never commit real `.env` files.

## Database Migrations

SQL migrations live in `sql/migrations/` and use numeric prefixes. Current migrations:

- `0001_debug_pokes.sql`
- `0002_raw_operations_ingest.sql`

Applied migration state is tracked in PostgreSQL with `schema_migrations`, including a SHA-256 checksum so edited applied migrations are rejected.

Run these only where `DATABASE_URL` points at the intended PostgreSQL database:

```bash
pnpm db:status
pnpm db:migrate
pnpm smoke:db
pnpm smoke:operations
```

`pnpm smoke:db` performs HTTP-level checks against `/health/db` and `/v1/debug/poke`; it does not inspect PostgreSQL directly. `pnpm smoke:operations` exercises operation start, idempotent start replay, finish, and fetch. It requires the service to be running with a reachable database, migrations applied, and `API_TOKEN` supplied.

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
```

Also verify no real env files are staged before opening a pull request.
