#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
OWNER_COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "$OWNER_COOKIE_JAR"
}

trap cleanup EXIT

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

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

assert_json() {
  local expression="$1"

  node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const ok = Function("data", `return (${process.argv[1]});`)(data);
if (!ok) {
  console.error(JSON.stringify(data, null, 2));
  process.exit(1);
}
' "$expression"
}

assert_status_one_of() {
  local actual="$1"
  local label="$2"
  shift 2

  for expected in "$@"; do
    if [[ "$actual" == "$expected" ]]; then
      return
    fi
  done

  echo "[smoke:base44] Expected $label to return one of '$*', got '$actual'" >&2
  exit 1
}

csrf_token() {
  curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/auth/csrf" | json_value ".csrf_token"
}

assert_cookie_attributes() {
  local headers="$1"
  local expected_same_site="${SESSION_SAME_SITE:-Lax}"
  local expected_secure="${SESSION_SECURE:-true}"
  local cookie

  cookie="$(printf "%s\n" "$headers" | tr -d '\r' | awk 'tolower($0) ~ /^set-cookie:/ { print; exit }')"

  if [[ "$cookie" != *"SameSite=$expected_same_site"* ]]; then
    echo "[smoke:base44] Expected Set-Cookie to include SameSite=$expected_same_site, got '$cookie'" >&2
    exit 1
  fi

  if [[ "$expected_secure" == "true" && "$cookie" != *"; Secure"* ]]; then
    echo "[smoke:base44] Expected Set-Cookie to include Secure, got '$cookie'" >&2
    exit 1
  fi
}

echo "[smoke:base44] Creating owner session and checking cookie attributes..."
owner_login_headers="$(
  curl -sS -D - -o /tmp/base44-owner-login-body-"$STAMP".json -c "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{\"provider_user_id\":\"base44-owner-$STAMP\",\"display_name\":\"Base44 Smoke Owner\",\"roles\":[\"owner\"]}"
)"
assert_cookie_attributes "$owner_login_headers"
cat /tmp/base44-owner-login-body-"$STAMP".json | assert_json 'data.ok === true && data.user_id'
rm -f /tmp/base44-owner-login-body-"$STAMP".json

echo "[smoke:base44] Creating Base44 integration token..."
token_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/system/machine-tokens" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token)" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"base44-smoke-$STAMP\",\"token_kind\":\"base44_integration\"}"
)"
printf "%s" "$token_response" | assert_json 'data.ok === true && data.token && data.token_record.token_kind === "base44_integration"'
base44_token="$(printf "%s" "$token_response" | json_value ".token")"
base44_token_id="$(printf "%s" "$token_response" | json_value ".token_record.id")"

echo "[smoke:base44] Checking Base44 token can read leaderboard..."
curl -fsS -H "Authorization: Bearer $base44_token" "$BASE_URL/v1/leaderboard/units" |
  assert_json 'data.ok === true && Array.isArray(data.leaderboard)'

echo "[smoke:base44] Checking Base44 token is denied from owner token management..."
owner_denied_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $base44_token" "$BASE_URL/v1/system/machine-tokens"
)"
assert_status_one_of "$owner_denied_status" "Base44 token owner endpoint" 401 403

echo "[smoke:base44] Revoking Base44 integration token..."
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/system/machine-tokens/$base44_token_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" |
  assert_json 'data.ok === true && data.token_record.is_active === false'

echo "[smoke:base44] Checking revoked token no longer works..."
revoked_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $base44_token" "$BASE_URL/v1/leaderboard/units"
)"
assert_status_one_of "$revoked_status" "revoked Base44 token leaderboard" 401 403

echo "[smoke:base44] OK token_id=$base44_token_id"
