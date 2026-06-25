#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="smoke:admin-users-pagination"
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
OWNER_COOKIE_JAR="$(mktemp)"
USER_COOKIE_DIR="$(mktemp -d)"
JSON_HELPER="$ROOT/scripts/lib/smoke-json.mjs"

# shellcheck disable=SC1091
source "$ROOT/scripts/lib/smoke-env.sh"

cleanup() {
  rm -f "$OWNER_COOKIE_JAR"
  rm -rf "$USER_COOKIE_DIR"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v stamp_pattern="admin-pagination-$STAMP-%" >/dev/null 2>&1 <<'SQL' || true
WITH target_users AS (
  SELECT DISTINCT user_id
  FROM user_identities
  WHERE provider_user_id LIKE :'stamp_pattern'
),
deleted_sessions AS (
  DELETE FROM user_sessions us
  USING target_users target
  WHERE us.user_id = target.user_id
  RETURNING us.id
),
deleted_refresh AS (
  DELETE FROM auth_refresh_tokens art
  USING target_users target
  WHERE art.user_id = target.user_id
  RETURNING art.id
),
deleted_roles AS (
  DELETE FROM user_roles ur
  USING target_users target
  WHERE ur.user_id = target.user_id
  RETURNING ur.user_id
),
deleted_identities AS (
  DELETE FROM user_identities ui
  USING target_users target
  WHERE ui.user_id = target.user_id
  RETURNING ui.user_id
)
DELETE FROM app_users au
USING target_users target
WHERE au.id = target.user_id;
SQL
  fi
}

trap cleanup EXIT

smoke_load_env "$ENV_FILE"
smoke_require_env "$SCRIPT_NAME" DATABASE_URL

json_value() {
  node "$JSON_HELPER" value "$1"
}

assert_json() {
  node "$JSON_HELPER" assert "$1"
}

login_user() {
  local cookie_jar="$1"
  local suffix="$2"
  local roles_json="$3"

  curl -fsS -c "$cookie_jar" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{\"provider_user_id\":\"admin-pagination-$STAMP-$suffix\",\"display_name\":\"Admin Pagination Smoke $STAMP $suffix\",\"roles\":$roles_json}" |
    assert_json "data.ok === true && data.user_id"
}

echo "[$SCRIPT_NAME] Creating owner and paginated users..."
login_user "$OWNER_COOKIE_JAR" "owner" '["owner"]'
login_user "$USER_COOKIE_DIR/user-1.jar" "user-1" '[]'
login_user "$USER_COOKIE_DIR/user-2.jar" "user-2" '[]'
login_user "$USER_COOKIE_DIR/user-3.jar" "user-3" '[]'

echo "[$SCRIPT_NAME] Checking first admin users page includes total..."
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/admin/users?q=Admin%20Pagination%20Smoke%20$STAMP&limit=2&offset=0" |
  assert_json "data.ok === true && data.pagination.limit === 2 && data.pagination.offset === 0 && data.pagination.count === 2 && data.pagination.total === 4 && data.users.length === 2"

echo "[$SCRIPT_NAME] Checking second admin users page..."
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/admin/users?q=Admin%20Pagination%20Smoke%20$STAMP&limit=2&offset=2" |
  assert_json "data.ok === true && data.pagination.limit === 2 && data.pagination.offset === 2 && data.pagination.count === 2 && data.pagination.total === 4 && data.users.length === 2"

echo "[$SCRIPT_NAME] OK"
