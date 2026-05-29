# Base44 Agent Guide

Base44 is a frontend for Arma Attendance. The Arma Attendance API remains the source of truth for login, sessions, roles, permissions, and redaction.

Do not store API keys, bearer tokens, machine tokens, Discord bot tokens, or production secrets in Base44 client-side code. User-facing Base44 screens should use public aggregate endpoints when that data is enough, and must authenticate humans through the API's Discord OAuth flow before showing personalized, role-gated, or writable data.

## Login Flow

Send users to the API Discord login start route with an allowlisted absolute return URL:

```text
https://arma-stats.root-storm.com/auth/discord/start?return_to=https%3A%2F%2Ftcwa3-galaxy-map.base44.app%2F
```

The Discord Developer Portal redirect URI remains on the API domain:

```text
https://arma-stats.root-storm.com/auth/discord/callback
```

After Discord login, the API sets an HttpOnly session cookie and redirects back to the `return_to` URL if its origin is allowlisted.

Steam linking uses the same pattern for logged-in users:

```text
https://arma-stats.root-storm.com/auth/steam/start?return_to=https%3A%2F%2Ftcwa3-galaxy-map.base44.app%2F
```

## Fetch Pattern

All authenticated Base44 API requests must include browser credentials:

```js
const response = await fetch("https://arma-stats.root-storm.com/v1/me", {
  credentials: "include"
});
```

Use `/v1/me` to drive UI permissions. Do not assume a visible button means the API will allow the action; the API enforces RBAC on every request.

## Public Aggregate Reads

Base44 may call these API endpoints without login or API keys:

- `GET /v1/operations`
- `GET /v1/leaderboard/units`

Use unauthenticated `GET /v1/operations` for a recent public operations feed. Anonymous responses are capped to the most recent 20 operations, force `offset=0`, ignore sensitive filters such as `server_key` and `mission_uid`, and redact internal IDs, server keys, mission UIDs, unit IDs, and payload counts.

Example:

```js
const response = await fetch("https://arma-stats.root-storm.com/v1/operations?limit=20");
const data = await response.json();
```

Use unauthenticated `GET /v1/leaderboard/units` for public battalion leaderboard cards or tables. Anonymous responses keep aggregate stats and battalion display names, but redact internal `unit_id` and `unit_key` values.

Example:

```js
const response = await fetch("https://arma-stats.root-storm.com/v1/leaderboard/units?limit=20");
const data = await response.json();
```

Do not build public drilldown links from anonymous operation rows because operation IDs are intentionally hidden. Ask the user to log in before opening operation details, player details, battalion roster details, or any personal view.

## CSRF For Writes

Before unsafe session-authenticated requests, fetch a CSRF token:

```js
const csrfResponse = await fetch("https://arma-stats.root-storm.com/auth/csrf", {
  credentials: "include"
});
const csrf = await csrfResponse.json();
```

Then send it as `X-CSRF-Token` on `POST`, `PUT`, `PATCH`, and `DELETE` requests:

```js
await fetch("https://arma-stats.root-storm.com/v1/me/player", {
  method: "PATCH",
  credentials: "include",
  headers: {
    "Content-Type": "application/json",
    "X-CSRF-Token": csrf.csrf_token
  },
  body: JSON.stringify({ display_name: "New Callsign" })
});
```

The browser must also send an allowed `Origin` header. Normal browser `fetch` calls do this.

## Endpoint Summary

Public:

- `GET /health`
- `GET /v1/operations`
- `GET /v1/leaderboard/units`
- `GET /auth/discord/start?return_to=...`
- `GET /auth/discord/callback`
- `GET /auth/steam/start?return_to=...`
- `GET /auth/steam/callback`

Session user:

- `GET /v1/me`
- `GET /v1/me/player`
- `PATCH /v1/me/player`
- `GET /v1/me/operations`
- `GET /v1/me/operations/:operation_id`
- `GET /v1/me/operation-mates?operation_id=...`
- `DELETE /v1/me/identities/steam`

Role-gated reads:

- `GET /v1/dashboard/summary`
- `GET /v1/units`
- `GET /v1/units/:unit_id/roster`
- `GET /v1/operations/:operation_id`
- `GET /v1/operations/:operation_id/summary`
- `GET /v1/operations/:operation_id/attendance`
- `GET /v1/players`
- `GET /v1/players/:player_uid`
- `GET /v1/players/:player_uid/summary`

Role-gated writes require session, role permission, and CSRF:

- `POST /v1/units`
- `PATCH /v1/units/:unit_id`
- `DELETE /v1/units/:unit_id`
- `POST /v1/units/:unit_id/players`
- `PATCH /v1/units/:unit_id/players/:player_uid`
- `DELETE /v1/units/:unit_id/players/:player_uid`
- `PATCH /v1/units/:unit_id/squad-layout`

Owner-only machine token endpoints:

- `GET /v1/system/machine-tokens`
- `POST /v1/system/machine-tokens`
- `DELETE /v1/system/machine-tokens/:token_id`

Sensitive identifiers and fields may be `null` or redacted depending on the current user's roles. Build UI states that tolerate missing IDs and hidden operational detail.
