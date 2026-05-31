# Operations Guide

This file keeps the root README focused on getting the app running. It collects the operational details that are useful after the first local run: environment setup, database migrations, auth bootstrap, smoke checks, deployment notes, reverse proxy settings, and frontend font maintenance.

## Environment files

Use the checked-in examples as templates:

```bash
cp .env.local.example .env      # local development
cp .env.example .env            # deployed host
```

Do not commit real `.env` files.

The local example is expected to bind the API to `127.0.0.1:3000` and use `API_TOKEN=dev-token` for smoke scripts. DB-backed features need `DATABASE_URL` and applied migrations.

Key env families:

- `API_*` / `PUBLIC_BASE_URL`: API bind address and public URL.
- `DATABASE_URL`: PostgreSQL connection string for migrations and DB-backed routes.
- `DISCORD_*`: Discord OAuth and guild-auth policy seed settings.
- `STEAM_*`: Steam OpenID linking settings.
- `SESSION_*`, `CSRF_*`, `CORS_*`: browser session and frontend integration controls.
- `JWT_*`: JWT handoff for external frontends. See [`docs/auth/JWT_AUTH.md`](auth/JWT_AUTH.md).
- `API_TOKEN`, `BOT_API_TOKEN`: machine/bot bearer-token paths.
- `ENABLE_TEST_AUTH`: local smoke-test helper only. Do not expose this in production.

## Local service commands

Install dependencies once:

```bash
corepack enable
pnpm install
```

If Corepack is unavailable:

```bash
npm exec pnpm@10.0.0 -- install
```

Run the API:

```bash
pnpm dev:api
```

Run the admin panel in a second terminal:

```bash
pnpm dev:web
```

The Vite dev server runs at `http://127.0.0.1:5173` and proxies API requests to `http://127.0.0.1:3000` when `VITE_API_BASE_URL` is unset.

## Build and production-like run

```bash
pnpm build
pnpm --filter @arma-attendance/api start
```

`pnpm build` emits:

- `apps/api/dist/index.js`
- `apps/web/dist/`

When `apps/web/dist/` exists, Fastify serves the built admin panel from `/`. API routes under `/v1/*`, `/auth/*`, and `/health*` remain API-only.

## Database migrations

SQL migrations in `sql/migrations/` are authoritative. Applied state is tracked in PostgreSQL through `schema_migrations`, including checksums for applied migration files.

Typical flow:

```bash
pnpm db:status
pnpm db:migrate
pnpm db:status
```

Migration guidelines:

- Add forward-only SQL under `sql/migrations/`.
- Keep migrations tolerant of older manual table shapes when practical.
- Update the matching Drizzle schema mirror in `apps/api/src/db/schema/`.
- Do not use Drizzle Kit to push schema changes to shared or deployed databases.

See [`docs/database/DRIZZLE.md`](database/DRIZZLE.md) for the raw SQL and Drizzle boundary policy.

## First admin setup

Discord OAuth is the primary browser login. Steam is a linked identity and does not grant app permissions by itself.

After the first owner candidate logs in once with Discord, grant owner from the server:

```bash
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

Remove the fallback after recovery when practical. It grants `owner` during Discord login, writes an audit event, and logs a server warning.

## Machine and bot auth

Machine endpoints use bearer auth:

```http
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

Owners can create DB-backed machine tokens from the System page. New tokens can be downloaded as `tcwa3_stats_tracker.toml`, with a token view action available as a fallback. Deleting a token removes the DB-backed token row.

Discord bot-facing endpoints accept `API_TOKEN`; if `BOT_API_TOKEN` is set, they also accept that token:

- `POST /v1/discord/guilds/sync`
- `POST /v1/discord/guilds/:guild_id/member-snapshots`
- `POST /v1/discord/reconcile`
- `GET /v1/discord/guilds/:guild_id/role-actions`
- `POST /v1/discord/guilds/:guild_id/role-action-results`

## Smoke checks

No database required:

```bash
pnpm smoke:local
```

Common DB-backed checks:

```bash
pnpm db:status
pnpm db:migrate
pnpm smoke:db
pnpm smoke:operations
pnpm smoke:attendance
pnpm smoke:scoreboard
pnpm smoke:battalions
pnpm smoke:leaderboard
pnpm smoke:dashboard
pnpm smoke:exports
pnpm smoke:data-quality
pnpm smoke:discord
pnpm smoke:discord-auth-policy
pnpm smoke:auth
pnpm smoke:rbac
```

