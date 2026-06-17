#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
STAMP="$(date +%Y%m%d%H%M%S)"
API_TOKEN="${API_TOKEN:-dev-token}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
OWNER_COOKIE_JAR="$(mktemp)"
TCW_COOKIE_JAR="$(mktemp)"
ADMIN_COOKIE_JAR="$(mktemp)"
OFFICER_COOKIE_JAR="$(mktemp)"
USER_COOKIE_JAR="$(mktemp)"
DEFAULT_COOKIE_JAR="$(mktemp)"
DELETE_COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "$OWNER_COOKIE_JAR" "$TCW_COOKIE_JAR" "$ADMIN_COOKIE_JAR" "$OFFICER_COOKIE_JAR" "$USER_COOKIE_JAR" "$DEFAULT_COOKIE_JAR" "$DELETE_COOKIE_JAR"
}

trap cleanup EXIT

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
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
  process.exit(1);
}
' "$expression"
}

assert_status() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "[smoke:rbac] Expected $label to return $expected, got $actual" >&2
    exit 1
  fi
}

assert_sql_value() {
  local expected="$1"
  local sql="$2"
  local label="$3"
  local actual

  actual="$(psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -c "$sql")"
  if [[ "$actual" != "$expected" ]]; then
    echo "[smoke:rbac] Expected $label to be $expected, got $actual" >&2
    exit 1
  fi
}

