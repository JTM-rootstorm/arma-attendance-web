#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
SERVER_KEY="${SERVER_KEY:-xp-delete-reversal-smoke}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
OWNER_COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "$OWNER_COOKIE_JAR"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v stamp="$STAMP" >/dev/null 2>&1 <<'SQL' || true
DELETE FROM xp_reward_tiers WHERE mission_name_match LIKE '%XP Delete Reversal Smoke ' || :'stamp' || '%';
DELETE FROM players p
WHERE p.player_uid LIKE 'xp-delete-reversal-smoke-' || :'stamp' || '-%'
  AND NOT EXISTS (SELECT 1 FROM operation_players op WHERE op.player_uid = p.player_uid)
  AND NOT EXISTS (SELECT 1 FROM operation_xp_awards oxa WHERE oxa.player_uid = p.player_uid)
  AND NOT EXISTS (SELECT 1 FROM unit_players up WHERE up.player_uid = p.player_uid);
SQL
  fi
}

trap cleanup EXIT

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[smoke:xp-award-delete-reversal] DATABASE_URL is required." >&2
  exit 1
fi

if [[ -z "$API_TOKEN" ]]; then
  echo "[smoke:xp-award-delete-reversal] API_TOKEN is required." >&2
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
    echo "[smoke:xp-award-delete-reversal] Expected $label to be '$expected', got '$actual'." >&2
    exit 1
  fi
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

echo "[smoke:xp-award-delete-reversal] Creating owner session..."
curl -fsS -c "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"xp-delete-reversal-owner-$STAMP\",\"display_name\":\"XP Delete Reversal Owner\",\"roles\":[\"owner\"]}" |
  assert_json "data.ok === true && data.user_id"

echo "[smoke:xp-award-delete-reversal] Seeding XP reward tier..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v match_name="$match_name" <<'SQL'
INSERT INTO xp_reward_tiers (mission_name_match, xp_amount)
VALUES (:'match_name', 30);
SQL

echo "[smoke:xp-award-delete-reversal] Starting operation..."
start_response="$(
  curl -fsS -X POST "$BASE_URL/v1/operations/start" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "{
      \"request_id\": \"$start_request_id\",
      \"server_key\": \"$SERVER_KEY\",
      \"payload_version\": 1,
      \"mission\": {
        \"mission_uid\": \"$mission_uid\",
        \"mission_name\": \"$mission_name\",
        \"world_name\": \"VR\"
      },
      \"players\": []
    }"
)"
printf "%s" "$start_response" | assert_json "data.ok === true && data.operation_id"
operation_id="$(printf "%s" "$start_response" | json_value ".operation_id")"

echo "[smoke:xp-award-delete-reversal] Finishing operation to award XP..."
curl -fsS -X POST "$BASE_URL/v1/operations/$operation_id/finish" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{
    \"request_id\": \"$finish_request_id\",
    \"server_key\": \"$SERVER_KEY\",
    \"payload_version\": 1,
    \"mission\": {
      \"mission_uid\": \"$mission_uid\",
      \"mission_name\": \"$mission_name\",
      \"world_name\": \"VR\"
    },
    \"players\": [
      {\"player_uid\":\"$player_one_uid\",\"name\":\"XP Delete Alpha\"},
      {\"player_uid\":\"$player_two_uid\",\"name\":\"XP Delete Bravo\"}
    ]
  }" |
  assert_json "data.ok === true && data.xp_award?.awarded === true && data.xp_award.award_status === 'awarded' && data.xp_award.xp_amount === 30 && data.xp_award.players_awarded === 2"

assert_equals "$(sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_one_uid")" "30" "player one XP before delete"
assert_equals "$(sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_two_uid")" "30" "player two XP before delete"
assert_equals "$(sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$operation_id")" "2" "ledger row count before delete"

echo "[smoke:xp-award-delete-reversal] Deleting operation as owner..."
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/operations/$operation_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" |
  assert_json "data.ok === true && data.operation_deleted === true && data.xp_awards_reverted_count === 2 && data.xp_awards_reverted_total === 60"

assert_equals "$(sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_one_uid")" "0" "player one XP after delete"
assert_equals "$(sql_scalar "SELECT xp_total FROM players WHERE player_uid = :'player_uid';" -v player_uid="$player_two_uid")" "0" "player two XP after delete"
assert_equals "$(sql_scalar "SELECT COUNT(*)::int FROM operation_xp_awards WHERE operation_id = :'operation_id';" -v operation_id="$operation_id")" "0" "ledger row count after delete"

assert_equals "$(
  sql_scalar "SELECT COALESCE((details->>'xp_awards_reverted_total')::int, -1) FROM admin_audit_events WHERE action = 'delete_operation' AND details->>'operation_id' = :'operation_id' ORDER BY created_at DESC LIMIT 1;" -v operation_id="$operation_id"
)" "60" "audit XP reverted total"

echo "[smoke:xp-award-delete-reversal] Replaying delete for missing operation..."
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/operations/$operation_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" |
  assert_json "data.ok === true && data.operation_deleted === false && data.ingest_requests_deleted === 0 && data.xp_awards_reverted_count === 0 && data.xp_awards_reverted_total === 0"

echo "[smoke:xp-award-delete-reversal] OK"