Focused checks:

| Script | Covers |
|---|---|
| `pnpm smoke:operations` | operation start, idempotent replay, finish, fetch |
| `pnpm smoke:operations:observability` | operation lists, payload rows, ingest request lookups |
| `pnpm smoke:attendance` | normalized attendance and player APIs |
| `pnpm smoke:scoreboard` | split scoreboard stats |
| `pnpm smoke:battalions` | battalion roster, ranks, squads, assignments, unit-admin paths |
| `pnpm smoke:leaderboard` | battalion scoring/ranking |
| `pnpm smoke:cors` | external frontend CORS allowlist |
| `pnpm smoke:base44` | Base44 machine-token read boundaries |
| `pnpm smoke:base44:oauth` | external OAuth/JWT handoff flow |
| `pnpm smoke:csrf` | cookie-session CSRF hardening |
| `pnpm smoke:discord` | Discord guild/role/rule/evaluation/audit flow |
| `pnpm smoke:discord-auth-policy` | Discord auth policy, snapshots, reconciliation |
| `pnpm smoke:auth` | synthetic OAuth, owner grant, Steam link/unlink, logout |
| `pnpm smoke:rbac` | session RBAC, redaction, machine-token boundaries |

Release preflight:

```bash
pnpm release:check
RUN_DB_SMOKE=1 pnpm release:check
```

The default release check runs typecheck, lint, build, and local non-DB smoke. `RUN_DB_SMOKE=1` adds DB-backed smoke coverage.

## Debian LXC deployment notes

The project is designed to run directly on a Debian LXC with Node.js, PostgreSQL access, systemd, and an existing reverse proxy. Docker and Redis are not required.

Recommended minimums:

- 1 CPU core minimum.
- 512 MB RAM minimum, 1 GB recommended.
- 8 GB disk minimum, 16 GB recommended.
- Static IP recommended.

Install host dependencies and Node.js 24, then enable pnpm:

```bash
apt update
apt upgrade -y
apt install -y ca-certificates curl gnupg git build-essential python3 make g++ jq logrotate openssl
curl -fsSL https://deb.nodesource.com/setup_24.x | bash -
apt install -y nodejs
corepack enable
corepack prepare pnpm@latest --activate
```

Create the service user and app directory:

```bash
useradd --system --home /opt/arma-attendance --shell /usr/sbin/nologin arma-attendance
mkdir -p /opt/arma-attendance
chown arma-attendance:arma-attendance /opt/arma-attendance
git clone <repo-url> /opt/arma-attendance
chown -R arma-attendance:arma-attendance /opt/arma-attendance
```

Build and migrate:

```bash
cd /opt/arma-attendance
cp .env.example .env
nano .env
pnpm install --frozen-lockfile
pnpm db:status
pnpm db:migrate
pnpm build
```

Install the systemd unit:

```bash
cp systemd/arma-attendance-api.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now arma-attendance-api
systemctl status arma-attendance-api
journalctl -u arma-attendance-api -f
```

The helper script wraps the normal update/build/restart path:

```bash
bash scripts/deploy-lxc.sh
```

## Reverse proxy

Point the existing HTTPS reverse proxy to:

```text
http://<LXC_STATIC_IP>:3000
```

Forward at least these headers:

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

`Authorization` must be preserved for machine-token requests. Cookie and CSRF headers must be preserved for browser session requests.

## Frontend font assets

The dashboard vendors the AurekFonts `Aurebesh AF` package under `apps/web/public/fonts/aurebesh/`. Aurebesh is decorative only and should not be used as the primary UI/body font.

Refresh the package with:

```bash
pnpm fonts:aurebesh
```

## Related docs

- [`docs/auth/JWT_AUTH.md`](auth/JWT_AUTH.md): JWT handoff for external frontends.
- [`docs/base44/BASE44_AGENT.md`](base44/BASE44_AGENT.md): Base44 integration guide.
- [`docs/database/DRIZZLE.md`](database/DRIZZLE.md): Drizzle/raw-SQL boundary policy.
- [`docs/discord/AUTH_POLICY.md`](discord/AUTH_POLICY.md): Discord guild auth and reconciliation policy.
