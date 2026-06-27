#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
STAMP="$(date +%Y%m%d%H%M%S)"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

BOT_TOKEN="${BOT_API_TOKEN:-${API_TOKEN:-dev-token}}"

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[smoke:bot-player-stats] DATABASE_URL is required." >&2
  exit 1
fi

if [[ -z "$BOT_TOKEN" ]]; then
  echo "[smoke:bot-player-stats] BOT_API_TOKEN or API_TOKEN is required." >&2
  exit 1
fi

player_uid="7656119${STAMP}42"
discord_user_id="880${STAMP}42"
unit_key="bot-player-stats-unit-$STAMP"
finished_mission_uid="bot-player-stats-finished-$STAMP"
unfinished_mission_uid="bot-player-stats-started-$STAMP"

assert_json() {
  local expression="$1"

  node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const ok = Function("data", `return (${process.argv[1]});`)(data);
if (!ok) {
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}
' "$expression"
}

echo "[smoke:bot-player-stats] Seeding player, Discord link, and operations..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v player_uid="$player_uid" \
  -v discord_user_id="$discord_user_id" \
  -v unit_key="$unit_key" \
  -v finished_mission_uid="$finished_mission_uid" \
  -v unfinished_mission_uid="$unfinished_mission_uid" <<'SQL'
WITH player_seed AS (
  INSERT INTO players (player_uid, last_name, raw_last_player)
  VALUES (:'player_uid', 'Bot Stats Smoke', '{"source":"bot_player_stats_smoke"}'::jsonb)
  ON CONFLICT (player_uid) DO UPDATE
  SET last_name = EXCLUDED.last_name,
      deleted_at = NULL,
      updated_at = now()
  RETURNING player_uid
),
discord_link_seed AS (
  INSERT INTO player_discord_links (
    player_uid,
    discord_user_id,
    discord_username,
    discord_display_name,
    source,
    verified_at,
    raw_link
  )
  SELECT
    player_seed.player_uid,
    :'discord_user_id',
    'bot-stats-smoke',
    'Bot Stats Smoke',
    'bot',
    now(),
    '{"source":"bot_player_stats_smoke"}'::jsonb
  FROM player_seed
  ON CONFLICT (discord_user_id) DO UPDATE
  SET player_uid = EXCLUDED.player_uid,
      discord_username = EXCLUDED.discord_username,
      discord_display_name = EXCLUDED.discord_display_name,
      source = EXCLUDED.source,
      verified_at = EXCLUDED.verified_at,
      raw_link = EXCLUDED.raw_link,
      updated_at = now()
),
unit_seed AS (
  INSERT INTO units (unit_key, slug, name, display_name, callsign, sort_order)
  VALUES (:'unit_key', :'unit_key', 'Bot Player Stats Battalion', 'Bot Player Stats Battalion', 'BotStats', 10)
  ON CONFLICT (unit_key) DO UPDATE
  SET slug = EXCLUDED.slug,
      name = EXCLUDED.name,
      display_name = EXCLUDED.display_name,
      callsign = EXCLUDED.callsign,
      is_active = true,
      deleted_at = NULL,
      updated_at = now()
  RETURNING id
),
rank_seed AS (
  INSERT INTO unit_ranks (unit_id, rank_key, name, short_name, sort_order, is_active)
  SELECT unit_seed.id, 'arc-trooper', 'ARC Trooper', 'ARC', 25, true
  FROM unit_seed
  ON CONFLICT (unit_id, rank_key) DO UPDATE
  SET name = EXCLUDED.name,
      short_name = EXCLUDED.short_name,
      sort_order = EXCLUDED.sort_order,
      is_active = true,
      updated_at = now()
  RETURNING id, unit_id
),
unit_player_seed AS (
  INSERT INTO unit_players (
    unit_id,
    player_uid,
    rank,
    rank_id,
    roster_name,
    roster_status,
    assignment_source,
    source_guild_id,
    source_role_id,
    is_active
  )
  SELECT
    rank_seed.unit_id,
    :'player_uid',
    'ARC',
    rank_seed.id,
    'Bot Roster Display',
    'active',
    'discord',
    'bot-player-stats-guild',
    'bot-player-stats-role',
    true
  FROM rank_seed
  ON CONFLICT (unit_id, player_uid) DO UPDATE
  SET rank = EXCLUDED.rank,
      rank_id = EXCLUDED.rank_id,
      roster_name = EXCLUDED.roster_name,
      roster_status = EXCLUDED.roster_status,
      assignment_source = EXCLUDED.assignment_source,
      source_guild_id = EXCLUDED.source_guild_id,
      source_role_id = EXCLUDED.source_role_id,
      is_active = true,
      updated_at = now()
),
represented_unit_seed AS (
  INSERT INTO player_unit_preferences (player_uid, represented_unit_id)
  SELECT :'player_uid', unit_seed.id
  FROM unit_seed
  ON CONFLICT (player_uid) DO UPDATE
  SET represented_unit_id = EXCLUDED.represented_unit_id,
      updated_at = now()
),
finished_operation AS (
  INSERT INTO operations (server_key, status, mission_uid, mission_name, world_name, started_at, ended_at)
  VALUES ('bot-player-stats-smoke', 'finished', :'finished_mission_uid', 'Bot Player Stats Finished', 'VR', now() - interval '2 hours', now() - interval '1 hour')
  RETURNING id
),
unfinished_operation AS (
  INSERT INTO operations (server_key, status, mission_uid, mission_name, world_name, started_at)
  VALUES ('bot-player-stats-smoke', 'started', :'unfinished_mission_uid', 'Bot Player Stats Started', 'VR', now())
  RETURNING id
),
operation_player_seed AS (
  INSERT INTO operation_players (operation_id, player_uid, name_at_start, name_at_end, present_at_start, present_at_end)
  SELECT finished_operation.id, :'player_uid', 'Bot Stats Smoke', 'Bot Stats Smoke', true, true FROM finished_operation
  UNION ALL SELECT unfinished_operation.id, :'player_uid', 'Bot Stats Smoke', NULL, true, false FROM unfinished_operation
  RETURNING operation_id, player_uid
)
INSERT INTO operation_player_stats (
  operation_id,
  player_uid,
  infantry_kills,
  vehicle_kills,
  player_kills,
  ai_kills,
  deaths,
  soft_vehicle_kills,
  armor_kills,
  air_kills,
  ground_vehicle_kills,
  all_vehicle_kills,
  scoreboard_score
)
SELECT finished_operation.id, :'player_uid', 7, 2, 0, 7, 1, 1, 1, 0, 2, 2, 70 FROM finished_operation
UNION ALL SELECT unfinished_operation.id, :'player_uid', 900, 900, 0, 900, 90, 900, 900, 900, 2700, 2700, 9000 FROM unfinished_operation;
SQL

