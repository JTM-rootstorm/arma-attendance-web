# API Endpoint Index

This is an endpoint map, not a full OpenAPI contract. Keep examples and long workflow notes out of the root README.

## Request conventions

Machine-token requests:

```http
Authorization: Bearer <API_TOKEN>
Content-Type: application/json
```

Browser requests use the session cookie created by Discord OAuth login. Unsafe session-authenticated requests need CSRF protection when `CSRF_ENABLED=true`.

Standard error shape:

```json
{
  "ok": false,
  "error": {
    "code": "string_code",
    "message": "Human-readable message."
  }
}
```

## Health and debug

```http
GET  /health
GET  /health/db
GET  /
POST /v1/debug/poke
```

`GET /health` is unauthenticated. `GET /health/db` requires owner/session or machine-token auth.

## Dashboard, data quality, and exports

```http
GET  /v1/dashboard/summary
GET  /v1/data-quality
GET  /v1/operations/:operation_id/attendance.csv
GET  /v1/players.csv
```

## Operations and ingest

```http
GET  /v1/operations
POST /v1/operations/start
POST /v1/operations/:operation_id/finish
GET  /v1/operations/:operation_id
GET  /v1/operations/:operation_id/attendance
GET  /v1/operations/:operation_id/payloads
GET  /v1/operations/:operation_id/summary
GET  /v1/ingest-requests/:request_id
```

Operation ingest requests require `request_id` and `server_key`. Extra payload fields are stored as raw JSON. Reusing the same `request_id` returns the saved response with `idempotent: true`.

## Players

```http
GET  /v1/players
GET  /v1/players/:player_uid
GET  /v1/players/:player_uid/summary
```

## Battalions / units

```http
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
GET  /public/leaderboard/units
GET  /public/leaderboard/players
```

## Public leaderboards

```http
GET /public/leaderboard/units
GET /public/leaderboard/players
```

`GET /public/leaderboard/players` returns the public top-20 player leaderboard. It is unauthenticated and redacts internal player identifiers. Rows are ranked by total kills: infantry + soft vehicle + armor + air kills. Public leaderboard responses may be cached for 60 seconds.

## Auth and current user

```http
GET  /auth/discord/start
GET  /auth/discord/callback
POST /auth/logout
GET  /auth/csrf
GET  /auth/steam/start
POST /auth/steam/link-ticket
GET  /auth/steam/start-ticket
GET  /auth/steam/callback
POST /auth/jwt/exchange
POST /auth/jwt/refresh
POST /auth/jwt/logout
GET  /v1/me
GET  /v1/me/player
GET  /v1/me/operations
GET  /v1/me/operations/:operation_id
DELETE /v1/me/identities/steam
```

See [`docs/auth/JWT_AUTH.md`](auth/JWT_AUTH.md) for JWT handoff details.

## Admin and system

```http
GET  /v1/admin/users
GET  /v1/admin/users/:user_id
PUT  /v1/admin/users/:user_id/roles/:role
DELETE /v1/admin/users/:user_id/roles/:role
POST /v1/admin/users/:user_id/disable
POST /v1/admin/users/:user_id/enable
GET  /v1/system/machine-tokens
POST /v1/system/machine-tokens
POST /v1/system/machine-tokens/:token_id/secret
DELETE /v1/system/machine-tokens/:token_id
GET  /v1/system/xp-reward-tiers
POST /v1/system/xp-reward-tiers
PATCH /v1/system/xp-reward-tiers/:tier_id
DELETE /v1/system/xp-reward-tiers/:tier_id
```

XP reward tier endpoints are owner-only configuration endpoints. They allow creating, editing, listing, and deleting mission-name-match to XP-amount rows. They do not award XP yet.

## Discord

```http
POST /v1/discord/guilds/sync
GET  /v1/discord/auth-policy
POST /v1/discord/auth-policy/sync
GET  /v1/discord/guilds
GET  /v1/discord/guilds/:guild_id
PUT  /v1/discord/guilds/:guild_id/auth-policy
GET  /v1/discord/guilds/:guild_id/roles
POST /v1/discord/guilds/:guild_id/roles
DELETE /v1/discord/guilds/:guild_id/roles/:role_id
GET  /v1/discord/guilds/:guild_id/member-snapshots
POST /v1/discord/guilds/:guild_id/member-snapshots
GET  /v1/discord/guilds/:guild_id/role-mappings
POST /v1/discord/guilds/:guild_id/role-mappings
PATCH /v1/discord/guilds/:guild_id/role-mappings/:mapping_id
DELETE /v1/discord/guilds/:guild_id/role-mappings/:mapping_id
GET  /v1/discord/player-links
POST /v1/discord/player-links
POST /v1/discord/player-assignments
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

`POST /v1/discord/player-assignments` is the Discord-bot write path for unit assignment. It accepts `discord_user_id` as the preferred identifier, `player_uid` as an optional override, and `unit_id` or `unit_key` as the target unit. Bot-created placeholder players use `player_uid = discord:<discord_user_id>` and are linked through `player_discord_links` so later Discord OAuth login attaches to the same player object. The endpoint accepts `api` and `bot` machine tokens, not `arma_server` ingest tokens.

Machine tokens created through `POST /v1/system/machine-tokens` may include optional `scopes`. When omitted, the API assigns defaults for the token kind. Bot tokens default to Discord guild/member sync, assignment writes, and role-action reporting scopes.

See [`docs/discord/AUTH_POLICY.md`](discord/AUTH_POLICY.md) for auth policy and reconciliation notes. See [`docs/discord/BOT_ASSIGNMENTS.md`](discord/BOT_ASSIGNMENTS.md) for the bot assignment contract.
