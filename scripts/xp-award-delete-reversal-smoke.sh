#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="smoke:xp-award-delete-reversal"
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
SERVER_KEY="${SERVER_KEY:-xp-delete-reversal-smoke}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
OWNER_COOKIE_JAR="$(mktemp)"
JSON_HELPER="$ROOT/scripts/lib/smoke-json.mjs"

# shellcheck disable=SC1091
source "$ROOT/scripts/lib/smoke-env.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/smoke-db.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/operation-payloads.sh"

cleanup() {
  rm -f "$OWNER_COOKIE_JAR"
  smoke_cleanup_xp_data "$STAMP" "xp-delete-reversal-smoke-$STAMP%" "xp-delete-reversal-smoke-$STAMP-%" "%XP Delete Reversal Smoke $STAMP%"
}

trap cleanup EXIT

smoke_load_env "$ENV_FILE"
smoke_require_env "$SCRIPT_NAME" DATABASE_URL
smoke_require_env "$SCRIPT_NAME" API_TOKEN

json_value() {
  node "$JSON_HELPER" value "$1"
}

assert_json() {
  node "$JSON_HELPER" assert "$1"
}

csrf_token() {
  curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/auth/csrf" | json_value ".csrf_token"
}

match_name="XP Delete Reversal Smoke $STAMP"
mission_uid="xp-delete-reversal-smoke-$STAMP"
mission_name="TCWA3 $match_name"
start_request_id="$SERVER_KEY:$STAMP:start"
finish_request_id="$SERVER_KEY:$STAMP:finish"
player_one_uid="xp-delete-reversal-smoke-$STAMP-alpha"
player_two_uid="xp-delete-reversal-smoke-$STAMP-bravo"
players_json="$(two_player_payload_json "$player_one_uid" "XP Delete Alpha" "$player_two_uid" "XP Delete Bravo")"

echo "[$SCRIPT_NAME] Creating owner session..."
curl -fsS -c "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"xp-delete-reversal-owner-$STAMP\",\"display_name\":\"XP Delete Reversal Owner\",\"roles\":[\"owner\"]}" |
  assert_json "data.ok === true && data.user_id"

echo "[$SCRIPT_NAME] Seeding XP reward tier..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v match_name="$match_name" <<'SQL'
INSERT INTO xp_reward_tiers (mission_name_match, xp_amount)
VALUES (:'match_name', 30);
SQL

echo "[$SCRIPT_NAME] Starting operation..."
start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(operation_start_payload "$start_request_id" "$SERVER_KEY" "$mission_uid" "$mission_name" "VR")"
)"
printf "%s" "$start_response" | assert_json "data.ok === true && data.operation_id"
operation_id="$(printf "%s" "$start_response" | json_value ".operation_id")"

echo "[$SCRIPT_NAME] Finishing operation to award XP..."
curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(operation_finish_payload "$finish_request_id" "$SERVER_KEY" "$mission_uid" "$mission_name" "VR" "$players_json")" |
  assert_json "data.ok === true && data.xp_award?.awarded === true && data.xp_award.award_status === 'awarded' && data.xp_award.xp_amount === 30 && data.xp_award.players_awarded === 2"

smoke_assert_equals "$SCRIPT_NAME" "$(smoke_sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_one_uid")" "30" "player one XP before delete"
smoke_assert_equals "$SCRIPT_NAME" "$(smoke_sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_two_uid")" "30" "player two XP before delete"
smoke_assert_equals "$SCRIPT_NAME" "$(smoke_sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$operation_id")" "2" "ledger row count before delete"

echo "[$SCRIPT_NAME] Deleting operation as owner..."
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/operations/$operation_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" |
  assert_json "data.ok === true && data.operation_deleted === true && data.xp_awards_reverted_count === 2 && data.xp_awards_reverted_total === 60"

smoke_assert_equals "$SCRIPT_NAME" "$(smoke_sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_one_uid")" "0" "player one XP after delete"
smoke_assert_equals "$SCRIPT_NAME" "$(smoke_sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_two_uid")" "0" "player two XP after delete"
smoke_assert_equals "$SCRIPT_NAME" "$(smoke_sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$operation_id")" "0" "ledger row count after delete"
smoke_assert_equals "$SCRIPT_NAME" "$(
  smoke_sql_scalar "SELECT COALESCE((details->>'xp_awards_reverted_total')::int, -1) FROM admin_audit_events WHERE action = 'delete_operation' AND details->>'operation_id' = :'operation_id' ORDER BY created_at DESC LIMIT 1;" -v operation_id="$operation_id"
)" "60" "audit XP reverted total"

echo "[$SCRIPT_NAME] Replaying delete for missing operation..."
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/operations/$operation_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" |
  assert_json "data.ok === true && data.operation_deleted === false && data.ingest_requests_deleted === 0 && data.xp_awards_reverted_count === 0 && data.xp_awards_reverted_total === 0"

echo "[$SCRIPT_NAME] OK"
