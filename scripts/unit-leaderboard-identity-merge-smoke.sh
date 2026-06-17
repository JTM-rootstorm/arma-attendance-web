#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "$COOKIE_JAR"
}

trap cleanup EXIT

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[smoke:unit-stat-totals] DATABASE_URL is required." >&2
  exit 1
fi

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:unit-stat-totals] API_TOKEN is required." >&2
  exit 1
fi

json_value() {
  local expression="$1"

  node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
let value = data;
for (const part of process.argv[1].replace(/^\./, "").split(".")) {
  if (!part) continue;
  value = value?.[part];
}
console.log(value ?? "");
' "$expression"
}

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

csrf_token() {
  curl -fsS -b "$COOKIE_JAR" "$BASE_URL/auth/csrf" | json_value ".csrf_token"
}

unit_key="unit-stat-alpha-$STAMP"
server_key="unit-stat-alpha-server-$STAMP"
discord_id="123456789$STAMP"
placeholder_uid="discord:$discord_id"
steam_uid="76561198$STAMP"
start_request_id="unit-stat:$STAMP:start"
finish_request_id="unit-stat:$STAMP:finish"
mission_uid="unit-stat-$STAMP"

echo "[smoke:unit-stat-totals] Seeding unit, server key, and placeholder Discord roster..."
unit_id="$(
  psql "$DATABASE_URL" -q -tA -v ON_ERROR_STOP=1 \
    -v unit_key="$unit_key" \
    -v server_key="$server_key" \
    -v discord_id="$discord_id" \
    -v placeholder_uid="$placeholder_uid" <<'SQL'
WITH unit_seed AS (
  INSERT INTO units (unit_key, slug, name, display_name, callsign, sort_order)
  VALUES (:'unit_key', :'unit_key', 'Unit Stat Alpha', 'Unit Stat Alpha', 'Alpha', 10)
  RETURNING id
),
server_key_seed AS (
  INSERT INTO unit_server_keys (unit_id, server_key, is_active)
  SELECT id, :'server_key', true FROM unit_seed
  ON CONFLICT (unit_id, server_key) DO UPDATE SET is_active = true
),
player_seed AS (
  INSERT INTO players (player_uid, last_name, raw_last_player)
  VALUES (:'placeholder_uid', 'Placeholder Trooper', '{"source":"discord_bot"}'::jsonb)
  ON CONFLICT (player_uid) DO UPDATE
  SET last_name = EXCLUDED.last_name,
      deleted_at = NULL,
      updated_at = now()
),
link_seed AS (
  INSERT INTO player_discord_links (
    player_uid,
    discord_user_id,
    discord_display_name,
    source,
    raw_link
  )
  VALUES (
    :'placeholder_uid',
    :'discord_id',
    'Placeholder Trooper',
    'bot',
    '{"source":"unit_stat_totals_smoke"}'::jsonb
  )
  ON CONFLICT (discord_user_id) DO UPDATE
  SET player_uid = EXCLUDED.player_uid,
      source = EXCLUDED.source,
      raw_link = EXCLUDED.raw_link,
      updated_at = now()
)
INSERT INTO unit_players (
  unit_id,
  player_uid,
  roster_name,
  roster_status,
  assignment_source,
  assignment_priority
)
SELECT id, :'placeholder_uid', 'Placeholder Trooper', 'active', 'discord', 50
FROM unit_seed
ON CONFLICT (unit_id, player_uid) DO UPDATE
SET is_active = true,
    roster_status = 'active',
    assignment_source = 'discord',
    updated_at = now()
RETURNING unit_id;
SQL
)"

if [[ -z "$unit_id" ]]; then
  echo "[smoke:unit-stat-totals] Missing unit_id from seed." >&2
  exit 1
fi

echo "[smoke:unit-stat-totals] Linking the same Discord user to Steam through auth..."
curl -fsS -c "$COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"$discord_id\",\"display_name\":\"Placeholder Trooper\"}" |
  assert_json "data.ok === true"

curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/auth/test/link-steam" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"$steam_uid\"}" |
  assert_json "data.ok === true"

canonical_checks="$(
  psql "$DATABASE_URL" -tA -F '|' -v ON_ERROR_STOP=1 \
  -v unit_id="$unit_id" \
  -v discord_id="$discord_id" \
  -v placeholder_uid="$placeholder_uid" \
  -v steam_uid="$steam_uid" <<'SQL'
SELECT
  CASE WHEN EXISTS (
    SELECT 1
    FROM player_discord_links
    WHERE discord_user_id = :'discord_id'
      AND player_uid = :'steam_uid'
  ) THEN 1 ELSE 0 END,
  CASE WHEN EXISTS (
    SELECT 1
    FROM unit_players
    WHERE unit_id = :'unit_id'::uuid
      AND player_uid = :'steam_uid'
      AND is_active = true
      AND roster_status <> 'inactive'
  ) THEN 1 ELSE 0 END,
  CASE WHEN NOT EXISTS (
    SELECT 1
    FROM unit_players
    WHERE unit_id = :'unit_id'::uuid
      AND player_uid = :'placeholder_uid'
  ) THEN 1 ELSE 0 END;
SQL
)"

