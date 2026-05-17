#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:data-quality] API_TOKEN is required." >&2
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

assert_data_quality() {
  if command -v jq >/dev/null 2>&1; then
    jq -e '.ok == true and (.checks | type == "object")' >/dev/null
  else
    python3 -c '
import json
import sys

data = json.load(sys.stdin)
if not (data.get("ok") is True and isinstance(data.get("checks"), dict)):
    raise SystemExit(1)
'
  fi
}

echo "[smoke:data-quality] Checking data quality endpoint..."
quality_response="$(curl -fsS "$BASE_URL/v1/data-quality" -H "Authorization: Bearer $API_TOKEN")"
printf '%s\n' "$quality_response" | print_json
printf '%s\n' "$quality_response" | assert_data_quality

echo "[smoke:data-quality] OK"