login_user() {
  local cookie_jar="$1"
  local discord_id="$2"
  local display_name="$3"

  curl -fsS -c "$cookie_jar" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{\"provider_user_id\":\"$discord_id\",\"display_name\":\"$display_name\"}" | json_value ".user_id"
}

csrf_token() {
  local cookie_jar="$1"

  curl -fsS -b "$cookie_jar" "$BASE_URL/auth/csrf" | json_value ".csrf_token"
}

require_database_url() {
  if [[ -z "${DATABASE_URL:-}" ]]; then
    echo "[smoke:rbac] DATABASE_URL is required." >&2
    exit 1
  fi
}

require_database_url

owner_discord="rbac-owner-$STAMP"
tcw_discord="rbac-tcw-$STAMP"
admin_discord="rbac-admin-$STAMP"
officer_discord="rbac-officer-$STAMP"
user_discord="rbac-user-$STAMP"
default_discord="rbac-default-$STAMP"
delete_discord="rbac-delete-$STAMP"
steam_id="7656119$STAMP"
officer_steam_id="7656116$STAMP"
default_steam_id="7656118$STAMP"
delete_steam_id="7656117$STAMP"
server_key="rbac-smoke-$STAMP"
delete_server_key="rbac-delete-$STAMP"

echo "[smoke:rbac] Creating test sessions..."
owner_id="$(login_user "$OWNER_COOKIE_JAR" "$owner_discord" "RBAC Smoke Owner")"
tcw_id="$(login_user "$TCW_COOKIE_JAR" "$tcw_discord" "RBAC Smoke TCW Admin")"
admin_id="$(login_user "$ADMIN_COOKIE_JAR" "$admin_discord" "RBAC Smoke Unit Admin")"
officer_id="$(login_user "$OFFICER_COOKIE_JAR" "$officer_discord" "RBAC Smoke Officer")"
user_id="$(login_user "$USER_COOKIE_JAR" "$user_discord" "RBAC Smoke Player")"
login_user "$DEFAULT_COOKIE_JAR" "$default_discord" "RBAC Steam Default" >/dev/null
delete_id="$(login_user "$DELETE_COOKIE_JAR" "$delete_discord" "RBAC Delete Player")"

echo "[smoke:rbac] Seeding roles, memberships, player, and operation..."
pnpm admin:grant -- --provider discord --provider-user-id "$owner_discord" --role owner >/dev/null
pnpm admin:grant -- --provider discord --provider-user-id "$tcw_discord" --role tcw_admin >/dev/null
pnpm admin:grant -- --provider discord --provider-user-id "$user_discord" --role viewer >/dev/null

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v owner_id="$owner_id" \
  -v tcw_id="$tcw_id" \
  -v admin_id="$admin_id" \
  -v officer_id="$officer_id" \
  -v user_id="$user_id" \
  -v delete_id="$delete_id" \
  -v steam_id="$steam_id" \
  -v officer_steam_id="$officer_steam_id" \
  -v delete_steam_id="$delete_steam_id" \
  -v delete_server_key="$delete_server_key" \
  -v server_key="$server_key" <<'SQL'
WITH unit AS (
  INSERT INTO units (unit_key, name, description)
  VALUES ('rbac_smoke', 'RBAC Smoke Unit', 'Synthetic RBAC test unit')
  ON CONFLICT (unit_key) DO UPDATE SET updated_at = now()
  RETURNING id
),
players_upsert AS (
  INSERT INTO players (player_uid, last_name, raw_last_player)
  VALUES (:'steam_id', 'RBAC Player', '{}'::jsonb)
  ON CONFLICT (player_uid) DO UPDATE SET last_name = EXCLUDED.last_name, updated_at = now()
  RETURNING player_uid
),
officer_player_upsert AS (
  INSERT INTO players (player_uid, last_name, raw_last_player)
  VALUES (:'officer_steam_id', 'RBAC Absent Officer', '{}'::jsonb)
  ON CONFLICT (player_uid) DO UPDATE SET last_name = EXCLUDED.last_name, updated_at = now()
  RETURNING player_uid
),
delete_player_upsert AS (
  INSERT INTO players (player_uid, last_name, raw_last_player)
  VALUES (:'delete_steam_id', 'RBAC Delete Player', '{}'::jsonb)
  ON CONFLICT (player_uid) DO UPDATE SET last_name = EXCLUDED.last_name, deleted_at = NULL, updated_at = now()
  RETURNING player_uid
),
operation AS (
  INSERT INTO operations (unit_id, server_key, status, mission_uid, mission_name, world_name)
  SELECT id, :'server_key', 'finished', 'rbac-secret-mission', 'RBAC Smoke Operation', 'Altis'
  FROM unit
  RETURNING id
),
delete_operation AS (
  INSERT INTO operations (unit_id, server_key, status, mission_uid, mission_name, world_name)
  SELECT id, :'delete_server_key', 'finished', 'rbac-delete-mission', 'RBAC Delete Operation', 'Altis'
  FROM unit
  RETURNING id
)
INSERT INTO unit_memberships (unit_id, user_id, role, grant_source)
SELECT id, :'tcw_id'::uuid, 'admin', 'smoke' FROM unit
ON CONFLICT DO NOTHING;

INSERT INTO unit_user_roles (unit_id, user_id, role, grant_source)
SELECT id, :'tcw_id'::uuid, 'tcw_admin', 'smoke' FROM units WHERE unit_key = 'rbac_smoke'
ON CONFLICT DO NOTHING;

INSERT INTO unit_memberships (unit_id, user_id, role, grant_source)
SELECT id, :'admin_id'::uuid, 'admin', 'smoke' FROM units WHERE unit_key = 'rbac_smoke'
ON CONFLICT DO NOTHING;

INSERT INTO unit_user_roles (unit_id, user_id, role, grant_source)
SELECT id, :'admin_id'::uuid, 'admin', 'smoke' FROM units WHERE unit_key = 'rbac_smoke'
ON CONFLICT DO NOTHING;

INSERT INTO unit_memberships (unit_id, user_id, role, grant_source)
SELECT id, :'officer_id'::uuid, 'officer', 'smoke' FROM units WHERE unit_key = 'rbac_smoke'
ON CONFLICT DO NOTHING;

INSERT INTO unit_user_roles (unit_id, user_id, role, grant_source)
SELECT id, :'officer_id'::uuid, 'officer', 'smoke' FROM units WHERE unit_key = 'rbac_smoke'
ON CONFLICT DO NOTHING;

INSERT INTO unit_players (unit_id, player_uid, rank, roster_name)
SELECT id, :'steam_id', 'PVT', 'RBAC Player' FROM units WHERE unit_key = 'rbac_smoke'
ON CONFLICT (unit_id, player_uid) DO UPDATE SET rank = EXCLUDED.rank, roster_name = EXCLUDED.roster_name;

INSERT INTO unit_players (unit_id, player_uid, rank, roster_name)
SELECT id, :'officer_steam_id', 'LT', 'RBAC Absent Officer' FROM units WHERE unit_key = 'rbac_smoke'
ON CONFLICT (unit_id, player_uid) DO UPDATE SET rank = EXCLUDED.rank, roster_name = EXCLUDED.roster_name;

INSERT INTO unit_players (unit_id, player_uid, rank, roster_name)
SELECT id, :'delete_steam_id', 'PVT', 'RBAC Delete Player' FROM units WHERE unit_key = 'rbac_smoke'
ON CONFLICT (unit_id, player_uid) DO UPDATE SET
  rank = EXCLUDED.rank,
  roster_name = EXCLUDED.roster_name,
  is_active = true,
  roster_status = 'active',
  left_unit_at = NULL,
  updated_at = now();

INSERT INTO unit_memberships (unit_id, user_id, role, grant_source)
SELECT id, :'delete_id'::uuid, 'member', 'smoke' FROM units WHERE unit_key = 'rbac_smoke'
ON CONFLICT DO NOTHING;

INSERT INTO unit_roster_assignments (unit_id, player_uid, billet, sort_order, is_primary, assignment_source, assigned_by_user_id)
SELECT id, :'delete_steam_id', 'trooper', 10, true, 'manual', :'owner_id'::uuid FROM units WHERE unit_key = 'rbac_smoke'
  AND NOT EXISTS (
    SELECT 1
    FROM unit_roster_assignments ura
    WHERE ura.unit_id = units.id
      AND ura.player_uid = :'delete_steam_id'
      AND ura.ended_at IS NULL
      AND ura.is_primary = true
  );

INSERT INTO operation_players (operation_id, player_uid, name_at_start, name_at_end, present_at_start, present_at_end)
SELECT o.id, :'steam_id', 'RBAC Player', 'RBAC Player', true, true
FROM operations o
WHERE o.server_key = :'server_key'
ON CONFLICT (operation_id, player_uid) DO UPDATE SET present_at_end = true;

INSERT INTO operation_players (operation_id, player_uid, name_at_start, name_at_end, present_at_start, present_at_end)
SELECT o.id, :'delete_steam_id', 'RBAC Delete Player', 'RBAC Delete Player', true, true
FROM operations o
WHERE o.server_key = :'delete_server_key'
ON CONFLICT (operation_id, player_uid) DO UPDATE SET present_at_end = true;

INSERT INTO operation_player_stats (
  operation_id,
  player_uid,
  infantry_kills,
  soft_vehicle_kills,
  armor_kills,
  air_kills,
  ai_kills,
  deaths
)
SELECT o.id, :'steam_id', 5, 1, 2, 3, 3, 1
FROM operations o
WHERE o.server_key = :'server_key'
ON CONFLICT (operation_id, player_uid) DO UPDATE SET
  infantry_kills = 5,
  soft_vehicle_kills = 1,
  armor_kills = 2,
  air_kills = 3,
  ai_kills = 3,
  deaths = 1;

INSERT INTO operation_player_stats (
  operation_id,
  player_uid,
  infantry_kills,
  soft_vehicle_kills,
  armor_kills,
  air_kills,
  ai_kills,
  deaths
)
SELECT o.id, :'delete_steam_id', 2, 0, 0, 0, 2, 0
FROM operations o
WHERE o.server_key = :'delete_server_key'
ON CONFLICT (operation_id, player_uid) DO UPDATE SET
  infantry_kills = 2,
  ai_kills = 2,
  deaths = 0;
SQL

curl -fsS -b "$USER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/link-steam" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$USER_COOKIE_JAR")" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"$steam_id\"}" >/dev/null
curl -fsS -b "$OFFICER_COOKIE_JAR" -X POST "$BASE_URL/auth/test/link-steam" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$OFFICER_COOKIE_JAR")" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"$officer_steam_id\"}" >/dev/null
curl -fsS -b "$DEFAULT_COOKIE_JAR" -X POST "$BASE_URL/auth/test/link-steam" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$DEFAULT_COOKIE_JAR")" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"$default_steam_id\"}" >/dev/null
curl -fsS -b "$DELETE_COOKIE_JAR" -X POST "$BASE_URL/auth/test/link-steam" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$DELETE_COOKIE_JAR")" \
  -H "Content-Type: application/json" \
  -d "{\"provider_user_id\":\"$delete_steam_id\"}" >/dev/null

echo "[smoke:rbac] Checking unauthenticated session rejection..."
assert_status "401" "$(curl -sS -o /dev/null -w "%{http_code}" "$BASE_URL/v1/me")" "/v1/me without cookie"

echo "[smoke:rbac] Checking normal user self-only access..."
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/me" | assert_json 'data.ok === true'
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/me/player" | assert_json 'data.ok === true && data.linked_player !== null'
curl -fsS -b "$DEFAULT_COOKIE_JAR" "$BASE_URL/v1/me/player" | assert_json 'data.ok === true && data.linked_player.display_name === "RBAC Steam Default"'
curl -fsS -b "$USER_COOKIE_JAR" -X PATCH "$BASE_URL/v1/me/player" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$USER_COOKIE_JAR")" \
  -H "Content-Type: application/json" \
  -d '{"display_name":"RBAC Callsign"}' | assert_json 'data.ok === true && data.linked_player.display_name === "RBAC Callsign"'
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/me" | assert_json 'data.ok === true && data.user.identities.some((identity) => identity.provider === "discord" && identity.display_name === "RBAC Smoke Player")'
curl -fsS -b "$ADMIN_COOKIE_JAR" -X POST "$BASE_URL/v1/admin/players/$steam_id/reset-name" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$ADMIN_COOKIE_JAR")" | assert_json 'data.ok === true && data.player.last_name === "RBAC Player"'
curl -fsS -b "$USER_COOKIE_JAR" -X PATCH "$BASE_URL/v1/me/player" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$USER_COOKIE_JAR")" \
  -H "Content-Type: application/json" \
  -d '{"display_name":"RBAC Owner Reset"}' | assert_json 'data.ok === true && data.linked_player.display_name === "RBAC Owner Reset"'
curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/admin/players/$steam_id/reset-name" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")" | assert_json 'data.ok === true && data.player.last_name === "RBAC Player"'
operation_id="$(curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/me/operations" | json_value ".operations.0.operation_id")"
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/me/operations" | assert_json 'data.ok === true && data.operations.length <= 5'
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/me/operations/$operation_id" | assert_json 'data.ok === true && data.operation.operation_id !== undefined'
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/me/operation-mates?operation_id=$operation_id" | assert_json 'data.ok === true'
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/operations?server_key=$server_key" | assert_json "data.ok === true && data.operations.length === 1 && data.operations[0].id === '$operation_id'"
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id" | assert_json 'data.ok === true && data.operation.id === null'
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id/summary" | assert_json "data.ok === true && data.operation_id === '$operation_id'"
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id/attendance" | assert_json 'data.ok === true
  && Array.isArray(data.attendance)
  && data.attendance.some((row) => row.player_uid === null && row.scoreboard_stats.infantry_kills === 5 && row.scoreboard_stats.soft_vehicle_kills === 1 && row.scoreboard_stats.armor_kills === 2 && row.scoreboard_stats.air_kills === 3 && row.scoreboard_stats.deaths === 1)'
