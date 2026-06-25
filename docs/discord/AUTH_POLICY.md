# Discord Auth Policy

Discord login can be gated by membership in one or more approved guilds. Set `DISCORD_AUTH_ENABLED=true` and point `DISCORD_AUTH_CONFIG_PATH` at a JSON policy file based on `config/discord-guild-auth.example.json`; guilds with `grantsLogin = true` in that file are the login source of truth.

Production should use explicit config only:

```env
DISCORD_AUTH_CONFIG_PATH=/opt/arma-attendance/discord-guild-auth.json
DISCORD_AUTH_ALLOW_FALLBACK_GUILD_IDS=false
DISCORD_AUTH_REQUIRE_CONFIG_FILE=true
```

Fallback guild IDs from `DISCORD_AUTH_DEFAULT_FALLBACK_GUILD_IDS` are used only when `DISCORD_AUTH_REQUIRE_CONFIG_FILE=false` and `DISCORD_AUTH_ALLOW_FALLBACK_GUILD_IDS=true`. If a config file is present but has no login-enabled guilds, production startup/login fails clearly instead of silently expanding to fallback guilds.

Discord display names are also selected from the active login guild policy. Set `displayName.preferGuildNick=true` and use each guild's `displayNamePriority` to prefer one configured guild nickname over another; if no configured guild nickname is available, the API falls back to the global Discord name, username, then Discord ID. This selected name updates auth-managed user/player/link display fields, but manually curated roster names are preserved.

Run `POST /v1/discord/auth-policy/sync` to seed the database from the active file policy for admin views, role mappings, and reconciliation. GET policy reads do not mutate the database, and OAuth login does not merge file policy with DB policy or stale DB rows.

The login OAuth scope is `identify guilds.members.read`. At callback time the API checks each configured login guild sequentially and stores a member-role snapshot for any guild the user belongs to. Short Discord `429` responses are retried once; if Discord still rate-limits the lookup and a recent member snapshot exists, the API uses that cached snapshot and defers live refresh until a later login or sync.

Role mappings are managed through the Discord admin API:

- `GET /v1/discord/auth-policy`
- `POST /v1/discord/auth-policy/sync`
- `PUT /v1/discord/guilds/:guild_id/auth-policy`
- `GET /v1/discord/guilds/:guild_id/role-mappings`
- `POST /v1/discord/guilds/:guild_id/role-mappings`
- `PATCH /v1/discord/guilds/:guild_id/role-mappings/:mapping_id`
- `DELETE /v1/discord/guilds/:guild_id/role-mappings/:mapping_id`
- `POST /v1/discord/guilds/:guild_id/member-snapshots`
- `POST /v1/discord/player-assignments`
- `POST /v1/discord/reconcile`
- `GET /v1/discord/assignment-audits`

Partner guild unit and rank mappings should use higher unit/rank priorities than the TCWA3 fallback guild. Manual roster assignments with `assignment_locked=true` are preserved by reconciliation.

Bot assignment writes are documented in [`BOT_ASSIGNMENTS.md`](BOT_ASSIGNMENTS.md). Member snapshot reconciliation can now resolve Discord IDs through `player_discord_links` before the user has logged in, falling back to the same deterministic `discord:<discord_user_id>` player UID used by Discord-only auth.
