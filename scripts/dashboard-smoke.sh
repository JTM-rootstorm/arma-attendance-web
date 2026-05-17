#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:dashboard] API_TOKEN is required." >&2
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

assert_dashboard_summary() {
  if command -v jq >/dev/null 2>&1; then
    jq -e '.ok == true and (.summary | type == "object") and (.recent_operations | type == "array")' >/dev/null
  else
    python3 -c '
import json
import sys

data = json.load(sys.stdin)
if not (data.get("ok") is True and isinstance(data.get("summary"), dict) and isinstance(data.get("recent_operations"), list)):
    raise SystemExit(1)
'
  fi
}

echo "[smoke:dashboard] Checking dashboard summary..."
summary_response="$(curl -fsS "$BASE_URL/v1/dashboard/summary" -H "Authorization: Bearer $API_TOKEN")"
printf '%s\n' "$summary_response" | print_json
printf '%s\n' "$summary_response" | assert_dashboard_summary

echo "[smoke:dashboard] OK"
