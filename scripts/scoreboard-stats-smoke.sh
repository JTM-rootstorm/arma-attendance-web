#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
SERVER_KEY="${SERVER_KEY:-scoreboard-smoke}"
STAMP="$(date +%Y%m%d%H%M%S)"
START_REQUEST_ID="${START_REQUEST_ID:-$SERVER_KEY:$STAMP:start}"
FINISH_REQUEST_ID="${FINISH_REQUEST_ID:-$SERVER_KEY:$STAMP:finish}"
MISSION_UID="${MISSION_UID:-$SERVER_KEY-$STAMP}"
PLAYER_ONE_UID="${PLAYER_ONE_UID:-7656119${STAMP}01}"
PLAYER_TWO_UID="${PLAYER_TWO_UID:-7656119${STAMP}02}"
USER_COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "$USER_COOKIE_JAR"
}

trap cleanup EXIT

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

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:scoreboard] API_TOKEN is required." >&2
  exit 1
fi

echo "[smoke:scoreboard] Starting operation..."
start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$START_REQUEST_ID\",
      \"server_key\": \"$SERVER_KEY\",
      \"payload_version\": 1,
      \"mission\": {
        \"mission_uid\": \"$MISSION_UID\",
        \"mission_name\": \"Scoreboard Smoke Test\",
        \"world_name\": \"VR\"
      },
      \"players\": [
        {
          \"player_uid\": \"$PLAYER_ONE_UID\",
          \"name\": \"Scoreboard Alpha\",
          \"side\": \"WEST\",
          \"group\": \"Alpha 1-1\",
          \"role\": \"Rifleman\"
        },
        {
          \"steam_id\": \"$PLAYER_TWO_UID\",
          \"name\": \"Scoreboard Bravo\",
          \"side\": \"WEST\",
          \"group\": \"Alpha 1-2\",
          \"role\": \"Medic\"
        }
      ]
    }"
)"
operation_id="$(printf "%s" "$start_response" | json_value ".operation_id")"

if [[ -z "$operation_id" || "$operation_id" == "null" ]]; then
  echo "[smoke:scoreboard] Missing operation_id from start response." >&2
  exit 1
fi

echo "[smoke:scoreboard] Finishing operation with scoreboard stats..."
curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"$FINISH_REQUEST_ID\",
    \"server_key\": \"$SERVER_KEY\",
    \"payload_version\": 1,
    \"mission\": {
      \"mission_uid\": \"$MISSION_UID\",
      \"mission_name\": \"Scoreboard Smoke Test\",
      \"world_name\": \"VR\"
    },
    \"players\": [
      {
        \"player_uid\": \"$PLAYER_ONE_UID\",
        \"name\": \"Scoreboard Alpha\",
        \"stats\": {
          \"infantry_kills\": 12,
          \"vehicle_kills\": 4,
          \"player_kills\": 0,
          \"ai_kills\": 12,
          \"friendly_kills\": 0,
          \"deaths\": 2
        }
      }
    ],
    \"attendance_records\": [
      {
        \"player_uid\": \"$PLAYER_ONE_UID\",
        \"name\": \"Scoreboard Alpha\",
        \"side\": \"WEST\",
        \"group\": \"Alpha 1-1\",
        \"role\": \"Rifleman\",
        \"stats\": {
          \"infantry_kills\": 12,
          \"vehicle_kills\": 4,
          \"player_kills\": 0,
          \"ai_kills\": 12,
          \"friendly_kills\": 0,
          \"deaths\": 2
        },
        \"scoreboard_stats\": {
          \"stats_source\": \"arma_getPlayerScores_delta\",
          \"infantry_kills\": 12,
          \"soft_vehicle_kills\": 1,
          \"armor_kills\": 2,
          \"ground_vehicle_kills\": 3,
          \"air_kills\": 1,
          \"all_vehicle_kills\": 4,
          \"deaths\": 2,
          \"score\": 155,
          \"baseline\": [0, 0, 0, 0, 0, 0],
          \"latest\": [12, 1, 2, 1, 2, 155]
        }
      },
      {
        \"steam_id\": \"$PLAYER_TWO_UID\",
        \"name\": \"Scoreboard Bravo\",
        \"side\": \"WEST\",
        \"group\": \"Alpha 1-2\",
        \"role\": \"Medic\",
        \"scoreboard_stats\": {
          \"stats_source\": \"arma_getPlayerScores_delta\",
          \"infantry_kills\": 4,
          \"soft_vehicle_kills\": 2,
          \"armor_kills\": 1,
          \"ground_vehicle_kills\": 3,
          \"air_kills\": 0,
          \"all_vehicle_kills\": 3,
          \"deaths\": 1,
          \"score\": 80,
          \"baseline\": [0, 0, 0, 0, 0, 0],
          \"latest\": [4, 2, 1, 0, 1, 80]
        }
      }
    ]
  }" | assert_json 'data.ok === true && data.normalized.players_seen === 2 && data.normalized.stats_seen === 2'

echo "[smoke:scoreboard] Checking owner/machine attendance scoreboard..."
curl -fsS "$BASE_URL/v1/operations/$operation_id/attendance" \
  -H "Authorization: Bearer $API_TOKEN" | assert_json "data.ok === true
    && data.attendance.length === 2
    && data.attendance.some((row) => row.player_uid === '$PLAYER_ONE_UID' && row.scoreboard_stats.infantry_kills === 12 && row.scoreboard_stats.soft_vehicle_kills === 1 && row.scoreboard_stats.armor_kills === 2 && row.scoreboard_stats.air_kills === 1 && row.scoreboard_stats.deaths === 2)
    && data.attendance.some((row) => row.player_uid === '$PLAYER_TWO_UID' && row.scoreboard_stats.infantry_kills === 4 && row.scoreboard_stats.soft_vehicle_kills === 2)"

echo "[smoke:scoreboard] Checking roster contains unauthenticated payload players..."
curl -fsS "$BASE_URL/v1/players?q=$PLAYER_ONE_UID" \
  -H "Authorization: Bearer $API_TOKEN" | assert_json "data.ok === true && data.players.some((player) => player.player_uid === '$PLAYER_ONE_UID')"
curl -fsS "$BASE_URL/v1/players?q=$PLAYER_TWO_UID" \
  -H "Authorization: Bearer $API_TOKEN" | assert_json "data.ok === true && data.players.some((player) => player.player_uid === '$PLAYER_TWO_UID')"

echo "[smoke:scoreboard] Checking linked self totals and sensitive redaction..."
curl -fsS -c "$USER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"scoreboard-user-$STAMP\",\"display_name\":\"Scoreboard Smoke User\"}" >/dev/null
curl -fsS -b "$USER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/link-steam" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"$PLAYER_ONE_UID\"}" >/dev/null

curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/me/player" | assert_json 'data.ok === true
  && data.scoreboard_totals.infantry_kills === 12
  && data.scoreboard_totals.soft_vehicle_kills === 1
  && data.scoreboard_totals.armor_kills === 2
  && data.scoreboard_totals.air_kills === 1
  && data.scoreboard_totals.deaths === 2'

curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id/attendance" | assert_json 'data.ok === true
  && data.attendance.length === 2
  && data.attendance.every((row) => row.player_uid === null)
  && data.attendance.some((row) => row.scoreboard_stats.infantry_kills === 12)'

echo "[smoke:scoreboard] OK operation_id=$operation_id"
