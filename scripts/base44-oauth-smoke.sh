#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
BASE44_RETURN_TO="${BASE44_RETURN_TO:-https://tcwa3-galaxy-map.base44.app/}"
MALICIOUS_RETURN_TO="${MALICIOUS_RETURN_TO:-https://evil.example.invalid/}"
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

require_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "[smoke:base44:oauth] DATABASE_URL is required." >&2
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

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"

  if [[ "$haystack" != *"$needle"* ]]; then
    echo "[smoke:base44:oauth] Expected $label to contain '$needle', got '$haystack'" >&2
    exit 1
  fi
}

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "[smoke:base44:oauth] Expected $label to be '$expected', got '$actual'" >&2
    exit 1
  fi
}

assert_cookie_attributes() {
  local headers="$1"
  local expected_same_site="${SESSION_SAME_SITE:-Lax}"
  local expected_secure="${SESSION_SECURE:-true}"
  local cookie

  cookie="$(printf "%s\n" "$headers" | tr -d '\r' | awk 'tolower($0) ~ /^set-cookie:/ { print; exit }')"

  if [[ "$cookie" != *"SameSite=$expected_same_site"* ]]; then
    echo "[smoke:base44:oauth] Expected Set-Cookie to include SameSite=$expected_same_site, got '$cookie'" >&2
    exit 1
  fi

  if [[ "$expected_secure" == "true" && "$cookie" != *"; Secure"* ]]; then
    echo "[smoke:base44:oauth] Expected Set-Cookie to include Secure, got '$cookie'" >&2
    exit 1
  fi
}

oauth_state_redirect_after() {
  local state="$1"

  psql "$DATABASE_URL" -tA -v ON_ERROR_STOP=1 -v state="$state" <<'SQL'
SELECT COALESCE(redirect_after, '')
FROM oauth_states
WHERE state = :'state';
SQL
}

require_database_url

echo "[smoke:base44:oauth] Checking allowed Discord return_to..."
discord_headers="$(
  curl -sS -D - -o /dev/null "$BASE_URL/auth/discord/start?return_to=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$BASE44_RETURN_TO")" | tr -d '\r'
)"
discord_location="$(printf "%s\n" "$discord_headers" | header_value "location")"
assert_contains "$discord_location" "https://discord.com/api/oauth2/authorize" "Discord redirect"
discord_state="$(url_param "$discord_location" "state")"
assert_eq "$BASE44_RETURN_TO" "$(oauth_state_redirect_after "$discord_state")" "allowed Discord redirect_after"

echo "[smoke:base44:oauth] Checking malicious Discord return_to is sanitized..."
bad_discord_headers="$(
  curl -sS -D - -o /dev/null "$BASE_URL/auth/discord/start?return_to=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$MALICIOUS_RETURN_TO")" | tr -d '\r'
)"
bad_discord_location="$(printf "%s\n" "$bad_discord_headers" | header_value "location")"
bad_discord_state="$(url_param "$bad_discord_location" "state")"
assert_eq "/" "$(oauth_state_redirect_after "$bad_discord_state")" "malicious Discord redirect_after"

echo "[smoke:base44:oauth] Creating session and checking cookie attributes..."
test_login_headers="$(
  curl -sS -D - -o /dev/null -c "$COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{\"provider_user_id\":\"base44-oauth-$STAMP\",\"display_name\":\"Base44 OAuth Smoke\"}"
)"
assert_cookie_attributes "$test_login_headers"

echo "[smoke:base44:oauth] Checking allowed Steam return_to..."
steam_headers="$(
  curl -sS -D - -o /dev/null -b "$COOKIE_JAR" "$BASE_URL/auth/steam/start?return_to=$(node -e 'console.log(encodeURIComponent(process.argv[1]))' "$BASE44_RETURN_TO")" | tr -d '\r'
)"
steam_location="$(printf "%s\n" "$steam_headers" | header_value "location")"
assert_contains "$steam_location" "https://steamcommunity.com/openid/login" "Steam redirect"
steam_return_to="$(url_param "$steam_location" "openid.return_to")"
steam_state="$(url_param "$steam_return_to" "state")"
assert_eq "$BASE44_RETURN_TO" "$(oauth_state_redirect_after "$steam_state")" "allowed Steam redirect_after"

echo "[smoke:base44:oauth] OK"
