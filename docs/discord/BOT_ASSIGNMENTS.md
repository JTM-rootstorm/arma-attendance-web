# Discord Bot Assignments

The Discord bot remains external to this repo. The API stores no Discord bot token and only exposes a bot-safe assignment endpoint for an already authenticated bot or internal API caller.

```http
POST /v1/discord/player-assignments
Authorization: Bearer <BOT_API_TOKEN or bot machine token>
Content-Type: application/json
```

Use `discord_user_id` as the primary bot-facing identifier. `player_uid` is optional and should only be sent when the bot already knows the Arma/Steam player UID.

Required:

- `discord_user_id` or `player_uid`
- `unit_id` or `unit_key`

Common body:

```json
{
  "discord_user_id": "123456789012345678",
  "guild_id": "111111111111111111",
  "role_id": "222222222222222222",
  "unit_key": "tcw",
  "roster_name": "CT-1234 Mike",
  "discord_display_name": "Mike",
  "assignment_priority": 50,
  "create_player_if_missing": true
}
```

Resolution order:

1. Use `player_uid` when supplied.
2. Otherwise resolve `player_discord_links.discord_user_id`.
3. Otherwise create or use `discord:<discord_user_id>`.

The assignment write sets `unit_players.assignment_source = 'discord'`, writes `source_guild_id` and `source_role_id` when supplied, and audits the change in `discord_assignment_audits` with `source = 'bot_assignment'`.

Safety rules:

- `assignment_locked = true` rows return `409 assignment_locked`.
- Other active Discord or auth-default unit rows for the player are marked inactive.
- Manual assignments are not deactivated.
- `arma_server` machine tokens cannot call this endpoint.

Later Discord OAuth login checks `player_discord_links` before falling back to `discord:<discord_user_id>`, so a bot-created assignment and the authenticated user attach to the same player object.
