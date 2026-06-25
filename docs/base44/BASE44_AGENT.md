# Base44 Agent Guide

Base44 is a frontend for Arma Attendance. The Arma Attendance API remains the source of truth for login, sessions, roles, permissions, and redaction.

Do not store API keys, bearer tokens, machine tokens, Discord bot tokens, or production secrets in Base44 client-side code. User-facing Base44 screens should use public aggregate endpoints when that data is enough, and must authenticate humans through the API's Discord OAuth flow before showing personalized, role-gated, or writable data.

## Login Flow

For Base44 and other external frontends, prefer JWT handoff mode so the UI does not depend on third-party cookies. Send users to the API Discord login start route with `mode=jwt` and an allowlisted absolute return URL:

```text
https://arma-stats.root-storm.com/auth/discord/start?mode=jwt&return_to=https%3A%2F%2Ftcwa3-galaxy-map.base44.app%2F
```

The Discord Developer Portal redirect URI remains on the API domain:

```text
https://arma-stats.root-storm.com/auth/discord/callback
```

After Discord login, the API verifies the Discord profile and guild membership, reconciles local roles and unit membership, creates a short-lived one-time handoff code, and redirects back to the `return_to` URL if its origin is allowlisted:

```text
https://tcwa3-galaxy-map.base44.app/?auth_handoff=<code>
```

Do not expect or accept real access tokens, refresh tokens, JWTs, API keys, role payloads, or Discord IDs in the URL.

Exchange the handoff code for app tokens:

```js
const response = await fetch("https://arma-stats.root-storm.com/auth/jwt/exchange", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ handoff_code: authHandoff })
});
const data = await response.json();
```

Use the returned access token for API calls:

```js
const response = await fetch("https://arma-stats.root-storm.com/v1/me", {
  headers: {
    Authorization: `Bearer ${accessToken}`
  }
});
```

Use `POST /auth/jwt/refresh` with the opaque refresh token when the access token expires, and `POST /auth/jwt/logout` to revoke the refresh token on logout. Store tokens only in frontend storage appropriate for the Base44 app's risk model; do not put them in URLs.

Cookie session mode is still available for the hosted dashboard and same-site browser flows:

```text
https://arma-stats.root-storm.com/auth/discord/start?return_to=https%3A%2F%2Ftcwa3-galaxy-map.base44.app%2F
```

In cookie mode, the API sets an HttpOnly session cookie and redirects back to the `return_to` URL if its origin is allowlisted.

Steam linking with cookie sessions can use the browser redirect start route:

```text
https://arma-stats.root-storm.com/auth/steam/start?return_to=https%3A%2F%2Ftcwa3-galaxy-map.base44.app%2F
```

JWT-authenticated Base44 users cannot navigate directly to `/auth/steam/start` because browser redirects cannot attach the `Authorization` header. Instead, request a short-lived Steam link ticket, then redirect the browser to the returned URL:

```js
const response = await fetch("https://arma-stats.root-storm.com/auth/steam/link-ticket", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`
  },
  body: JSON.stringify({
    return_to: "https://tcwa3-galaxy-map.base44.app/ArmaStats"
  })
});
const data = await response.json();
window.location.assign(data.steam_start_url);
```

After Steam returns to Base44, the URL may include `steam_linked=1`. It is only a hint; it contains no token or SteamID. Re-fetch `/v1/me` and `/v1/me/player` with the existing bearer access token to refresh linked identity and player state.

## Fetch Pattern

JWT-authenticated Base44 API requests use bearer tokens:

```js
const response = await fetch("https://arma-stats.root-storm.com/v1/me", {
  headers: {
    Authorization: `Bearer ${accessToken}`
  }
});
```

Cookie-session requests must include browser credentials:

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

JWT-authenticated unsafe requests do not need cookie-session CSRF. Before unsafe cookie-session requests, fetch a CSRF token:

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
- `GET /auth/steam/start-ticket?ticket=...`
- `GET /auth/steam/callback`
- `POST /auth/jwt/exchange`
- `POST /auth/jwt/refresh`
- `POST /auth/jwt/logout`

Session user:

- `GET /v1/me`
- `POST /auth/steam/link-ticket`
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
- `POST /v1/system/machine-tokens/:token_id/secret`
- `DELETE /v1/system/machine-tokens/:token_id`

Sensitive identifiers and fields may be `null` or redacted depending on the current user's roles. Build UI states that tolerate missing IDs and hidden operational detail.
