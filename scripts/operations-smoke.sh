#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
SERVER_KEY="${SERVER_KEY:-ops-smoke}"
STAMP="$(date +%Y%m%d%H%M%S)"
START_REQUEST_ID="${START_REQUEST_ID:-$SERVER_KEY:$STAMP:start}"
FINISH_REQUEST_ID="${FINISH_REQUEST_ID:-$SERVER_KEY:$STAMP:finish}"
MISSION_UID="${MISSION_UID:-$SERVER_KEY-$STAMP}"

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:operations] API_TOKEN is required." >&2
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

extract_operation_id() {
  if command -v jq >/dev/null 2>&1; then
    jq -r '.operation_id'
  else
    python3 -c 'import json,sys; print(json.load(sys.stdin)["operation_id"])'
  fi
}

echo "[smoke:operations] Starting operation..."
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
        \"mission_name\": \"Operation Smoke Test\",
        \"world_name\": \"VR\"
      },
      \"zeus\": {
        \"name\": \"operations-smoke\"
      },
      \"players\": []
    }"
)"

printf '%s\n' "$start_response" | print_json
operation_id="$(printf '%s\n' "$start_response" | extract_operation_id)"

if [[ -z "$operation_id" || "$operation_id" == "null" ]]; then
  echo "[smoke:operations] Missing operation_id from start response." >&2
  exit 1
fi

echo "[smoke:operations] Replaying start request for idempotency..."
curl -fsS -X POST "$BASE_URL/v1/operations/start" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"$START_REQUEST_ID\",
    \"server_key\": \"$SERVER_KEY\",
    \"payload_version\": 1,
    \"mission\": {
      \"mission_uid\": \"$MISSION_UID\",
      \"mission_name\": \"Operation Smoke Test\",
      \"world_name\": \"VR\"
    }
  }" | print_json

echo "[smoke:operations] Finishing operation..."
curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"$FINISH_REQUEST_ID\",
    \"server_key\": \"$SERVER_KEY\",
    \"payload_version\": 1,
    \"mission\": {
      \"mission_uid\": \"$MISSION_UID\",
      \"mission_name\": \"Operation Smoke Test\",
      \"world_name\": \"VR\"
    },
    \"players\": []
  }" | print_json

echo "[smoke:operations] Fetching operation..."
curl -fsS "$BASE_URL/v1/operations/$operation_id" \
  -H "Authorization: Bearer $API_TOKEN" | print_json

echo "[smoke:operations] OK operation_id=$operation_id"