curl -fsS -b "$OFFICER_COOKIE_JAR" "$BASE_URL/v1/operations?server_key=$server_key" | assert_json 'data.ok === true && data.operations.length === 0'
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$OFFICER_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id")" "same-unit absent player operation detail"
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$OFFICER_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id/summary")" "same-unit absent player operation summary"
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$OFFICER_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id/attendance")" "same-unit absent player operation attendance"
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$ADMIN_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id/attendance.csv")" "same-unit admin absent operation attendance CSV"
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id/attendance" | assert_json "data.ok === true
  && data.attendance.some((row) => row.player_uid === '$steam_id' && row.scoreboard_stats.infantry_kills === 5 && row.scoreboard_stats.soft_vehicle_kills === 1 && row.scoreboard_stats.armor_kills === 2 && row.scoreboard_stats.air_kills === 3 && row.scoreboard_stats.deaths === 1)"
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$ADMIN_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id/attendance")" "same-unit admin absent operation attendance"
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$USER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/operations/$operation_id" -H "Origin: $BASE_URL" -H "X-CSRF-Token: $(csrf_token "$USER_COOKIE_JAR")")" "normal user operation delete"
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$ADMIN_COOKIE_JAR" -X DELETE "$BASE_URL/v1/operations/$operation_id" -H "Origin: $BASE_URL" -H "X-CSRF-Token: $(csrf_token "$ADMIN_COOKIE_JAR")")" "unit admin operation delete"

