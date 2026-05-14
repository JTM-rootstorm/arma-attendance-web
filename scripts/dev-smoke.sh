#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"

print_json() {
  if command -v jq >/dev/null 2>&1; then
    jq .
  else
    cat
    printf '\n'
  fi
}

echo "[smoke] Checking health at ${BASE_URL}/health"
curl -fsS "${BASE_URL}/health" | print_json

echo "[smoke] Checking authenticated debug poke"
curl -fsS -X POST "${BASE_URL}/v1/debug/poke" \
  -H "Authorization: Bearer ${API_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"message":"hello from smoke test","server_key":"dev-smoke"}' | print_json

echo "[smoke] OK"
