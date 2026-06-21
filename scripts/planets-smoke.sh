#!/usr/bin/env bash
set -euo pipefail

SCRIPT_NAME="smoke:planets"
BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
OWNER_COOKIE_JAR="$(mktemp)"
TMP_DIR="$(mktemp -d)"
JSON_HELPER="$ROOT/scripts/lib/smoke-json.mjs"

# shellcheck disable=SC1091
source "$ROOT/scripts/lib/smoke-env.sh"

cleanup() {
  rm -f "$OWNER_COOKIE_JAR"
  rm -rf "$TMP_DIR"
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
      -v planet_slug="planet-smoke-$STAMP" \
      -v match_name="Planet Smoke Mission $STAMP" >/dev/null 2>&1 <<'SQL' || true
DELETE FROM xp_reward_tiers WHERE mission_name_match = :'match_name';
DELETE FROM planets WHERE slug = :'planet_slug';
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

csrf_token() {
  curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/auth/csrf" | json_value ".csrf_token"
}

planet_slug="planet-smoke-$STAMP"
planet_name="Planet Smoke $STAMP"
match_name="Planet Smoke Mission $STAMP"

echo "[$SCRIPT_NAME] Checking public planet list is anonymous..."
curl -fsS "$BASE_URL/public/planets" |
  assert_json "data.ok === true && Array.isArray(data.planets)"

echo "[$SCRIPT_NAME] Checking owner planet list rejects anonymous access..."
owner_status="$(curl -sS -o /dev/null -w "%{http_code}" "$BASE_URL/v1/system/planets")"
if [[ "$owner_status" != "401" && "$owner_status" != "403" ]]; then
  echo "[$SCRIPT_NAME] Expected owner planet list to reject anonymous access, got HTTP $owner_status." >&2
  exit 1
fi

echo "[$SCRIPT_NAME] Creating owner session..."
curl -fsS -c "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"planet-owner-$STAMP\",\"display_name\":\"Planet Smoke Owner\",\"roles\":[\"owner\"]}" |
  assert_json "data.ok === true && data.user_id"

echo "[$SCRIPT_NAME] Creating planet..."
create_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/system/planets" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token)" \
    -H "Content-Type: application/json" \
    -d "{\"slug\":\"$planet_slug\",\"name\":\"$planet_name\",\"description\":\"Smoke theater\",\"completion_percent\":\"42.375\",\"display_order\":9,\"is_active\":true}"
)"
printf "%s" "$create_response" |
  assert_json "data.ok === true && data.planet.slug === '$planet_slug' && data.planet.completion_percent === '42.375' && data.planet.is_active === true"
planet_id="$(printf "%s" "$create_response" | json_value ".planet.id")"

echo "[$SCRIPT_NAME] Checking owner and public reads..."
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/system/planets?include_inactive=true&limit=200" |
  assert_json "data.ok === true && data.planets.some((planet) => planet.id === '$planet_id' && planet.slug === '$planet_slug')"
curl -fsS "$BASE_URL/public/planets" |
  assert_json "data.ok === true && data.planets.some((planet) => planet.slug === '$planet_slug' && planet.completion_percent === '42.375')"
curl -fsS "$BASE_URL/public/planets/$planet_slug" |
  assert_json "data.ok === true && data.planet.slug === '$planet_slug' && data.planet.completion_percent === '42.375'"

echo "[$SCRIPT_NAME] Creating XP tier with planet target..."
tier_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/system/xp-reward-tiers" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token)" \
    -H "Content-Type: application/json" \
    -d "{\"mission_name_match\":\"$match_name\",\"xp_amount\":10,\"planet_id\":\"$planet_id\",\"planet_progress_percent\":\"1.250\"}"
)"
printf "%s" "$tier_response" |
  assert_json "data.ok === true && data.tier.planet_id === '$planet_id' && data.tier.planet_slug === '$planet_slug' && data.tier.planet_progress_percent === '1.250'"
tier_id="$(printf "%s" "$tier_response" | json_value ".tier.id")"

echo "[$SCRIPT_NAME] Updating planet and checking inactive public visibility..."
curl -fsS -b "$OWNER_COOKIE_JAR" -X PATCH "$BASE_URL/v1/system/planets/$planet_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" \
  -H "Content-Type: application/json" \
  -d "{\"completion_percent\":\"55.125\",\"is_active\":false}" |
  assert_json "data.ok === true && data.planet.completion_percent === '55.125' && data.planet.is_active === false"

inactive_public_status="$(curl -sS -o "$TMP_DIR/inactive-public.json" -w "%{http_code}" "$BASE_URL/public/planets/$planet_slug")"
if [[ "$inactive_public_status" != "404" ]]; then
  echo "[$SCRIPT_NAME] Expected inactive public planet to return HTTP 404, got $inactive_public_status." >&2
  cat "$TMP_DIR/inactive-public.json" >&2
  exit 1
fi

echo "[$SCRIPT_NAME] Deleting tier and deactivating planet..."
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/system/xp-reward-tiers/$tier_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" |
  assert_json "data.ok === true && data.tier.id === '$tier_id'"
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/system/planets/$planet_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token)" |
  assert_json "data.ok === true && data.planet.id === '$planet_id' && data.planet.is_active === false"

echo "[$SCRIPT_NAME] OK"
