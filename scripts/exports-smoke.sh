#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
SERVER_KEY="${SERVER_KEY:-exports-smoke}"
STAMP="$(date +%Y%m%d%H%M%S)"
START_REQUEST_ID="${START_REQUEST_ID:-$SERVER_KEY:$STAMP:start}"
FINISH_REQUEST_ID="${FINISH_REQUEST_ID:-$SERVER_KEY:$STAMP:finish}"
MISSION_UID="${MISSION_UID:-$SERVER_KEY-$STAMP}"
PLAYER_UID="${PLAYER_UID:-$SERVER_KEY-$STAMP-player}"

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:exports] API_TOKEN is required." >&2
  exit 1
fi

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
    data = data[part]

print(data)
' "$expression"
  fi
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

echo "[smoke:exports] Creating operation with attendance..."
start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$START_REQUEST_ID\",
      \"server_key\": \"$SERVER_KEY\",
      \"mission\": {
        \"mission_uid\": \"$MISSION_UID\",
        \"mission_name\": \"Export Smoke\",
        \"world_name\": \"VR\"
      },
      \"players\": [
        {
          \"player_uid\": \"$PLAYER_UID\",
          \"name\": \"Export Smoke One\",
          \"role\": \"Rifleman\"
        }
      ]
    }"
)"
operation_id="$(printf '%s\n' "$start_response" | json_value ".operation_id")"

curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"$FINISH_REQUEST_ID\",
    \"server_key\": \"$SERVER_KEY\",
    \"players\": [
      {
        \"player_uid\": \"$PLAYER_UID\",
        \"name\": \"Export Smoke One\",
        \"stats\": {
          \"ai_kills\": 3,
          \"deaths\": 1
        }
      }
    ]
  }" >/dev/null

echo "[smoke:exports] Checking operation attendance CSV..."
csv="$(curl -fsS "$BASE_URL/v1/operations/$operation_id/attendance.csv" -H "Authorization: Bearer $API_TOKEN")"
printf '%s\n' "$csv" | head -n 5
printf '%s\n' "$csv" | grep -q "player_uid"
printf '%s\n' "$csv" | grep -q "$PLAYER_UID"

echo "[smoke:exports] Checking players CSV..."
players_csv="$(curl -fsS "$BASE_URL/v1/players.csv?q=$(urlencode "$PLAYER_UID")" -H "Authorization: Bearer $API_TOKEN")"
printf '%s\n' "$players_csv" | head -n 5
printf '%s\n' "$players_csv" | grep -q "player_uid"
printf '%s\n' "$players_csv" | grep -q "$PLAYER_UID"

echo "[smoke:exports] OK operation_id=$operation_id"
