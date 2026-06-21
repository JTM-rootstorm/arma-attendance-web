#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="smoke:xp-award-on-finish"
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
SERVER_KEY="${SERVER_KEY:-xp-award-smoke}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
TMP_DIR="$(mktemp -d)"
JSON_HELPER="$ROOT/scripts/lib/smoke-json.mjs"

# shellcheck disable=SC1091
source "$ROOT/scripts/lib/smoke-env.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/smoke-db.sh"
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/operation-payloads.sh"

cleanup() {
  rm -rf "$TMP_DIR"
  smoke_cleanup_xp_data "$STAMP" "xp-award-smoke-$STAMP%" "$SERVER_KEY-$STAMP-%" "%$STAMP%"
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

broad_match="XP Smoke $STAMP"
specific_match="XP Smoke Specific Mission $STAMP"
mission_name="TCWA3 $specific_match"
no_match_mission="Unrewarded XP Smoke Mission $STAMP"
operation_mission_uid="xp-award-smoke-$STAMP"
no_match_mission_uid="xp-award-smoke-no-match-$STAMP"
start_request_id="$SERVER_KEY:$STAMP:start"
finish_request_id="$SERVER_KEY:$STAMP:finish"
finish_retry_request_id="$SERVER_KEY:$STAMP:finish-retry"
no_match_start_request_id="$SERVER_KEY:$STAMP:no-match-start"
no_match_finish_request_id="$SERVER_KEY:$STAMP:no-match-finish"
failed_start_request_id="$SERVER_KEY:$STAMP:failed-start"
failed_finish_request_id="$SERVER_KEY:$STAMP:failed-finish"
player_one_uid="$SERVER_KEY-$STAMP-alpha"
player_two_uid="$SERVER_KEY-$STAMP-bravo"
failed_player_uid="$SERVER_KEY-$STAMP-failed"
players_json="$(two_player_payload_json "$player_one_uid" "XP Award Alpha" "$player_two_uid" "XP Award Bravo")"
player_one_json="$(one_player_payload_json "$player_one_uid" "XP Award Alpha")"
failed_player_json="$(one_player_payload_json "$failed_player_uid" "XP Award Failed")"

echo "[$SCRIPT_NAME] Seeding XP reward tiers..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v broad_match="$broad_match" \
  -v specific_match="$specific_match" <<'SQL'
INSERT INTO xp_reward_tiers (mission_name_match, xp_amount)
VALUES (:'broad_match', 5), (:'specific_match', 25);
SQL

echo "[$SCRIPT_NAME] Starting matching operation..."
start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(operation_start_payload "$start_request_id" "$SERVER_KEY" "$operation_mission_uid" "$mission_name" "VR")"
)"
printf "%s" "$start_response" | assert_json "data.ok === true && data.operation_id"
operation_id="$(printf "%s" "$start_response" | json_value ".operation_id")"

echo "[$SCRIPT_NAME] Finishing matching operation..."
finish_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(operation_finish_payload "$finish_request_id" "$SERVER_KEY" "$operation_mission_uid" "$mission_name" "VR" "$players_json")"
)"
printf "%s" "$finish_response" |
  assert_json "data.ok === true && data.status === 'finished' && data.outcome === 'success' && data.xp_award?.awarded === true && data.xp_award.award_status === 'awarded' && data.xp_award.xp_amount === 25 && data.xp_award.players_awarded === 2 && data.xp_award.mission_name_match === '$specific_match'"

player_one_xp="$(smoke_sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_one_uid")"
player_two_xp="$(smoke_sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_two_uid")"
ledger_count="$(smoke_sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$operation_id")"
smoke_assert_equals "$SCRIPT_NAME" "$player_one_xp" "25" "player one XP after award"
smoke_assert_equals "$SCRIPT_NAME" "$player_two_xp" "25" "player two XP after award"
smoke_assert_equals "$SCRIPT_NAME" "$ledger_count" "2" "ledger row count after award"

echo "[$SCRIPT_NAME] Replaying same finish request..."
curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(operation_finish_payload "$finish_request_id" "$SERVER_KEY" "$operation_mission_uid" "$mission_name" "VR" "$players_json")" |
  assert_json "data.ok === true && data.idempotent === true && data.xp_award?.awarded === true && data.xp_award.award_status === 'awarded' && data.xp_award.players_awarded === 2"

player_one_xp="$(smoke_sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_one_uid")"
ledger_count="$(smoke_sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$operation_id")"
smoke_assert_equals "$SCRIPT_NAME" "$player_one_xp" "25" "player one XP after same request replay"
smoke_assert_equals "$SCRIPT_NAME" "$ledger_count" "2" "ledger row count after same request replay"

