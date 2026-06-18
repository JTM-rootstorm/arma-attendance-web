#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
OWNER_COOKIE_JAR="$(mktemp)"
TMP_DIR="$(mktemp -d)"

cleanup() {
  rm -f "$OWNER_COOKIE_JAR"
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
  echo "[smoke:xp-rewards] DATABASE_URL is required." >&2
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

assert_status_one_of() {
  local actual="$1"
  local label="$2"
  shift 2

  for expected in "$@"; do
    if [[ "$actual" == "$expected" ]]; then
      return
    fi
  done

  echo "[smoke:xp-rewards] Expected $label to return one of '$*', got '$actual'." >&2
  exit 1
}

csrf_token() {
  curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/auth/csrf" | json_value ".csrf_token"
}

match_name="Geonosis XP Smoke $STAMP"
updated_match_name="Umbara XP Smoke $STAMP"

echo "[smoke:xp-rewards] Checking unauthenticated request is rejected..."
unauth_status="$(curl -sS -o /dev/null -w "%{http_code}" "$BASE_URL/v1/system/xp-reward-tiers")"
assert_status_one_of "$unauth_status" "unauthenticated tier list" 401 403

echo "[smoke:xp-rewards] Creating owner session..."
curl -fsS -c "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"xp-rewards-owner-$STAMP\",\"display_name\":\"XP Rewards Smoke Owner\",\"roles\":[\"owner\"]}" |
  assert_json "data.ok === true && data.user_id"

echo "[smoke:xp-rewards] Creating XP reward tier..."
create_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/system/xp-reward-tiers" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token)" \
    -H "Content-Type: application/json" \
    -d "{\"mission_name_match\":\"$match_name\",\"xp_amount\":15}"
)"
printf "%s" "$create_response" |
  assert_json "data.ok === true && data.tier.mission_name_match === '$match_name' && data.tier.xp_amount === 15"
tier_id="$(printf "%s" "$create_response" | json_value ".tier.id")"

echo "[smoke:xp-rewards] Checking list includes created tier..."
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/system/xp-reward-tiers?limit=200" |
  assert_json "data.ok === true && data.tiers.some((tier) => tier.id === '$tier_id' && tier.mission_name_match === '$match_name' && tier.xp_amount === 15)"

echo "[smoke:xp-rewards] Updating XP reward tier..."
curl -fsS -b "$OWNER_COOKIE_JAR" -X PATCH "$BASE_URL/v1/system/xp-reward-tiers/$tier_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" \
  -H "Content-Type: application/json" \
  -d "{\"mission_name_match\":\"$updated_match_name\",\"xp_amount\":25}" |
  assert_json "data.ok === true && data.tier.id === '$tier_id' && data.tier.mission_name_match === '$updated_match_name' && data.tier.xp_amount === 25"

echo "[smoke:xp-rewards] Checking list reflects update..."
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/system/xp-reward-tiers?limit=200" |
  assert_json "data.ok === true && data.tiers.some((tier) => tier.id === '$tier_id' && tier.mission_name_match === '$updated_match_name' && tier.xp_amount === 25)"

echo "[smoke:xp-rewards] Checking duplicate normalized match is rejected..."
duplicate_status="$(
  curl -sS -o "$TMP_DIR/duplicate.json" -w "%{http_code}" -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/system/xp-reward-tiers" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token)" \
    -H "Content-Type: application/json" \
    -d "{\"mission_name_match\":\"  ${updated_match_name,,}  \",\"xp_amount\":30}"
)"
if [[ "$duplicate_status" != "409" ]]; then
  echo "[smoke:xp-rewards] Expected duplicate tier to return HTTP 409, got $duplicate_status." >&2
  cat "$TMP_DIR/duplicate.json" >&2
  exit 1
fi
assert_json "data.ok === false && data.error?.code === 'xp_reward_tier_exists'" < "$TMP_DIR/duplicate.json"

echo "[smoke:xp-rewards] Checking invalid XP amount is rejected..."
invalid_status="$(
  curl -sS -o "$TMP_DIR/invalid.json" -w "%{http_code}" -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/system/xp-reward-tiers" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token)" \
    -H "Content-Type: application/json" \
    -d "{\"mission_name_match\":\"Invalid XP $STAMP\",\"xp_amount\":0}"
)"
if [[ "$invalid_status" != "400" ]]; then
  echo "[smoke:xp-rewards] Expected invalid XP amount to return HTTP 400, got $invalid_status." >&2
  cat "$TMP_DIR/invalid.json" >&2
  exit 1
fi
assert_json "data.ok === false && data.error?.code === 'validation_failed'" < "$TMP_DIR/invalid.json"

echo "[smoke:xp-rewards] Deleting XP reward tier..."
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/system/xp-reward-tiers/$tier_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" |
  assert_json "data.ok === true && data.tier.id === '$tier_id'"

echo "[smoke:xp-rewards] Checking deleted tier is absent..."
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/system/xp-reward-tiers?limit=200" |
  assert_json "data.ok === true && !data.tiers.some((tier) => tier.id === '$tier_id')"

echo "[smoke:xp-rewards] OK"
