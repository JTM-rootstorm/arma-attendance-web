#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
SERVER_KEY="${SERVER_KEY:-xp-award-smoke}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -rf "$TMP_DIR"
}

trap cleanup EXIT

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[smoke:xp-award-on-finish] DATABASE_URL is required." >&2
  exit 1
fi

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:xp-award-on-finish] API_TOKEN is required." >&2
  exit 1
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

sql_scalar() {
  local sql="$1"
  shift

  psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 "$@" <<SQL
$sql
SQL
}

assert_equals() {
  local actual="$1"
  local expected="$2"
  local label="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "[smoke:xp-award-on-finish] Expected $label to be '$expected', got '$actual'." >&2
    exit 1
  fi
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
player_one_uid="$SERVER_KEY-$STAMP-alpha"
player_two_uid="$SERVER_KEY-$STAMP-bravo"

echo "[smoke:xp-award-on-finish] Seeding XP reward tiers..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v broad_match="$broad_match" \
  -v specific_match="$specific_match" <<'SQL'
INSERT INTO xp_reward_tiers (mission_name_match, xp_amount)
VALUES (:'broad_match', 5), (:'specific_match', 25);
SQL

echo "[smoke:xp-award-on-finish] Starting matching operation..."
start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$start_request_id\",
      \"server_key\": \"$SERVER_KEY\",
      \"payload_version\": 1,
      \"mission\": {
        \"mission_uid\": \"$operation_mission_uid\",
        \"mission_name\": \"$mission_name\",
        \"world_name\": \"VR\"
      },
      \"players\": []
    }"
)"
printf "%s" "$start_response" | assert_json "data.ok === true && data.operation_id"
operation_id="$(printf "%s" "$start_response" | json_value ".operation_id")"

echo "[smoke:xp-award-on-finish] Finishing matching operation..."
finish_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$finish_request_id\",
      \"server_key\": \"$SERVER_KEY\",
      \"payload_version\": 1,
      \"mission\": {
        \"mission_uid\": \"$operation_mission_uid\",
        \"mission_name\": \"$mission_name\",
        \"world_name\": \"VR\"
      },
      \"players\": [
        {\"player_uid\":\"$player_one_uid\",\"name\":\"XP Award Alpha\"},
        {\"player_uid\":\"$player_two_uid\",\"name\":\"XP Award Bravo\"}
      ]
    }"
)"
printf "%s" "$finish_response" |
  assert_json "data.ok === true && data.xp_award?.awarded === true && data.xp_award.xp_amount === 25 && data.xp_award.players_awarded === 2 && data.xp_award.mission_name_match === '$specific_match'"

player_one_xp="$(sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_one_uid")"
player_two_xp="$(sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_two_uid")"
ledger_count="$(sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$operation_id")"
assert_equals "$player_one_xp" "25" "player one XP after award"
assert_equals "$player_two_xp" "25" "player two XP after award"
assert_equals "$ledger_count" "2" "ledger row count after award"

echo "[smoke:xp-award-on-finish] Replaying same finish request..."
curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"$finish_request_id\",
    \"server_key\": \"$SERVER_KEY\",
    \"payload_version\": 1,
    \"mission\": {
      \"mission_uid\": \"$operation_mission_uid\",
      \"mission_name\": \"$mission_name\",
      \"world_name\": \"VR\"
    },
    \"players\": [
      {\"player_uid\":\"$player_one_uid\",\"name\":\"XP Award Alpha\"},
      {\"player_uid\":\"$player_two_uid\",\"name\":\"XP Award Bravo\"}
    ]
  }" |
  assert_json "data.ok === true && data.idempotent === true && data.xp_award?.awarded === true && data.xp_award.players_awarded === 2"

player_one_xp="$(sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_one_uid")"
ledger_count="$(sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$operation_id")"
assert_equals "$player_one_xp" "25" "player one XP after same request replay"
assert_equals "$ledger_count" "2" "ledger row count after same request replay"

echo "[smoke:xp-award-on-finish] Replaying finish with a different request ID..."
curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"$finish_retry_request_id\",
    \"server_key\": \"$SERVER_KEY\",
    \"payload_version\": 1,
    \"mission\": {
      \"mission_uid\": \"$operation_mission_uid\",
      \"mission_name\": \"$mission_name\",
      \"world_name\": \"VR\"
    },
    \"players\": [
      {\"player_uid\":\"$player_one_uid\",\"name\":\"XP Award Alpha\"},
      {\"player_uid\":\"$player_two_uid\",\"name\":\"XP Award Bravo\"}
    ]
  }" |
  assert_json "data.ok === true && data.idempotent === false && data.xp_award?.awarded === true && data.xp_award.players_awarded === 0"

player_two_xp="$(sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_two_uid")"
ledger_count="$(sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$operation_id")"
assert_equals "$player_two_xp" "25" "player two XP after alternate request replay"
assert_equals "$ledger_count" "2" "ledger row count after alternate request replay"

echo "[smoke:xp-award-on-finish] Starting no-match operation..."
no_match_start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$no_match_start_request_id\",
      \"server_key\": \"$SERVER_KEY\",
      \"payload_version\": 1,
      \"mission\": {
        \"mission_uid\": \"$no_match_mission_uid\",
        \"mission_name\": \"$no_match_mission\",
        \"world_name\": \"VR\"
      },
      \"players\": []
    }"
)"
printf "%s" "$no_match_start_response" | assert_json "data.ok === true && data.operation_id"
no_match_operation_id="$(printf "%s" "$no_match_start_response" | json_value ".operation_id")"

echo "[smoke:xp-award-on-finish] Finishing no-match operation..."
curl -fsS -X POST "$BASE_URL/v1/operations/$no_match_operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"$no_match_finish_request_id\",
    \"server_key\": \"$SERVER_KEY\",
    \"payload_version\": 1,
    \"mission\": {
      \"mission_uid\": \"$no_match_mission_uid\",
      \"mission_name\": \"$no_match_mission\",
      \"world_name\": \"VR\"
    },
    \"players\": [
      {\"player_uid\":\"$player_one_uid\",\"name\":\"XP Award Alpha\"}
    ]
  }" |
  assert_json "data.ok === true && data.xp_award?.awarded === false && data.xp_award.reason === 'no_matching_tier'"

player_one_xp="$(sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_one_uid")"
no_match_ledger_count="$(sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$no_match_operation_id")"
assert_equals "$player_one_xp" "25" "player one XP after no-match finish"
assert_equals "$no_match_ledger_count" "0" "no-match operation ledger row count"

echo "[smoke:xp-award-on-finish] Checking public player leaderboard stays XP-free..."
curl -fsS "$BASE_URL/public/leaderboard/players" |
  assert_json "data.ok === true && data.leaderboard.every((row) => !Object.keys(row).some((key) => ['xp_total', 'xp', 'experience'].includes(key)))"

echo "[smoke:xp-award-on-finish] Checking players CSV headers stay XP-free..."
curl -fsS "$BASE_URL/v1/players.csv?q=$STAMP&limit=20" \
  -H "Authorization: Bearer $API_TOKEN" \
  -o "$TMP_DIR/players.csv"

csv_header="$(head -n 1 "$TMP_DIR/players.csv")"
if printf "%s" "$csv_header" | grep -Eiq '(^|,)(xp_total|xp|experience)(,|$)'; then
  echo "[smoke:xp-award-on-finish] players.csv exposed an XP-like header: $csv_header" >&2
  exit 1
fi

echo "[smoke:xp-award-on-finish] OK"
