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

echo "[smoke] Checking debug poke rejects missing auth"
unauthorized_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/v1/debug/poke" \
    -H "Content-Type: application/json" \
    -d '{"message":"hello from smoke test","server_key":"dev-smoke"}'
)"

if [[ "$unauthorized_status" != "401" ]]; then
  echo "[smoke] Expected missing auth to return 401, got $unauthorized_status" >&2
  exit 1
fi

echo "[smoke] Checking debug poke validation without touching DB"
validation_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -X POST "${BASE_URL}/v1/debug/poke" \
    -H "Authorization: Bearer ${API_TOKEN}" \
    -H "Content-Type: application/json" \
    -d '{"message":42}'
)"

if [[ "$validation_status" != "400" ]]; then
  echo "[smoke] Expected invalid debug poke body to return 400, got $validation_status" >&2
  exit 1
fi

echo "[smoke] DB-backed debug poke persistence is covered by pnpm smoke:db"

echo "[smoke] OK"
