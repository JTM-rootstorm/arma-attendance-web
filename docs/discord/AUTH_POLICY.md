# Discord Auth Policy

Discord login can be gated by membership in one or more configured guilds. Set `DISCORD_AUTH_ENABLED=true` and point `DISCORD_AUTH_CONFIG_PATH` at a JSON policy file based on `config/discord-guild-auth.example.json`.

The login OAuth scope is `identify guilds.members.read`. At callback time the API checks each configured `grantsLogin` guild and stores a member-role snapshot for any guild the user belongs to.

Role mappings are managed through the Discord admin API:

- `GET /v1/discord/auth-policy`
- `PUT /v1/discord/guilds/:guild_id/auth-policy`
- `GET /v1/discord/guilds/:guild_id/role-mappings`
- `POST /v1/discord/guilds/:guild_id/role-mappings`
- `PATCH /v1/discord/guilds/:guild_id/role-mappings/:mapping_id`
- `DELETE /v1/discord/guilds/:guild_id/role-mappings/:mapping_id`
- `POST /v1/discord/guilds/:guild_id/member-snapshots`
- `POST /v1/discord/reconcile`
- `GET /v1/discord/assignment-audits`

Partner guild unit and rank mappings should use higher unit/rank priorities than the TCWA3 fallback guild. Manual roster assignments with `assignment_locked=true` are preserved by reconciliation.
