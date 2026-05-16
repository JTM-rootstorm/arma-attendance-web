#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
SERVER_KEY="${SERVER_KEY:-ops-observability-smoke}"
STAMP="$(date +%Y%m%d%H%M%S)"
START_REQUEST_ID="${START_REQUEST_ID:-$SERVER_KEY:$STAMP:start}"
FINISH_REQUEST_ID="${FINISH_REQUEST_ID:-$SERVER_KEY:$STAMP:finish}"
MISSION_UID="${MISSION_UID:-$SERVER_KEY-$STAMP}"

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:operations:observability] API_TOKEN is required." >&2
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

json_length() {
  local expression="$1"

  if command -v jq >/dev/null 2>&1; then
    jq -r "$expression | length"
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

print(len(data))
' "$expression"
  fi
}

urlencode() {
  python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"
}

echo "[smoke:operations:observability] Starting operation..."
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
        \"mission_name\": \"Operation Observability Smoke Test\",
        \"world_name\": \"VR\"
      },
      \"zeus\": {
        \"name\": \"operations-observability-smoke\"
      },
      \"players\": []
    }"
)"
printf '%s\n' "$start_response" | print_json
operation_id="$(printf '%s\n' "$start_response" | json_value ".operation_id")"

if [[ -z "$operation_id" || "$operation_id" == "null" ]]; then
  echo "[smoke:operations:observability] Missing operation_id from start response." >&2
  exit 1
fi

echo "[smoke:operations:observability] Replaying start request..."
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
        \"mission_name\": \"Operation Observability Smoke Test\",
        \"world_name\": \"VR\"
      }
    }"
)"
printf '%s\n' "$replay_response" | print_json

if [[ "$(printf '%s\n' "$replay_response" | json_value ".idempotent")" != "true" ]]; then
  echo "[smoke:operations:observability] Expected replay response to be idempotent." >&2
  exit 1
fi

echo "[smoke:operations:observability] Finishing operation..."
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
        \"mission_name\": \"Operation Observability Smoke Test\",
        \"world_name\": \"VR\"
      },
      \"players\": []
    }"
)"
printf '%s\n' "$finish_response" | print_json

if [[ "$(printf '%s\n' "$finish_response" | json_value ".status")" != "finished" ]]; then
  echo "[smoke:operations:observability] Expected finish response status to be finished." >&2
  exit 1
fi

echo "[smoke:operations:observability] Fetching operation detail..."
operation_response="$(curl -fsS "$BASE_URL/v1/operations/$operation_id" -H "Authorization: Bearer $API_TOKEN")"
printf '%s\n' "$operation_response" | print_json

echo "[smoke:operations:observability] Listing operations..."
operations_response="$(
  curl -fsS "$BASE_URL/v1/operations?server_key=$SERVER_KEY&limit=10" \
    -H "Authorization: Bearer $API_TOKEN"
)"
printf '%s\n' "$operations_response" | print_json

if [[ "$(printf '%s\n' "$operations_response" | json_value ".pagination.count")" -lt 1 ]]; then
  echo "[smoke:operations:observability] Expected operation list to include at least one row." >&2
  exit 1
fi

echo "[smoke:operations:observability] Fetching operation payloads..."
payloads_response="$(
  curl -fsS "$BASE_URL/v1/operations/$operation_id/payloads" \
    -H "Authorization: Bearer $API_TOKEN"
)"
printf '%s\n' "$payloads_response" | print_json

if [[ "$(printf '%s\n' "$payloads_response" | json_length ".payloads")" -lt 2 ]]; then
  echo "[smoke:operations:observability] Expected at least two operation payloads." >&2
  exit 1
fi

encoded_start_request_id="$(urlencode "$START_REQUEST_ID")"
encoded_finish_request_id="$(urlencode "$FINISH_REQUEST_ID")"

echo "[smoke:operations:observability] Fetching start ingest request..."
start_ingest_response="$(
  curl -fsS "$BASE_URL/v1/ingest-requests/$encoded_start_request_id" \
    -H "Authorization: Bearer $API_TOKEN"
)"
printf '%s\n' "$start_ingest_response" | print_json

if [[ "$(printf '%s\n' "$start_ingest_response" | json_value ".ok")" != "true" ]]; then
  echo "[smoke:operations:observability] Expected start ingest request lookup to succeed." >&2
  exit 1
fi

echo "[smoke:operations:observability] Fetching finish ingest request..."
finish_ingest_response="$(
  curl -fsS "$BASE_URL/v1/ingest-requests/$encoded_finish_request_id" \
    -H "Authorization: Bearer $API_TOKEN"
)"
printf '%s\n' "$finish_ingest_response" | print_json

if [[ "$(printf '%s\n' "$finish_ingest_response" | json_value ".ok")" != "true" ]]; then
  echo "[smoke:operations:observability] Expected finish ingest request lookup to succeed." >&2
  exit 1
fi

echo "[smoke:operations:observability] OK operation_id=$operation_id"