echo "[smoke:rbac] Checking player delete keeps operation history and removes auth/unit links..."
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$USER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/admin/players/$delete_steam_id" -H "Origin: $BASE_URL" -H "X-CSRF-Token: $(csrf_token "$USER_COOKIE_JAR")")" "normal user player delete"
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$ADMIN_COOKIE_JAR" -X DELETE "$BASE_URL/v1/admin/players/$delete_steam_id" -H "Origin: $BASE_URL" -H "X-CSRF-Token: $(csrf_token "$ADMIN_COOKIE_JAR")")" "unit admin player delete"
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/admin/players/$delete_steam_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")" | assert_json 'data.ok === true && data.deleted === true && data.impact.discord_identities_deleted >= 1 && data.impact.discord_links_deleted >= 1'
assert_status "404" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/players/$delete_steam_id")" "deleted player detail"
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/players?q=$delete_steam_id" | assert_json 'data.ok === true && data.players.length === 0'
assert_status "401" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$DELETE_COOKIE_JAR" "$BASE_URL/v1/me")" "deleted player revoked session"
assert_sql_value "yes" "SELECT CASE WHEN deleted_at IS NOT NULL THEN 'yes' ELSE 'no' END FROM players WHERE player_uid = '$delete_steam_id'" "deleted player soft-delete flag"
assert_sql_value "1" "SELECT COUNT(*)::int FROM operation_players WHERE player_uid = '$delete_steam_id'" "deleted player operation history count"
assert_sql_value "1" "SELECT COUNT(*)::int FROM user_identities WHERE user_id = '$delete_id'::uuid AND provider = 'steam' AND provider_user_id = '$delete_steam_id'" "deleted player retained Steam identity"
assert_sql_value "0" "SELECT COUNT(*)::int FROM user_identities WHERE user_id = '$delete_id'::uuid AND provider = 'discord'" "deleted player Discord identity"
assert_sql_value "0" "SELECT COUNT(*)::int FROM player_discord_links WHERE player_uid = '$delete_steam_id'" "deleted player Discord link"
assert_sql_value "0" "SELECT COUNT(*)::int FROM unit_players WHERE player_uid = '$delete_steam_id' AND is_active = true AND roster_status <> 'inactive'" "deleted player active unit rows"
assert_sql_value "0" "SELECT COUNT(*)::int FROM unit_roster_assignments WHERE player_uid = '$delete_steam_id' AND ended_at IS NULL" "deleted player active roster assignments"

curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/operations/$operation_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")" | assert_json 'data.ok === true && data.operation_id'
assert_status "404" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/operations/$operation_id")" "deleted operation detail"
curl -fsS -b "$USER_COOKIE_JAR" "$BASE_URL/v1/players" | assert_json 'data.ok === true && data.players.some((player) => player.last_name === "RBAC Player" && player.player_uid === null)'
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$USER_COOKIE_JAR" "$BASE_URL/v1/players.csv")" "normal user CSV"

echo "[smoke:rbac] Checking officer read-only access..."
curl -fsS -b "$OFFICER_COOKIE_JAR" "$BASE_URL/v1/players" | assert_json 'data.ok === true && data.players[0].player_uid === null'
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$OFFICER_COOKIE_JAR" "$BASE_URL/v1/players.csv")" "officer CSV"
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$OFFICER_COOKIE_JAR" "$BASE_URL/v1/discord/player-links")" "officer Discord mappings"

echo "[smoke:rbac] Checking unit admin and TCW admin boundaries..."
curl -fsS -b "$ADMIN_COOKIE_JAR" "$BASE_URL/v1/players" | assert_json 'data.ok === true && data.players[0].player_uid === null'
curl -fsS -b "$ADMIN_COOKIE_JAR" "$BASE_URL/v1/players.csv" >/dev/null
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$ADMIN_COOKIE_JAR" "$BASE_URL/v1/owner/api-key")" "unit admin API key"
curl -fsS -b "$TCW_COOKIE_JAR" "$BASE_URL/v1/players" | assert_json 'data.ok === true && data.players[0].player_uid !== null'
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$TCW_COOKIE_JAR" "$BASE_URL/v1/owner/api-key")" "TCW API key"
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$TCW_COOKIE_JAR" "$BASE_URL/v1/system/machine-tokens")" "TCW machine tokens"
assert_status "403" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$TCW_COOKIE_JAR" "$BASE_URL/v1/admin/users")" "TCW global user admin"

