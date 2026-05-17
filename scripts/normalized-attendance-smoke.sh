#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
SERVER_KEY="${SERVER_KEY:-attendance-smoke}"
STAMP="$(date +%Y%m%d%H%M%S)"
START_REQUEST_ID="${START_REQUEST_ID:-$SERVER_KEY:$STAMP:start}"
FINISH_REQUEST_ID="${FINISH_REQUEST_ID:-$SERVER_KEY:$STAMP:finish}"
MISSION_UID="${MISSION_UID:-$SERVER_KEY-$STAMP}"
PLAYER_ONE_UID="${PLAYER_ONE_UID:-$SERVER_KEY-$STAMP-alpha}"
PLAYER_TWO_UID="${PLAYER_TWO_UID:-$SERVER_KEY-$STAMP-bravo}"
PLAYER_END_ONLY_UID="${PLAYER_END_ONLY_UID:-$SERVER_KEY-$STAMP-charlie}"

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:attendance] API_TOKEN is required." >&2
  exit 1
fi

print_json() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  else
    cat
    printf '\n'
  fi
}

json_value() {
  local expression="$1"

  if command -v jq >/dev/null 2>&1; then
    jq -r "$expression"
  else
    python3 -c '
import json
import sys

data = json.load(sys.stdin)
expression = sys.argv[1]

for part in expression.removeprefix(".").split("."):
    if not part:
        continue

    if "[" in part and part.endswith("]"):
        name, index = part[:-1].split("[", 1)
        if name:
            data = data[name]
        data = data[int(index)]
    else:
        data = data[part]

if isinstance(data, bool):
    print("true" if data else "false")
elif data is None:
    print("null")
else:
    print(data)
' "$expression"
  fi
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

assert_attendance_response() {
  local player_uid="$1"

  if command -v jq >/dev/null 2>&1; then
    jq -e --arg player_uid "$player_uid" '
      .ok == true
      and (.attendance | length) >= 2
      and any(.attendance[]; .present_at_start == true)
      and any(.attendance[]; .present_at_end == true)
      and any(.attendance[]; .player_uid == $player_uid and .stats.infantry_kills == 3 and .stats.deaths == 1)
    ' >/dev/null
  else
    python3 -c '
import json
import sys

data = json.load(sys.stdin)
player_uid = sys.argv[1]
attendance = data.get("attendance", [])

ok = (
    data.get("ok") is True
    and len(attendance) >= 2
    and any(row.get("present_at_start") is True for row in attendance)
    and any(row.get("present_at_end") is True for row in attendance)
    and any(
        row.get("player_uid") == player_uid
        and (row.get("stats") or {}).get("infantry_kills") == 3
        and (row.get("stats") or {}).get("deaths") == 1
        for row in attendance
    )
)

if not ok:
    raise SystemExit(1)
' "$player_uid"
  fi
}

assert_players_response() {
  if command -v jq >/dev/null 2>&1; then
    jq -e '.ok == true and (.players | length) >= 1' >/dev/null
  else
    python3 -c '
import json
import sys

data = json.load(sys.stdin)
if not (data.get("ok") is True and len(data.get("players", [])) >= 1):
    raise SystemExit(1)
'
  fi
}

assert_player_detail_response() {
  local player_uid="$1"

  if command -v jq >/dev/null 2>&1; then
    jq -e --arg player_uid "$player_uid" '
      .ok == true
      and .player.player_uid == $player_uid
      and (.recent_operations | length) >= 1
      and any(.recent_operations[]; .stats.infantry_kills == 3 and .stats.deaths == 1)
    ' >/dev/null
  else
    python3 -c '
import json
import sys

data = json.load(sys.stdin)
player_uid = sys.argv[1]
operations = data.get("recent_operations", [])

ok = (
    data.get("ok") is True
    and data.get("player", {}).get("player_uid") == player_uid
    and len(operations) >= 1
    and any(
        (operation.get("stats") or {}).get("infantry_kills") == 3
        and (operation.get("stats") or {}).get("deaths") == 1
        for operation in operations
    )
)

if not ok:
    raise SystemExit(1)
' "$player_uid"
  fi
}

echo "[smoke:attendance] Starting operation with players..."
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
        \"mission_name\": \"Normalized Attendance Smoke Test\",
        \"world_name\": \"VR\"
      },
      \"players\": [
        {
          \"player_uid\": \"$PLAYER_ONE_UID\",
          \"name\": \"Smoke Alpha\",
          \"side\": \"WEST\",
          \"group\": \"Alpha 1-1\",
          \"role\": \"Rifleman\",
          \"unit_class\": \"B_Soldier_F\"
        },
        {
          \"steam_id\": \"$PLAYER_TWO_UID\",
          \"display_name\": \"Smoke Bravo\",
          \"side_name\": \"WEST\",
          \"group_name\": \"Alpha 1-2\",
          \"role_name\": \"Medic\",
          \"unit_class\": \"B_medic_F\"
        },
        {
          \"name\": \"Missing UID Should Be Ignored\"
        }
      ]
    }"
)"
printf '%s\n' "$start_response" | print_json
operation_id="$(printf '%s\n' "$start_response" | json_value ".operation_id")"

