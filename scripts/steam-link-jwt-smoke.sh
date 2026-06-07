#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
RETURN_TO="${STEAM_LINK_RETURN_TO:-https://tcwa3-galaxy-map.base44.app/ArmaStats}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "$COOKIE_JAR"
}

trap cleanup EXIT

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[smoke:steam-link-jwt] DATABASE_URL is required." >&2
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

assert_status() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "[smoke:steam-link-jwt] Expected $label to return $expected, got $actual" >&2
    exit 1
  fi
}

header_value() {
  local header="$1"

  awk -F': ' -v header="$header" 'tolower($1) == tolower(header) { print $2; exit }'
}

url_param() {
  local url="$1"
  local param="$2"

  node -e '
const url = new URL(process.argv[1]);
console.log(url.searchParams.get(process.argv[2]) ?? "");
' "$url" "$param"
}

csrf_token() {
  curl -fsS -b "$COOKIE_JAR" "$BASE_URL/auth/csrf" | json_value ".csrf_token"
}

echo "[smoke:steam-link-jwt] Creating test login session..."
login_response="$(
  curl -fsS -c "$COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{\"provider_user_id\":\"steam-link-jwt-$STAMP\",\"display_name\":\"Steam Link JWT Smoke\"}"
)"
printf "%s\n" "$login_response" | assert_json "data.ok === true"

echo "[smoke:steam-link-jwt] Creating JWT handoff..."
handoff_response="$(
  curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/auth/test/jwt-handoff" \
    -H "Origin: $BASE_URL" \
    -H "X-CSRF-Token: $(csrf_token)" \
    -H "Content-Type: application/json" \
    -d "{\"return_to\":\"$RETURN_TO\"}"
)"
handoff_code="$(printf "%s\n" "$handoff_response" | json_value ".handoff_code")"

echo "[smoke:steam-link-jwt] Exchanging JWT handoff..."
exchange_response="$(
  curl -fsS -X POST "$BASE_URL/auth/jwt/exchange" \
    -H "Content-Type: application/json" \
    -d "{\"handoff_code\":\"$handoff_code\"}"
)"
access_token="$(printf "%s\n" "$exchange_response" | json_value ".access_token")"

if [[ -z "$access_token" ]]; then
  echo "[smoke:steam-link-jwt] Missing access token." >&2
  exit 1
fi

echo "[smoke:steam-link-jwt] Creating Steam link ticket with bearer JWT..."
ticket_response="$(
  curl -fsS -X POST "$BASE_URL/auth/steam/link-ticket" \
    -H "Authorization: Bearer $access_token" \
    -H "Content-Type: application/json" \
    -d "{\"return_to\":\"$RETURN_TO\"}"
)"
printf "%s\n" "$ticket_response" | assert_json "data.ok === true && data.steam_start_url.includes('/auth/steam/start-ticket?ticket=')"
steam_start_url="$(printf "%s\n" "$ticket_response" | json_value ".steam_start_url")"

echo "[smoke:steam-link-jwt] Consuming Steam link ticket..."
start_headers="$(curl -sS -D - -o /dev/null "$steam_start_url" | tr -d '\r')"
steam_location="$(printf "%s\n" "$start_headers" | header_value "location")"
printf "%s\n" "{\"location\":\"$steam_location\"}" | assert_json "data.location.includes('https://steamcommunity.com/openid/login')"
steam_return_to="$(url_param "$steam_location" "openid.return_to")"
steam_state="$(url_param "$steam_return_to" "state")"
state_redirect="$(
  psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 -v state="$steam_state" <<'SQL'
SELECT COALESCE(redirect_after, '')
FROM oauth_states
WHERE state = :'state';
SQL
)"

if [[ "$state_redirect" != "$RETURN_TO" ]]; then
  echo "[smoke:steam-link-jwt] Expected OAuth state return_to $RETURN_TO, got $state_redirect" >&2
  exit 1
fi

reuse_status="$(curl -sS -o /dev/null -w "%{http_code}" "$steam_start_url")"
assert_status "400" "$reuse_status" "reused Steam link ticket"

echo "[smoke:steam-link-jwt] Checking expired Steam link ticket..."
expired_ticket_response="$(
  curl -fsS -X POST "$BASE_URL/auth/steam/link-ticket" \
    -H "Authorization: Bearer $access_token" \
    -H "Content-Type: application/json" \
    -d "{\"return_to\":\"$RETURN_TO\"}"
)"
expired_start_url="$(printf "%s\n" "$expired_ticket_response" | json_value ".steam_start_url")"
expired_ticket="$(url_param "$expired_start_url" "ticket")"
expired_ticket_hash="$(node -e 'console.log(require("crypto").createHash("sha256").update(process.argv[1]).digest("hex"))' "$expired_ticket")"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v ticket_hash="$expired_ticket_hash" <<'SQL' >/dev/null
UPDATE auth_link_tickets
SET expires_at = now() - interval '1 second'
WHERE ticket_hash = :'ticket_hash';
SQL
expired_status="$(curl -sS -o /dev/null -w "%{http_code}" "$expired_start_url")"
assert_status "400" "$expired_status" "expired Steam link ticket"

echo "[smoke:steam-link-jwt] Checking test-linked Steam identity and self-heal..."
steam_id="7656119$STAMP"
curl -fsS -X POST "$BASE_URL/auth/test/link-steam" \
  -H "Authorization: Bearer $access_token" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"$steam_id\"}" | assert_json "data.ok === true"

me_response="$(curl -fsS "$BASE_URL/v1/me" -H "Authorization: Bearer $access_token")"
printf "%s\n" "$me_response" | assert_json "data.ok === true && data.user.steam_linked === true && data.user.linked_identities.steam.steam_id === '$steam_id'"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v steam_id="$steam_id" <<'SQL' >/dev/null
DELETE FROM unit_players WHERE player_uid = :'steam_id';
DELETE FROM players WHERE player_uid = :'steam_id' AND raw_last_player->>'source' = 'auth';
SQL

player_response="$(curl -fsS "$BASE_URL/v1/me/player" -H "Authorization: Bearer $access_token")"
printf "%s\n" "$player_response" | assert_json "data.ok === true && data.link_state.steam_linked === true && data.linked_player !== null"

echo "[smoke:steam-link-jwt] OK"