echo "[smoke:bot-player-stats] Checking Steam lookup..."
curl -fsS "$BASE_URL/v1/bot/player-stats?steam_id=$player_uid" \
  -H "Authorization: Bearer $BOT_TOKEN" |
  assert_json "
    data.ok === true
    && data.lookup.resolved_player_uid === '$player_uid'
    && data.player.display_name === 'Bot Roster Display'
    && data.player.rank === 'ARC Trooper'
    && data.player.represented_unit_id !== null
    && data.player.discord_links.some((link) => link.discord_user_id === '$discord_user_id')
    && data.battalion_memberships.length === 1
    && data.battalion_memberships[0].unit_key === '$unit_key'
    && data.battalion_memberships[0].name === 'Bot Player Stats Battalion'
    && data.battalion_memberships[0].callsign === 'BotStats'
    && data.battalion_memberships[0].rank === 'ARC Trooper'
    && data.battalion_memberships[0].rank_key === 'arc-trooper'
    && data.battalion_memberships[0].rank_short_name === 'ARC'
    && data.battalion_memberships[0].roster_name === 'Bot Roster Display'
    && data.battalion_memberships[0].roster_status === 'active'
    && data.battalion_memberships[0].assignment_source === 'discord'
    && data.battalion_memberships[0].is_represented === true
    && data.stats.operation_count === 1
    && data.stats.infantry_kills === 7
    && data.stats.deaths === 1
    && data.scoreboard_totals.score === 70
    && data.attended_operations.length === 1
    && data.attended_operations[0].mission_uid === '$finished_mission_uid'
    && data.attended_operations[0].scoreboard_stats.infantry_kills === 7
  "

echo "[smoke:bot-player-stats] Checking Discord lookup..."
curl -fsS "$BASE_URL/v1/bot/player-stats?discord_user_id=$discord_user_id&limit=5" \
  -H "Authorization: Bearer $BOT_TOKEN" |
  assert_json "
    data.ok === true
    && data.lookup.resolved_player_uid === '$player_uid'
    && data.player.display_name === 'Bot Roster Display'
    && data.battalion_memberships.some((membership) => membership.unit_key === '$unit_key' && membership.rank === 'ARC Trooper')
    && data.stats.operation_count === 1
    && data.stats.infantry_kills === 7
    && data.attended_operations.length === 1
    && data.pagination.total === 1
  "

echo "[smoke:bot-player-stats] Checking validation rejects ambiguous lookup..."
status="$(
  curl -sS -o /tmp/bot-player-stats-invalid.json -w "%{http_code}" \
    "$BASE_URL/v1/bot/player-stats?steam_id=$player_uid&discord_user_id=$discord_user_id" \
    -H "Authorization: Bearer $BOT_TOKEN"
)"

if [[ "$status" != "400" ]]; then
  echo "[smoke:bot-player-stats] Expected ambiguous lookup to return 400, got $status." >&2
  cat /tmp/bot-player-stats-invalid.json >&2
  exit 1
fi

assert_json "data.ok === false && data.error?.code === 'validation_failed'" < /tmp/bot-player-stats-invalid.json
rm -f /tmp/bot-player-stats-invalid.json

echo "[smoke:bot-player-stats] OK player_uid=$player_uid discord_user_id=$discord_user_id"