if [[ "$canonical_checks" != "1|1|1" ]]; then
  echo "[smoke:unit-stat-totals] Canonicalization checks failed: $canonical_checks" >&2
  exit 1
fi

echo "[smoke:unit-stat-totals] Starting operation through server-key unit mapping..."
start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$start_request_id\",
      \"server_key\": \"$server_key\",
      \"payload_version\": 1,
      \"mission\": {
        \"mission_uid\": \"$mission_uid\",
        \"mission_name\": \"Unit Stat Totals Smoke\",
        \"world_name\": \"VR\"
      },
      \"players\": [
        {
          \"player_uid\": \"$steam_uid\",
          \"name\": \"Placeholder Trooper\",
          \"side\": \"WEST\",
          \"group\": \"Alpha\",
          \"role\": \"Rifleman\"
        }
      ]
    }"
)"
operation_id="$(printf "%s" "$start_response" | json_value ".operation_id")"

if [[ -z "$operation_id" || "$operation_id" == "null" ]]; then
  echo "[smoke:unit-stat-totals] Missing operation_id from start response." >&2
  exit 1
fi

printf "%s" "$start_response" | assert_json "data.ok === true && data.status === 'started'"

echo "[smoke:unit-stat-totals] Finishing operation with stats for the Steam UID..."
finish_body="{
  \"request_id\": \"$finish_request_id\",
  \"server_key\": \"$server_key\",
  \"payload_version\": 1,
  \"mission\": {
    \"mission_uid\": \"$mission_uid\",
    \"mission_name\": \"Unit Stat Totals Smoke\",
    \"world_name\": \"VR\"
  },
  \"attendance_records\": [
    {
      \"player_uid\": \"$steam_uid\",
      \"name\": \"Placeholder Trooper\",
      \"side\": \"WEST\",
      \"group\": \"Alpha\",
      \"role\": \"Rifleman\",
      \"stats\": {
        \"infantry_kills\": 7,
        \"vehicle_kills\": 3,
        \"player_kills\": 0,
        \"ai_kills\": 7,
        \"friendly_kills\": 0,
        \"deaths\": 1
      },
      \"scoreboard_stats\": {
        \"stats_source\": \"unit_stat_totals_smoke\",
        \"infantry_kills\": 7,
        \"soft_vehicle_kills\": 1,
        \"armor_kills\": 1,
        \"ground_vehicle_kills\": 2,
        \"air_kills\": 1,
        \"all_vehicle_kills\": 3,
        \"deaths\": 1,
        \"score\": 100,
        \"baseline\": [],
        \"latest\": []
      }
    }
  ]
}"

curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$finish_body" |
  assert_json "data.ok === true && data.idempotent === false && data.normalized.stats_seen === 1"

curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$finish_body" |
  assert_json "data.ok === true && data.idempotent === true"

echo "[smoke:unit-stat-totals] Checking player summary, unit leaderboard, and operation_units..."
curl -fsS "$BASE_URL/v1/players/$steam_uid/summary" \
  -H "Authorization: Bearer $API_TOKEN" |
  assert_json "data.ok === true && data.summary.operation_count === 1 && data.summary.infantry_kills === 7"

curl -fsS "$BASE_URL/v1/leaderboard/units?unit_id=$unit_id&limit=10" \
  -H "Authorization: Bearer $API_TOKEN" |
  assert_json "data.ok === true
    && data.leaderboard.length === 1
    && data.leaderboard[0].unit_id === '$unit_id'
    && data.leaderboard[0].operation_count === 1
    && data.leaderboard[0].infantry_kills === 7
    && data.leaderboard[0].total_kills === 10
    && data.leaderboard[0].deaths === 1"

operation_checks="$(
  psql "$DATABASE_URL" -tA -F '|' -v ON_ERROR_STOP=1 \
  -v unit_id="$unit_id" \
  -v operation_id="$operation_id" \
  -v discord_id="$discord_id" \
  -v steam_uid="$steam_uid" <<'SQL'
SELECT
  CASE WHEN EXISTS (
    SELECT 1
    FROM operation_units
    WHERE operation_id = :'operation_id'::uuid
      AND unit_id = :'unit_id'::uuid
      AND source IN ('server_key', 'import')
  ) THEN 1 ELSE 0 END,
  (
    SELECT COUNT(*)
    FROM unit_players
    WHERE unit_id = :'unit_id'::uuid
      AND player_uid = :'steam_uid'
  )::int;
SQL
)"

if [[ "$operation_checks" != "1|1" ]]; then
  echo "[smoke:unit-stat-totals] Operation unit or roster count checks failed: $operation_checks" >&2
  exit 1
fi

echo "[smoke:unit-stat-totals] Re-running auth repair to verify idempotency..."
curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/auth/test/link-steam" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"$steam_uid\"}" |
  assert_json "data.ok === true"

curl -fsS "$BASE_URL/v1/leaderboard/units?unit_id=$unit_id&limit=10" \
  -H "Authorization: Bearer $API_TOKEN" |
  assert_json "data.ok === true
    && data.leaderboard.length === 1
    && data.leaderboard[0].operation_count === 1
    && data.leaderboard[0].total_kills === 10"

echo "[smoke:unit-stat-totals] OK operation_id=$operation_id unit_id=$unit_id"