echo "[smoke:rbac] Checking owner-only paths and machine-token compatibility..."
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/owner/api-key" | assert_json 'data.ok === true && data.api_key.mutable === false'
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/system/machine-tokens" | assert_json 'data.ok === true && Array.isArray(data.tokens)'
machine_token_response="$(curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/system/machine-tokens" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")" \
  -H "Content-Type: application/json" \
  -d "{\"name\":\"RBAC smoke token $STAMP\",\"token_kind\":\"api\"}")"
machine_token="$(printf "%s" "$machine_token_response" | json_value ".token")"
machine_token_id="$(printf "%s" "$machine_token_response" | json_value ".token_record.id")"
curl -fsS "$BASE_URL/health/db" -H "Authorization: Bearer $machine_token" | assert_json 'data.ok === true'
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/system/machine-tokens/$machine_token_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")" | assert_json 'data.ok === true && data.token_record.id === "'"$machine_token_id"'"'
curl -fsS "$BASE_URL/health/db" -H "Authorization: Bearer $API_TOKEN" | assert_json 'data.ok === true'
owner_delete_response="$(curl -fsS -X POST "$BASE_URL/v1/operations/start" \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d "{\"request_id\":\"rbac-owner-delete-$STAMP\",\"server_key\":\"$server_key-owner-delete\",\"mission\":{\"mission_name\":\"RBAC Owner Delete\",\"world_name\":\"Altis\"}}")"
owner_delete_id="$(printf "%s" "$owner_delete_response" | json_value ".operation_id")"
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/operations/$owner_delete_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")" | assert_json 'data.ok === true && data.operation_deleted === true && data.ingest_requests_deleted >= 1'
curl -fsS -b "$OWNER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/operations/$owner_delete_id" \
  -H "Origin: $BASE_URL" \
  -H "X-CSRF-Token: $(csrf_token "$OWNER_COOKIE_JAR")" | assert_json 'data.ok === true && data.operation_deleted === false && data.ingest_requests_deleted === 0'
assert_status "404" "$(curl -sS -o /dev/null -w "%{http_code}" -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/operations/$owner_delete_id")" "owner deleted operation detail"

echo "[smoke:rbac] OK"