if [[ -z "$operation_id" || "$operation_id" == "null" ]]; then
  echo "[smoke:attendance] Missing operation_id from start response." >&2
  exit 1
fi

echo "[smoke:attendance] Replaying start request..."
replay_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$START_REQUEST_ID\",
      \"server_key\": \"$SERVER_KEY\",
      \"payload_version\": 1,
      \"mission\": {
        \"mission_uid\": \"$MISSION_UID\",
        \"mission_name\": \"Normalized Attendance Smoke Test\",
        \"world_name\": \"VR\"
      },
      \"players\": [
        {
          \"player_uid\": \"$PLAYER_ONE_UID\",
          \"name\": \"Smoke Alpha\"
        }
      ]
    }"
)"
printf '%s\n' "$replay_response" | print_json

if [[ "$(printf '%s\n' "$replay_response" | json_value ".idempotent")" != "true" ]]; then
  echo "[smoke:attendance] Expected replay response to be idempotent." >&2
  exit 1
fi

echo "[smoke:attendance] Finishing operation with player stats..."
finish_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$FINISH_REQUEST_ID\",
      \"server_key\": \"$SERVER_KEY\",
      \"payload_version\": 1,
      \"mission\": {
        \"mission_uid\": \"$MISSION_UID\",
        \"mission_name\": \"Normalized Attendance Smoke Test\",
        \"world_name\": \"VR\"
      },
      \"players\": [
        {
          \"player_uid\": \"$PLAYER_ONE_UID\",
          \"player_name\": \"Smoke Alpha\",
          \"side\": \"WEST\",
          \"group\": \"Alpha 1-1\",
          \"role\": \"Team Leader\",
          \"unit_class\": \"B_Soldier_TL_F\",
          \"stats\": {
            \"infantry_kills\": 3,
            \"vehicle_kills\": 1,
            \"player_kills\": 0,
            \"ai_kills\": 4,
            \"friendly_kills\": 0,
            \"deaths\": 1
          }
        },
        {
          \"uid\": \"$PLAYER_TWO_UID\",
          \"name\": \"Smoke Bravo\",
          \"side\": \"WEST\",
          \"group\": \"Alpha 1-2\",
          \"role\": \"Medic\",
          \"unit_class\": \"B_medic_F\"
        },
        {
          \"arma_uid\": \"$PLAYER_END_ONLY_UID\",
          \"name\": \"Smoke Charlie\",
          \"side\": \"WEST\",
          \"group\": \"Alpha 1-3\",
          \"role\": \"Autorifleman\",
          \"unit_class\": \"B_soldier_AR_F\"
        }
      ]
    }"
)"
printf '%s\n' "$finish_response" | print_json

if [[ "$(printf '%s\n' "$finish_response" | json_value ".status")" != "finished" ]]; then
  echo "[smoke:attendance] Expected finish response status to be finished." >&2
  exit 1
fi

echo "[smoke:attendance] Fetching normalized operation attendance..."
attendance_response="$(curl -fsS "$BASE_URL/v1/operations/$operation_id/attendance" -H "Authorization: Bearer $API_TOKEN")"
printf '%s\n' "$attendance_response" | print_json
printf '%s\n' "$attendance_response" | assert_attendance_response "$PLAYER_ONE_UID"

echo "[smoke:attendance] Listing normalized players..."
players_response="$(
  curl -fsS "$BASE_URL/v1/players?q=$(urlencode "$PLAYER_ONE_UID")&limit=10" \
    -H "Authorization: Bearer $API_TOKEN"
)"
printf '%s\n' "$players_response" | print_json
printf '%s\n' "$players_response" | assert_players_response

echo "[smoke:attendance] Fetching normalized player detail..."
player_detail_response="$(
  curl -fsS "$BASE_URL/v1/players/$(urlencode "$PLAYER_ONE_UID")" \
    -H "Authorization: Bearer $API_TOKEN"
)"
printf '%s\n' "$player_detail_response" | print_json
printf '%s\n' "$player_detail_response" | assert_player_detail_response "$PLAYER_ONE_UID"

echo "[smoke:attendance] OK operation_id=$operation_id player_uid=$PLAYER_ONE_UID"
