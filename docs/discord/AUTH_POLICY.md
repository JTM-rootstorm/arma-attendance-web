# Discord Auth Policy

Discord login can be gated by membership in one or more approved guilds. Set `DISCORD_AUTH_ENABLED=true` and manage runtime policy in `discord_guilds`; rows with `grants_login = true` are the login source of truth.

`DISCORD_AUTH_CONFIG_PATH` can point at a JSON seed file based on `config/discord-guild-auth.example.json`. Run `POST /v1/discord/auth-policy/sync` to seed the database from that file. GET policy reads do not mutate the database, and OAuth login does not merge file policy with DB policy.

The login OAuth scope is `identify guilds.members.read`. At callback time the API checks each DB guild with `grants_login = true` sequentially and stores a member-role snapshot for any guild the user belongs to. Short Discord `429` responses are retried once; if Discord still rate-limits the lookup and a recent member snapshot exists, the API uses that cached snapshot and defers live refresh until a later login or sync.

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
