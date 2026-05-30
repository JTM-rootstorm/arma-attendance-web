#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
RETURN_TO="${JWT_SMOKE_RETURN_TO:-$BASE_URL/jwt-smoke}"
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
    echo "[smoke:jwt-auth] Expected $label to return $expected, got $actual" >&2
    exit 1
  fi
}

assert_ok_json() {
  node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (data.ok !== true) {
  console.error(JSON.stringify(data));
  process.exit(1);
}
'
}

csrf_token() {
  curl -fsS -b "$COOKIE_JAR" "$BASE_URL/auth/csrf" | json_value ".csrf_token"
}

echo "[smoke:jwt-auth] Creating test login session..."
login_response="$(
  curl -fsS -c "$COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{\"provider_user_id\":\"jwt-smoke-$STAMP\",\"display_name\":\"JWT Smoke\"}"
)"
printf "%s\n" "$login_response" | assert_ok_json

echo "[smoke:jwt-auth] Creating one-time handoff code..."
handoff_response="$(
  curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/auth/test/jwt-handoff" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token)" \
    -H "Content-Type: application/json" \
    -d "{\"return_to\":\"$RETURN_TO\"}"
)"
printf "%s\n" "$handoff_response" | assert_ok_json
handoff_code="$(printf "%s\n" "$handoff_response" | json_value ".handoff_code")"

if [[ -z "$handoff_code" ]]; then
  echo "[smoke:jwt-auth] Missing handoff_code." >&2
  exit 1
fi

echo "[smoke:jwt-auth] Exchanging handoff code..."
exchange_response="$(
  curl -fsS -X POST "$BASE_URL/auth/jwt/exchange" \
    -H "Content-Type: application/json" \
    -d "{\"handoff_code\":\"$handoff_code\"}"
)"
printf "%s\n" "$exchange_response" | assert_ok_json
access_token="$(printf "%s\n" "$exchange_response" | json_value ".access_token")"
refresh_token="$(printf "%s\n" "$exchange_response" | json_value ".refresh_token")"

if [[ -z "$access_token" || -z "$refresh_token" ]]; then
  echo "[smoke:jwt-auth] Missing JWT access token or refresh token." >&2
  exit 1
fi

echo "[smoke:jwt-auth] Calling /v1/me with bearer JWT..."
me_response="$(curl -fsS "$BASE_URL/v1/me" -H "Authorization: Bearer $access_token")"
printf "%s\n" "$me_response" | assert_ok_json

echo "[smoke:jwt-auth] Checking one-time handoff reuse fails..."
reuse_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/auth/jwt/exchange" \
    -H "Content-Type: application/json" \
    -d "{\"handoff_code\":\"$handoff_code\"}"
)"
assert_status "401" "$reuse_status" "handoff reuse"

echo "[smoke:jwt-auth] Refreshing token pair..."
refresh_response="$(
  curl -fsS -X POST "$BASE_URL/auth/jwt/refresh" \
    -H "Content-Type: application/json" \
    -d "{\"refresh_token\":\"$refresh_token\"}"
)"
printf "%s\n" "$refresh_response" | assert_ok_json
next_access_token="$(printf "%s\n" "$refresh_response" | json_value ".access_token")"
next_refresh_token="$(printf "%s\n" "$refresh_response" | json_value ".refresh_token")"

if [[ -z "$next_access_token" || -z "$next_refresh_token" || "$next_refresh_token" == "$refresh_token" ]]; then
  echo "[smoke:jwt-auth] Refresh did not rotate tokens." >&2
  exit 1
fi

echo "[smoke:jwt-auth] Checking old refresh token reuse fails..."
old_refresh_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/auth/jwt/refresh" \
    -H "Content-Type: application/json" \
    -d "{\"refresh_token\":\"$refresh_token\"}"
)"
assert_status "401" "$old_refresh_status" "old refresh token reuse"

echo "[smoke:jwt-auth] Checking missing and malformed bearer JWTs fail..."
missing_status="$(curl -sS -o /dev/null -w "%{http_code}" "$BASE_URL/v1/me")"
assert_status "401" "$missing_status" "missing bearer JWT"

malformed_status="$(curl -sS -o /dev/null -w "%{http_code}" "$BASE_URL/v1/me" -H "Authorization: Bearer not-a-jwt")"
assert_status "401" "$malformed_status" "malformed bearer JWT"

echo "[smoke:jwt-auth] Logging out refresh token..."
logout_response="$(
  curl -fsS -X POST "$BASE_URL/auth/jwt/logout" \
    -H "Content-Type: application/json" \
    -d "{\"refresh_token\":\"$next_refresh_token\"}"
)"
printf "%s\n" "$logout_response" | assert_ok_json

echo "[smoke:jwt-auth] OK"
