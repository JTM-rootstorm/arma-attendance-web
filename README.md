# Arma Attendance Web

Web/API service for the Arma 3 Attendance Tracker. It ingests operation payloads, normalizes attendance and player stats, serves an internal admin panel, and supports Discord/Steam identity workflows.

## Quick start: backend API and admin panel

Prerequisites:

- Node.js 24+
- pnpm 10+
- PostgreSQL for DB-backed features. The non-DB local smoke test works without it.

```bash
corepack enable
pnpm install
cp .env.local.example .env
pnpm dev:api
```

In a second terminal, run the admin panel:

```bash
pnpm dev:web
```

Default local URLs:

- API: `http://127.0.0.1:3000`
- Admin panel: `http://127.0.0.1:5173`

The Vite dev server proxies `/health`, `/auth/*`, and `/v1/*` to the local API when `VITE_API_BASE_URL` is unset. Leave it unset for normal local development.

Run the basic local smoke check:

```bash
pnpm smoke:local
```

`pnpm smoke:local` does not require PostgreSQL. DB-backed smoke scripts require `DATABASE_URL`, applied migrations, and a running API.

## Build and run

```bash
pnpm build
pnpm --filter @arma-attendance/api start
```

`pnpm build` produces:

- `apps/api/dist/index.js`
- `apps/web/dist/`

When `apps/web/dist/` exists, Fastify serves the built admin panel from `/`. API routes under `/v1/*`, `/auth/*`, and `/health*` remain API-only.

## Database setup

For real auth, ingest, dashboard, Discord, and admin workflows, configure `DATABASE_URL` in `.env`, then run:

```bash
pnpm db:status
pnpm db:migrate
```

SQL migrations in `sql/migrations/` are authoritative. Drizzle mirrors the schema for typed query paths, but Drizzle is not the migration owner.

See [`docs/OPERATIONS.md`](docs/OPERATIONS.md) and [`docs/database/DRIZZLE.md`](docs/database/DRIZZLE.md) for migration and DB workflow details.

## First owner setup

Discord OAuth is the primary browser login. Have the first owner candidate log in once, then grant ownership from the server:

```bash
pnpm admin:grant -- --provider discord --provider-user-id <discord_user_id> --role owner
pnpm admin:list
```

If the local app user UUID is known:

```bash
pnpm admin:grant -- --user-id <uuid> --role owner
```

Use `INITIAL_ADMIN_DISCORD_IDS` only as an emergency recovery fallback, and remove it after recovery.

## Common commands

| Task | Command |
|---|---|
| Install dependencies | `pnpm install` |
| Run API in dev mode | `pnpm dev:api` |
| Run admin panel in dev mode | `pnpm dev:web` |
| Build API and web | `pnpm build` |
| Typecheck all packages | `pnpm typecheck` |
| Check DB migration status | `pnpm db:status` |
| Apply DB migrations | `pnpm db:migrate` |
| Local non-DB smoke | `pnpm smoke:local` |
| DB smoke | `pnpm smoke:db` |
| Auth/RBAC smoke | `pnpm smoke:auth && pnpm smoke:rbac` |
| Discord smoke | `pnpm smoke:discord && pnpm smoke:discord-auth-policy` |
| Release preflight | `pnpm release:check` |
| Release preflight with DB smoke | `RUN_DB_SMOKE=1 pnpm release:check` |

## Project layout

```text
apps/api/          Fastify API, auth, routes, DB schema mirrors
apps/web/          Vite + React admin panel
config/            Example seed config, including Discord auth policy
docs/              Longer guides moved out of the root README
scripts/           Smoke tests, deploy helpers, admin helpers
sql/migrations/    Authoritative database migrations
systemd/           Production service unit
```

## Auth and access model

- Browser/admin workflows use Discord OAuth and an HttpOnly session cookie.
- Steam OpenID is a linked identity, not a permission source by itself.
- External frontends can use backend-owned Discord OAuth with JWT handoff mode, and should use `POST /auth/steam/link-ticket` before redirecting JWT users to Steam linking.
- Arma ingest, smoke scripts, and bot automation use machine/bearer-token auth.
- Sensitive IDs are redacted unless the caller has the right app or unit-scoped role.

See:

- [`docs/auth/JWT_AUTH.md`](docs/auth/JWT_AUTH.md)
- [`docs/base44/BASE44_AGENT.md`](docs/base44/BASE44_AGENT.md)

## Discord integration

Discord support covers guild/role snapshots, attendance-based role action evaluation, auth guild policy, role mappings, member snapshots, and reconciliation into app/unit roles and roster assignments.

The API does not run a Discord client process or store a Discord bot token. A separate bot can call the bot-facing endpoints with `API_TOKEN` or `BOT_API_TOKEN`.

See [`docs/discord/AUTH_POLICY.md`](docs/discord/AUTH_POLICY.md) and [`docs/discord/BOT_ASSIGNMENTS.md`](docs/discord/BOT_ASSIGNMENTS.md).

## API surface

The full endpoint list belongs in [`docs/API.md`](docs/API.md). The main groups are:

- health and debug checks
- Discord/Steam auth and current-user endpoints
- operation ingest and observability
- attendance, player, dashboard, export, and data-quality reads
- battalion/unit roster, rank, squad, and admin management
- Discord guild/role/rule/auth-policy/reconciliation endpoints
- owner/system machine-token management

Machine-token requests use:

```http
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

Browser session requests use the login cookie. Unsafe session-authenticated requests also need CSRF protection when enabled.

## Deployment

The app is designed to run directly on a Debian LXC with Node.js, PostgreSQL access, systemd, and an existing HTTPS reverse proxy. Docker and Redis are not required.

Short version:

```bash
pnpm install --frozen-lockfile
pnpm db:status
pnpm db:migrate
pnpm build
systemctl restart arma-attendance-api
```

More detail lives in [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

## More docs

- [`docs/OPERATIONS.md`](docs/OPERATIONS.md): env, migrations, smoke checks, deployment, reverse proxy, font assets.
- [`docs/API.md`](docs/API.md): endpoint index and request conventions.
- [`docs/database/DRIZZLE.md`](docs/database/DRIZZLE.md): Drizzle/raw-SQL boundary.
- [`docs/discord/AUTH_POLICY.md`](docs/discord/AUTH_POLICY.md): Discord auth policy and reconciliation.
- [`docs/discord/BOT_ASSIGNMENTS.md`](docs/discord/BOT_ASSIGNMENTS.md): Discord bot assignment write contract.
- [`docs/auth/JWT_AUTH.md`](docs/auth/JWT_AUTH.md): JWT handoff for external frontends.
- [`docs/base44/BASE44_AGENT.md`](docs/base44/BASE44_AGENT.md): Base44 integration guidance.
