# AGENTS.md

## Project

`arma-attendance-web` is the web/API service for an Arma 3 Attendance Tracker.

The long-term product will support Arma operation attendance tracking, player stat uploads, leader/admin views, interactive dashboards, animated UI elements, and eventually authenticated user-facing pages.

Phase 0 is intentionally smaller: prove that the Arma extension can poke the API and receive JSON.

## Branching and repository rules

- The `main` branch is protected.
- Do not work directly on `main`.
- Create a feature branch before making changes:
  - Recommended: `codex/phase-0-web-skeleton`
- Create feature branches named like `codex/<short-task-name>` when the local ref layout allows it.
- Do not force-push protected branches.
- Prefer small, reviewable PRs.
- Do not commit generated dependency folders such as `node_modules/`.
- Do not commit built output unless a future plan explicitly asks for release artifacts.
- Do not commit real secrets or production `.env` files.
- Keep `implementation-notes/` and `plans/` as untracked planning artifacts unless explicitly instructed otherwise.
- Move finished plans into `plans/archived/` so active plans stay easy to find.
- You may use any `git` or `gh` commands required to support implementation of the active plan.

## Preferred stack

Use this stack unless an existing repo structure clearly requires a small adjustment:

- Node.js 24 LTS
- pnpm workspaces
- TypeScript
- Fastify for the API
- Zod for request/config validation
- Pino/Fastify logging
- Vite + React + TypeScript for the placeholder web shell
- systemd for production service management on Debian 13 LXC
- Existing reverse proxy handles HTTPS/TLS

## Phase 0 scope

Implement only the smoke-test skeleton.

Required endpoints:

```http
GET  /health
GET  /
POST /v1/debug/poke
```

Rules:

- `GET /health` is unauthenticated.
- `GET /` may return the web shell or a minimal HTML response depending on final skeleton shape.
- `POST /v1/debug/poke` requires Bearer token auth.
- `/v1/debug/poke` accepts JSON with:
  - `message?: string`
  - `server_key?: string`
- `/v1/debug/poke` returns compact JSON with `ok: true` when authorized.

Required error shape:

```json
{
  "ok": false,
  "error": {
    "code": "string_code",
    "message": "Human-readable message."
  }
}
```

Do not implement database-backed attendance or stats in Phase 0.

## Environment files

Commit:

- `.env.example`
- `.env.local.example`

Do not commit:

- `.env`
- `.env.local`
- `.env.production`
- any file containing real tokens/passwords

Required environment variables:

```env
NODE_ENV=production
APP_NAME=arma-attendance
APP_VERSION=0.1.0
HOST=0.0.0.0
PORT=3000
PUBLIC_BASE_URL=https://arma-stats.example.com
API_TOKEN=change-this-token
LOG_LEVEL=info
DATABASE_URL=postgres://arma_attendance:change-me@localhost:5432/arma_attendance
```

`DATABASE_URL` may be present but unused in Phase 0.

Config loading must validate required values and fail fast with a clear error when production secrets are missing or unsafe.

Root `.env` is the canonical production env location on the Debian LXC. The API must be able to load root `.env` whether it starts from the repo root, `apps/api`, a pnpm filter command, or built output under `apps/api/dist`.

Do not require `apps/api/.env` for normal operation.

## Security rules

- Never log `API_TOKEN`.
- Never log `DATABASE_URL`.
- Never echo the Authorization header.
- `/health` must not expose secrets.
- `/v1/debug/poke` may echo sanitized request body fields, but not headers.
- Do not enable permissive CORS unless a plan specifically requires it.
- Bind to `0.0.0.0` in production so the reverse proxy/LXC network can reach the service.
- Bind to `127.0.0.1` for local development examples.

## Scripts

Root package scripts should include:

```json
{
  "scripts": {
    "dev": "pnpm --filter @arma-attendance/api dev",
    "dev:api": "pnpm --filter @arma-attendance/api dev",
    "dev:web": "pnpm --filter @arma-attendance/web dev",
    "build": "pnpm -r build",
    "typecheck": "pnpm -r typecheck",
    "lint": "pnpm -r lint",
    "smoke:local": "bash scripts/dev-smoke.sh"
  }
}
```

If lint tooling is not added in Phase 0, either add a minimal ESLint setup or make the lint script a harmless placeholder that explains lint is not configured yet. Prefer adding ESLint if it does not create unnecessary bloat.

## Deployment model

The dev machine and production runtime are different machines.

Expected workflow:

```text
Dev machine with Codex
  -> branch from main
  -> implement
  -> build/test/smoke locally
  -> push branch
  -> PR

Debian 13 LXC
  -> git pull approved source
  -> pnpm install --frozen-lockfile
  -> pnpm build
  -> systemd restart
```

Do not assume the LXC has Codex.

Do not require Docker.

## Production service

The systemd unit must run built output, not a dev server.

Expected command:

```bash
/usr/bin/node apps/api/dist/index.js
```

The service should use:

```ini
EnvironmentFile=/opt/arma-attendance/.env
WorkingDirectory=/opt/arma-attendance
```

## Validation

Before considering Phase 0 complete, run or document:

```bash
pnpm install
pnpm build
pnpm typecheck
pnpm smoke:local
```

Manual API checks:

```bash
curl http://127.0.0.1:3000/health
curl -X POST http://127.0.0.1:3000/v1/debug/poke \
  -H "Authorization: Bearer dev-token" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello from smoke test","server_key":"dev-smoke"}'
```

## Style

Keep the implementation boring, explicit, and easy to deploy.

Small, clean files are preferred over clever abstractions.

Names should make sense to someone maintaining this during an Arma op night while mildly sleep-deprived.