echo "[$SCRIPT_NAME] Replaying finish with a different request ID..."
curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(operation_finish_payload "$finish_retry_request_id" "$SERVER_KEY" "$operation_mission_uid" "$mission_name" "VR" "$players_json")" |
  assert_json "data.ok === true && data.idempotent === false && data.xp_award?.awarded === true && data.xp_award.award_status === 'already_awarded' && data.xp_award.players_awarded === 0"

player_two_xp="$(smoke_sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_two_uid")"
ledger_count="$(smoke_sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$operation_id")"
smoke_assert_equals "$SCRIPT_NAME" "$player_two_xp" "25" "player two XP after alternate request replay"
smoke_assert_equals "$SCRIPT_NAME" "$ledger_count" "2" "ledger row count after alternate request replay"

echo "[$SCRIPT_NAME] Starting no-match operation..."
no_match_start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(operation_start_payload "$no_match_start_request_id" "$SERVER_KEY" "$no_match_mission_uid" "$no_match_mission" "VR")"
)"
printf "%s" "$no_match_start_response" | assert_json "data.ok === true && data.operation_id"
no_match_operation_id="$(printf "%s" "$no_match_start_response" | json_value ".operation_id")"

echo "[$SCRIPT_NAME] Finishing no-match operation..."
curl -fsS -X POST "$BASE_URL/v1/operations/$no_match_operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(operation_finish_payload "$no_match_finish_request_id" "$SERVER_KEY" "$no_match_mission_uid" "$no_match_mission" "VR" "$player_one_json")" |
  assert_json "data.ok === true && data.xp_award?.awarded === false && data.xp_award.reason === 'no_matching_tier'"

player_one_xp="$(smoke_sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_one_uid")"
no_match_ledger_count="$(smoke_sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$no_match_operation_id")"
smoke_assert_equals "$SCRIPT_NAME" "$player_one_xp" "25" "player one XP after no-match finish"
smoke_assert_equals "$SCRIPT_NAME" "$no_match_ledger_count" "0" "no-match operation ledger row count"

echo "[$SCRIPT_NAME] Starting failed-outcome operation..."
failed_start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$(operation_start_payload "$failed_start_request_id" "$SERVER_KEY" "$SERVER_KEY-$STAMP-failed" "$mission_name" "VR")"
)"
printf "%s" "$failed_start_response" | assert_json "data.ok === true && data.operation_id"
failed_operation_id="$(printf "%s" "$failed_start_response" | json_value ".operation_id")"

echo "[$SCRIPT_NAME] Finishing failed-outcome operation..."
curl -fsS -X POST "$BASE_URL/v1/operations/$failed_operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "$(operation_finish_payload "$failed_finish_request_id" "$SERVER_KEY" "$SERVER_KEY-$STAMP-failed" "$mission_name" "VR" "$failed_player_json" "failed")" |
  assert_json "data.ok === true && data.status === 'failed' && data.outcome === 'failed' && data.xp_award?.awarded === false && data.xp_award.reason === 'operation_failed'"

failed_player_xp="$(smoke_sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$failed_player_uid")"
failed_ledger_count="$(smoke_sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$failed_operation_id")"
smoke_assert_equals "$SCRIPT_NAME" "$failed_player_xp" "0" "failed-outcome player XP"
smoke_assert_equals "$SCRIPT_NAME" "$failed_ledger_count" "0" "failed-outcome operation ledger row count"

echo "[$SCRIPT_NAME] Checking public player leaderboard stays XP-free..."
curl -fsS "$BASE_URL/public/leaderboard/players" |
  assert_json "data.ok === true && data.leaderboard.every((row) => !Object.keys(row).some((key) => ['xp_total', 'xp', 'experience'].includes(key)))"

echo "[$SCRIPT_NAME] Checking players CSV headers stay XP-free..."
curl -fsS "$BASE_URL/v1/players.csv?q=$STAMP&limit=20" \
  -H "Authorization: Bearer $API_TOKEN" \
  -o "$TMP_DIR/players.csv"

csv_header="$(head -n 1 "$TMP_DIR/players.csv")"
if printf "%s" "$csv_header" | grep -Eiq '(^|,)(xp_total|xp|experience)(,|$)'; then
  echo "[$SCRIPT_NAME] players.csv exposed an XP-like header: $csv_header" >&2
  exit 1
fi

echo "[$SCRIPT_NAME] OK"
