#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
BASE44_ORIGIN="${BASE44_ORIGIN:-https://tcwa3-galaxy-map.base44.app}"
RANDOM_ORIGIN="${RANDOM_ORIGIN:-https://not-base44.example.invalid}"

normalize_headers() {
  tr -d '\r'
}

header_value() {
  local header="$1"

  awk -F': ' -v header="$header" 'tolower($1) == tolower(header) { print $2; exit }'
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "[smoke:cors] Expected $label to be '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"

  if [[ "$haystack" != *"$needle"* ]]; then
    echo "[smoke:cors] Expected $label to contain '$needle', got '$haystack'" >&2
    exit 1
  fi
}

assert_empty() {
  local actual="$1"
  local label="$2"

  if [[ -n "$actual" ]]; then
    echo "[smoke:cors] Expected $label to be absent, got '$actual'" >&2
    exit 1
  fi
}

echo "[smoke:cors] Checking Base44 preflight..."
preflight_headers="$(
  curl -sS -D - -o /dev/null -X OPTIONS "$BASE_URL/v1/me" \
    -H "Origin: $BASE44_ORIGIN" \
    -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: Authorization, Content-Type, X-CSRF-Token" | normalize_headers
)"
assert_eq "$BASE44_ORIGIN" "$(printf "%s\n" "$preflight_headers" | header_value "access-control-allow-origin")" "preflight allow-origin"
assert_eq "true" "$(printf "%s\n" "$preflight_headers" | header_value "access-control-allow-credentials")" "preflight allow-credentials"
allow_headers="$(printf "%s\n" "$preflight_headers" | header_value "access-control-allow-headers")"
assert_contains "$allow_headers" "Authorization" "preflight allow-headers"
assert_contains "$allow_headers" "Content-Type" "preflight allow-headers"
assert_contains "$allow_headers" "X-CSRF-Token" "preflight allow-headers"

echo "[smoke:cors] Checking Base44 simple request..."
health_headers="$(
  curl -fsS -D - -o /dev/null "$BASE_URL/health" \
    -H "Origin: $BASE44_ORIGIN" | normalize_headers
)"
assert_eq "$BASE44_ORIGIN" "$(printf "%s\n" "$health_headers" | header_value "access-control-allow-origin")" "health allow-origin"
assert_eq "true" "$(printf "%s\n" "$health_headers" | header_value "access-control-allow-credentials")" "health allow-credentials"

echo "[smoke:cors] Checking random origin is not allowed..."
random_headers="$(
  curl -sS -D - -o /dev/null -X OPTIONS "$BASE_URL/v1/me" \
    -H "Origin: $RANDOM_ORIGIN" \
    -H "Access-Control-Request-Method: GET" \
    -H "Access-Control-Request-Headers: Authorization, Content-Type" | normalize_headers
)"
assert_empty "$(printf "%s\n" "$random_headers" | header_value "access-control-allow-origin")" "random origin allow-origin"

echo "[smoke:cors] OK origin=$BASE44_ORIGIN"
