# JWT Auth For External Frontends

JWT auth is additive. The hosted dashboard can keep using HttpOnly cookie sessions, and machine tokens remain separate for Arma servers, bots, and backend integrations.

External frontends such as Base44 should use backend-owned Discord OAuth:

```text
GET /auth/discord/start?mode=jwt&return_to=<allowed-frontend-url>
Discord redirects to /auth/discord/callback
API verifies Discord profile and guild membership
API reconciles local roles and unit memberships
API redirects to return_to?auth_handoff=<one-time-code>
POST /auth/jwt/exchange
Use Authorization: Bearer <access_jwt>
POST /auth/jwt/refresh when needed
POST /auth/jwt/logout on logout
```

Real access JWTs and refresh tokens are never placed in URLs. The `auth_handoff` value is a short-lived, one-time opaque code stored only as a SHA-256 hash.

Access JWTs are signed with HS256 and contain minimal claims: issuer, audience, subject, token type, issued-at, and expiration. Roles and permissions are not authoritative JWT claims; the API loads roles, identities, unit memberships, and disabled-user state from the database after verification.

Refresh tokens are opaque `aat_refresh_...` values stored as hashes. They rotate on every refresh. Reusing a rotated refresh token revokes the whole token family.

## Endpoints

- `POST /auth/jwt/exchange` with `{ "handoff_code": "..." }`, `{ "auth_handoff": "..." }`, `{ "code": "..." }`, or a query-string alias
- `POST /auth/jwt/refresh` with `{ "refresh_token": "..." }`
- `POST /auth/jwt/logout` with `{ "refresh_token": "..." }`

`/auth/jwt/exchange` returns `invalid_handoff_request` when no supported field is present and `handoff_code_expired_or_consumed` when the one-time handoff is invalid, expired, or already used. The API logs only request shape metadata for bad exchange requests, never the handoff value.

JWT-authenticated unsafe requests use the bearer token and do not need cookie-session CSRF. Cookie-session unsafe requests still require `/auth/csrf`, an allowed `Origin`, and `X-CSRF-Token`.

## Environment

```env
JWT_AUTH_ENABLED=true
JWT_ISSUER=https://arma-stats.root-storm.com
JWT_AUDIENCE=arma-attendance-web
JWT_SECRET=<openssl rand -hex 32>
JWT_ACCESS_TTL_SECONDS=900
JWT_REFRESH_TTL_DAYS=30
JWT_HANDOFF_TTL_SECONDS=120
OAUTH_ALLOWED_RETURN_ORIGINS=https://tcwa3-galaxy-map.base44.app,https://preview-sandbox--6986a916d70fdb8646418766.base44.app
```

When `JWT_AUTH_ENABLED=true` in production, `JWT_SECRET` must be set to a non-placeholder secret at least 32 characters long.
