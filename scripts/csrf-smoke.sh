#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-$BASE_URL}"
BAD_ORIGIN="${BAD_ORIGIN:-https://not-base44.example.invalid}"
API_TOKEN="${API_TOKEN:-dev-token}"
STAMP="$(date +%Y%m%d%H%M%S)"
COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "$COOKIE_JAR"
}

trap cleanup EXIT

json_value() {
  local expression="$1"

  node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
let value = data;
for (const part of process.argv[1].replace(/^\./, "").split(".")) {
  if (!part) continue;
  value = value?.[part];
}
console.log(value ?? "");
' "$expression"
}

assert_status() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "[smoke:csrf] Expected $label to return $expected, got $actual" >&2
    exit 1
  fi
}

assert_not_status() {
  local unexpected="$1"
  local actual="$2"
  local label="$3"

  if [[ "$actual" == "$unexpected" ]]; then
    echo "[smoke:csrf] Expected $label not to return $unexpected" >&2
    exit 1
  fi
}

echo "[smoke:csrf] Creating test session..."
curl -fsS -c "$COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"csrf-smoke-$STAMP\",\"display_name\":\"CSRF Smoke\"}" >/dev/null

echo "[smoke:csrf] Fetching CSRF token..."
csrf_response="$(curl -fsS -b "$COOKIE_JAR" "$BASE_URL/auth/csrf")"
csrf_token="$(printf "%s" "$csrf_response" | json_value ".csrf_token")"

if [[ -z "$csrf_token" ]]; then
  echo "[smoke:csrf] Missing csrf_token from /auth/csrf response." >&2
  exit 1
fi

echo "[smoke:csrf] Checking missing and invalid token failures..."
missing_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X PATCH "$BASE_URL/v1/me/player" \
    -H "Origin: $ALLOWED_ORIGIN" \
    -H "Content-Type: application/json" \
    -d '{"display_name":"No Token"}'
)"
assert_status "403" "$missing_status" "missing CSRF token"

invalid_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X PATCH "$BASE_URL/v1/me/player" \
    -H "Origin: $ALLOWED_ORIGIN" \
    -H "X-CSRF-Token: invalid-token" \
    -H "Content-Type: application/json" \
    -d '{"display_name":"Bad Token"}'
)"
assert_status "403" "$invalid_status" "invalid CSRF token"

echo "[smoke:csrf] Checking valid token clears CSRF gate..."
valid_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X PATCH "$BASE_URL/v1/me/player" \
    -H "Origin: $ALLOWED_ORIGIN" \
    -H "X-CSRF-Token: $csrf_token" \
    -H "Content-Type: application/json" \
    -d '{"display_name":"Good Token"}'
)"
assert_not_status "403" "$valid_status" "valid CSRF token"

echo "[smoke:csrf] Checking bad Origin is blocked..."
bad_origin_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -b "$COOKIE_JAR" -X PATCH "$BASE_URL/v1/me/player" \
    -H "Origin: $BAD_ORIGIN" \
    -H "X-CSRF-Token: $csrf_token" \
    -H "Content-Type: application/json" \
    -d '{"display_name":"Bad Origin"}'
)"
assert_status "403" "$bad_origin_status" "bad Origin"

echo "[smoke:csrf] Checking machine-token request skips CSRF..."
machine_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/debug/poke" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"message":"csrf smoke","server_key":"csrf-smoke"}'
)"
assert_status "200" "$machine_status" "machine-token debug poke"

echo "[smoke:csrf] OK"
