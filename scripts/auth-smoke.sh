#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
STAMP="$(date +%Y%m%d%H%M%S)"
OWNER_DISCORD_ID="${OWNER_DISCORD_ID:-auth-smoke-owner-$STAMP}"
VIEWER_DISCORD_ID="${VIEWER_DISCORD_ID:-auth-smoke-viewer-$STAMP}"
STEAM_ID="${STEAM_ID:-7656119$STAMP}"
OWNER_COOKIE_JAR="$(mktemp)"
VIEWER_COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "$OWNER_COOKIE_JAR" "$VIEWER_COOKIE_JAR"
}

trap cleanup EXIT

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
for part in sys.argv[1].removeprefix(".").split("."):
    if not part:
        continue
    data = data[part]
print(data)
' "$expression"
  fi
}

assert_ok() {
  if command -v jq >/dev/null 2>&1; then
    jq -e '.ok == true' >/dev/null
  else
    python3 -c '
import json
import sys

if json.load(sys.stdin).get("ok") is not True:
    raise SystemExit(1)
'
  fi
}

assert_me_has_role() {
  local role="$1"

  if command -v jq >/dev/null 2>&1; then
    jq -e --arg role "$role" '.ok == true and any(.user.roles[]?; . == $role)' >/dev/null
  else
    python3 -c '
import json
import sys

data = json.load(sys.stdin)
role = sys.argv[1]
if not (data.get("ok") is True and role in data.get("user", {}).get("roles", [])):
    raise SystemExit(1)
' "$role"
  fi
}

csrf_token() {
  local cookie_jar="$1"

  curl -fsS -b "$cookie_jar" "$BASE_URL/auth/csrf" | json_value ".csrf_token"
}

echo "[smoke:auth] Creating fake owner Discord session..."
owner_login_response="$(
  curl -fsS -c "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{
      \"provider_user_id\": \"$OWNER_DISCORD_ID\",
      \"display_name\": \"Auth Smoke Owner\"
    }"
)"
printf '%s\n' "$owner_login_response" | print_json
printf '%s\n' "$owner_login_response" | assert_ok
owner_user_id="$(printf '%s\n' "$owner_login_response" | json_value ".user_id")"

echo "[smoke:auth] Granting owner role via admin CLI..."
pnpm admin:grant -- --provider discord --provider-user-id "$OWNER_DISCORD_ID" --role owner

echo "[smoke:auth] Checking /v1/me owner role..."
me_response="$(curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/me")"
printf '%s\n' "$me_response" | print_json
printf '%s\n' "$me_response" | assert_me_has_role "owner"

echo "[smoke:auth] Creating fake viewer Discord session..."
viewer_login_response="$(
  curl -fsS -c "$VIEWER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{
      \"provider_user_id\": \"$VIEWER_DISCORD_ID\",
      \"display_name\": \"Auth Smoke Viewer\"
    }"
)"
printf '%s\n' "$viewer_login_response" | print_json
printf '%s\n' "$viewer_login_response" | assert_ok
viewer_user_id="$(printf '%s\n' "$viewer_login_response" | json_value ".user_id")"

echo "[smoke:auth] Listing admin users..."
admin_users_response="$(curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/admin/users")"
printf '%s\n' "$admin_users_response" | print_json
printf '%s\n' "$admin_users_response" | assert_ok

echo "[smoke:auth] Granting viewer role through admin API..."
grant_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X PUT "$BASE_URL/v1/admin/users/$viewer_user_id/roles/viewer" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")" \
    -H "Content-Type: application/json" \
    -d '{"reason":"auth smoke"}'
)"
printf '%s\n' "$grant_response" | print_json
printf '%s\n' "$grant_response" | assert_ok

echo "[smoke:auth] Linking fake Steam identity..."
steam_link_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/link-steam" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")" \
    -H "Content-Type: application/json" \
    -d "{\"provider_user_id\":\"$STEAM_ID\"}"
)"
printf '%s\n' "$steam_link_response" | print_json
printf '%s\n' "$steam_link_response" | assert_ok

echo "[smoke:auth] Unlinking fake Steam identity..."
steam_unlink_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/me/identities/steam" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")"
)"
printf '%s\n' "$steam_unlink_response" | print_json
printf '%s\n' "$steam_unlink_response" | assert_ok

echo "[smoke:auth] Logging out and checking session revocation..."
logout_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -c "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/auth/logout" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")"
)"
printf '%s\n' "$logout_response" | print_json
printf '%s\n' "$logout_response" | assert_ok

logout_status="$(curl -sS -o /dev/null -w "%{http_code}" -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/me")"

if [[ "$logout_status" != "401" ]]; then
  echo "[smoke:auth] Expected /v1/me after logout to return 401, got $logout_status" >&2
  exit 1
fi

echo "[smoke:auth] OK owner_user_id=$owner_user_id viewer_user_id=$viewer_user_id"
