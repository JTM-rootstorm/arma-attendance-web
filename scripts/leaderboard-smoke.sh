#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
OWNER_COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "$OWNER_COOKIE_JAR"
}

trap cleanup EXIT

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

require_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "[smoke:leaderboard] DATABASE_URL is required." >&2
    exit 1
  fi
}

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

login_user() {
  curl -fsS -c "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{\"provider_user_id\":\"leaderboard-owner-$STAMP\",\"display_name\":\"Leaderboard Smoke Owner\",\"roles\":[\"owner\"]}" | json_value ".user_id"
}

require_database_url

unit_a_key="leaderboard-a-$STAMP"
unit_b_key="leaderboard-b-$STAMP"
player_a_one="7656119${STAMP}11"
player_a_two="7656119${STAMP}12"
player_b_one="7656119${STAMP}21"
player_b_two="7656119${STAMP}22"

echo "[smoke:leaderboard] Creating owner session..."
owner_id="$(login_user)"

echo "[smoke:leaderboard] Seeding battalions, rosters, and score rows..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v unit_a_key="$unit_a_key" \
  -v unit_b_key="$unit_b_key" \
  -v player_a_one="$player_a_one" \
  -v player_a_two="$player_a_two" \
  -v player_b_one="$player_b_one" \
  -v player_b_two="$player_b_two" <<'SQL'
WITH unit_a AS (
  INSERT INTO units (unit_key, slug, name, display_name, callsign)
  VALUES (:'unit_a_key', :'unit_a_key', 'Leaderboard Smoke Alpha', 'Leaderboard Smoke Alpha', 'Alpha')
  RETURNING id
),
unit_b AS (
  INSERT INTO units (unit_key, slug, name, display_name, callsign)
  VALUES (:'unit_b_key', :'unit_b_key', 'Leaderboard Smoke Bravo', 'Leaderboard Smoke Bravo', 'Bravo')
  RETURNING id
),
players AS (
  INSERT INTO players (player_uid, last_name, raw_last_player)
  VALUES
    (:'player_a_one', 'Alpha One', '{}'::jsonb),
    (:'player_a_two', 'Alpha Two', '{}'::jsonb),
    (:'player_b_one', 'Bravo One', '{}'::jsonb),
    (:'player_b_two', 'Bravo Two', '{}'::jsonb)
  ON CONFLICT (player_uid) DO UPDATE SET last_name = EXCLUDED.last_name, updated_at = now()
  RETURNING player_uid
),
unit_players_seed AS (
  INSERT INTO unit_players (unit_id, player_uid, roster_name, roster_status)
  SELECT unit_a.id, :'player_a_one', 'Alpha One', 'active' FROM unit_a
  UNION ALL SELECT unit_a.id, :'player_a_two', 'Alpha Two', 'active' FROM unit_a
  UNION ALL SELECT unit_b.id, :'player_b_one', 'Bravo One', 'active' FROM unit_b
  UNION ALL SELECT unit_b.id, :'player_b_two', 'Bravo Two', 'active' FROM unit_b
  ON CONFLICT (unit_id, player_uid) DO UPDATE SET is_active = true, roster_status = 'active', updated_at = now()
),
operation_a AS (
  INSERT INTO operations (unit_id, server_key, status, mission_uid, mission_name, world_name, started_at, ended_at)
  SELECT unit_a.id, 'leaderboard-smoke', 'finished', :'unit_a_key', 'Leaderboard Alpha', 'VR', now(), now() FROM unit_a
  RETURNING id
),
operation_b AS (
  INSERT INTO operations (unit_id, server_key, status, mission_uid, mission_name, world_name, started_at, ended_at)
  SELECT unit_b.id, 'leaderboard-smoke', 'finished', :'unit_b_key', 'Leaderboard Bravo', 'VR', now(), now() FROM unit_b
  RETURNING id
),
operation_players_seed AS (
  INSERT INTO operation_players (operation_id, player_uid, name_at_start, name_at_end, present_at_start, present_at_end)
  SELECT operation_a.id, :'player_a_one', 'Alpha One', 'Alpha One', true, true FROM operation_a
  UNION ALL SELECT operation_a.id, :'player_a_two', 'Alpha Two', 'Alpha Two', true, true FROM operation_a
  UNION ALL SELECT operation_b.id, :'player_b_one', 'Bravo One', 'Bravo One', true, true FROM operation_b
  UNION ALL SELECT operation_b.id, :'player_b_two', 'Bravo Two', 'Bravo Two', true, true FROM operation_b
)
INSERT INTO operation_player_stats (
  operation_id,
  player_uid,
  infantry_kills,
  vehicle_kills,
  deaths,
  soft_vehicle_kills,
  armor_kills,
  air_kills
)
SELECT operation_a.id, :'player_a_one', 20, 8, 2, 3, 4, 1 FROM operation_a
UNION ALL SELECT operation_a.id, :'player_a_two', 12, 3, 1, 1, 2, 0 FROM operation_a
UNION ALL SELECT operation_b.id, :'player_b_one', 5, 2, 3, 1, 1, 0 FROM operation_b
UNION ALL SELECT operation_b.id, :'player_b_two', 2, 1, 1, 0, 1, 0 FROM operation_b;
SQL

echo "[smoke:leaderboard] Checking ranking and formula..."
leaderboard_response="$(curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/leaderboard/units?limit=200")"
printf "%s" "$leaderboard_response" | assert_json "
  data.ok === true
  && data.leaderboard.some((entry) => entry.unit_key === '$unit_a_key')
  && data.leaderboard.some((entry) => entry.unit_key === '$unit_b_key')
  && data.leaderboard.find((entry) => entry.unit_key === '$unit_a_key').rank < data.leaderboard.find((entry) => entry.unit_key === '$unit_b_key').rank
  && data.leaderboard.find((entry) => entry.unit_key === '$unit_a_key').operation_count === 1
  && data.leaderboard.find((entry) => entry.unit_key === '$unit_b_key').operation_count === 1
  && data.leaderboard.find((entry) => entry.unit_key === '$unit_a_key').total_kills === 43
  && data.leaderboard.find((entry) => entry.unit_key === '$unit_a_key').total_kills === (
    data.leaderboard.find((entry) => entry.unit_key === '$unit_a_key').infantry_kills
    + data.leaderboard.find((entry) => entry.unit_key === '$unit_a_key').soft_vehicle_kills
    + data.leaderboard.find((entry) => entry.unit_key === '$unit_a_key').armor_kills
    + data.leaderboard.find((entry) => entry.unit_key === '$unit_a_key').air_kills
  )
  && data.leaderboard.find((entry) => entry.unit_key === '$unit_a_key').deaths === 3
"

echo "[smoke:leaderboard] Checking player operation counts still count personal attendance..."
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/players/$player_a_one/summary" |
  assert_json 'data.ok === true && data.summary.operation_count === 1'
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/players/$player_a_two/summary" |
  assert_json 'data.ok === true && data.summary.operation_count === 1'

echo "[smoke:leaderboard] Checking unauthenticated leaderboard is available and redacted..."
public_leaderboard_response="$(curl -fsS "$BASE_URL/v1/leaderboard/units?limit=200")"
printf "%s" "$public_leaderboard_response" | assert_json '
  data.ok === true
  && data.leaderboard.some((entry) => entry.name === "Leaderboard Smoke Alpha" && entry.unit_id === null && entry.unit_key === null)
'

echo "[smoke:leaderboard] OK owner_id=$owner_id"
