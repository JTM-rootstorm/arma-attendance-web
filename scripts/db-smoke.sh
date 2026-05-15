#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:db] API_TOKEN is required." >&2
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

echo "[smoke:db] Checking DB health..."
curl -fsS "$BASE_URL/health/db" \
  -H "Authorization: Bearer $API_TOKEN" | print_json

echo "[smoke:db] Sending persisted debug poke..."
curl -fsS -X POST "$BASE_URL/v1/debug/poke" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"message":"phase 0.5 database smoke","server_key":"db-smoke"}' | print_json

echo "[smoke:db] OK"
