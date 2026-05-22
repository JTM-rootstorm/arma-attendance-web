#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"
OWNER_COOKIE_JAR="$(mktemp)"
ADMIN_COOKIE_JAR="$(mktemp)"
MEMBER_COOKIE_JAR="$(mktemp)"

cleanup() {
  rm -f "$OWNER_COOKIE_JAR" "$ADMIN_COOKIE_JAR" "$MEMBER_COOKIE_JAR"
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
    echo "[smoke:battalions] DATABASE_URL is required." >&2
    exit 1
  fi
}

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
    echo "[smoke:battalions] Expected $label to return $expected, got $actual" >&2
    exit 1
  fi
}

login_user() {
  local cookie_jar="$1"
  local discord_id="$2"
  local display_name="$3"
  local roles_json="${4:-[]}"

  curl -fsS -c "$cookie_jar" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{\"provider_user_id\":\"$discord_id\",\"display_name\":\"$display_name\",\"roles\":$roles_json}" | json_value ".user_id"
}

require_database_url

owner_discord="battalion-owner-$STAMP"
admin_discord="battalion-admin-$STAMP"
member_discord="battalion-member-$STAMP"
unit_key="battalion-smoke-$STAMP"
player_one="7656119${STAMP}01"
player_two="7656119${STAMP}02"
player_three="7656119${STAMP}03"
player_four="7656119${STAMP}04"
candidate_player="7656119${STAMP}05"

echo "[smoke:battalions] Creating test sessions..."
owner_id="$(login_user "$OWNER_COOKIE_JAR" "$owner_discord" "Battalion Smoke Owner" '["owner"]')"
admin_id="$(login_user "$ADMIN_COOKIE_JAR" "$admin_discord" "Battalion Smoke Admin")"
member_id="$(login_user "$MEMBER_COOKIE_JAR" "$member_discord" "Battalion Smoke Member")"

echo "[smoke:battalions] Creating battalion..."
unit_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/units" \
    -H "Content-Type: application/json" \
    -d "{
      \"unit_key\":\"$unit_key\",
      \"name\":\"Battalion Smoke $STAMP\",
      \"display_name\":\"Battalion Smoke $STAMP\",
      \"callsign\":\"Smoke\"
    }"
)"
printf "%s" "$unit_response" | assert_json 'data.ok === true && data.unit.id'
unit_id="$(printf "%s" "$unit_response" | json_value ".unit.id")"

echo "[smoke:battalions] Granting unit admin and member role..."
curl -fsS -b "$OWNER_COOKIE_JAR" -X PUT "$BASE_URL/v1/units/$unit_id/admins/$admin_id" \
  -H "Content-Type: application/json" \
  -d '{"role":"admin"}' | assert_json 'data.ok === true && data.role === "admin"'

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v unit_id="$unit_id" \
  -v member_id="$member_id" <<'SQL'
INSERT INTO unit_memberships (unit_id, user_id, role, grant_source)
VALUES (:'unit_id'::uuid, :'member_id'::uuid, 'member', 'smoke')
ON CONFLICT DO NOTHING;
SQL

echo "[smoke:battalions] Creating ranks, roster players, and squad tree..."
rank_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/units/$unit_id/ranks" \
    -H "Content-Type: application/json" \
    -d '{"rank_key":"arc-trooper","name":"ARC Trooper","short_name":"ARC","sort_order":25}'
)"
rank_id="$(printf "%s" "$rank_response" | json_value ".rank.id")"
updated_rank_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/units/$unit_id/ranks" \
    -H "Content-Type: application/json" \
    -d '{"rank_key":"rookie","name":"Rookie","short_name":"RCT","sort_order":5}'
)"
updated_rank_id="$(printf "%s" "$updated_rank_response" | json_value ".rank.id")"

for player in "$player_one" "$player_two" "$player_three" "$player_four"; do
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/units/$unit_id/players" \
    -H "Content-Type: application/json" \
    -d "{\"player_uid\":\"$player\",\"roster_name\":\"Trooper $player\",\"rank_id\":\"$rank_id\",\"roster_status\":\"active\"}" | assert_json 'data.ok === true'
done

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v candidate_player="$candidate_player" <<'SQL'
INSERT INTO players (player_uid, last_name, raw_last_player)
VALUES (:'candidate_player', 'Candidate Trooper', '{}'::jsonb)
ON CONFLICT (player_uid) DO UPDATE SET last_name = EXCLUDED.last_name, updated_at = now();
SQL

curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/units/$unit_id/player-candidates?q=$candidate_player" |
  assert_json "data.ok === true && data.players.some((player) => player.player_uid === '$candidate_player')"

curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/units/$unit_id/players" \
  -H "Content-Type: application/json" \
  -d "{\"player_uid\":\"$candidate_player\",\"roster_name\":\"Candidate Trooper\",\"roster_status\":\"active\"}" | assert_json 'data.ok === true'

squad_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/units/$unit_id/squads" \
    -H "Content-Type: application/json" \
    -d '{"squad_key":"torrent","name":"Torrent Squad","squad_type":"squad","hierarchy_mode":"tree","sort_order":10}'
)"
squad_id="$(printf "%s" "$squad_response" | json_value ".squad.id")"

fireteam_response="$(
  curl -fsS -b "$OWNER_COOKIE_JAR" -X POST "$BASE_URL/v1/units/$unit_id/squads" \
    -H "Content-Type: application/json" \
    -d "{\"parent_squad_id\":\"$squad_id\",\"squad_key\":\"torrent-blue\",\"name\":\"Blue Fireteam\",\"squad_type\":\"fireteam\",\"hierarchy_mode\":\"flat\",\"sort_order\":20}"
)"
fireteam_id="$(printf "%s" "$fireteam_response" | json_value ".squad.id")"

curl -fsS -b "$OWNER_COOKIE_JAR" -X PATCH "$BASE_URL/v1/units/$unit_id/squad-layout" \
  -H "Content-Type: application/json" \
  -d "{
    \"squads\":[
      {\"id\":\"$squad_id\",\"parent_squad_id\":null,\"sort_order\":10},
      {\"id\":\"$fireteam_id\",\"parent_squad_id\":\"$squad_id\",\"sort_order\":20}
    ],
    \"assignments\":[
      {\"player_uid\":\"$player_one\",\"squad_id\":\"$squad_id\",\"billet\":\"squad_lead\",\"sort_order\":10},
      {\"player_uid\":\"$candidate_player\",\"squad_id\":\"$squad_id\",\"billet\":\"squad_lead\",\"sort_order\":15},
      {\"player_uid\":\"$player_two\",\"squad_id\":\"$fireteam_id\",\"billet\":\"fireteam_lead\",\"sort_order\":20},
      {\"player_uid\":\"$player_three\",\"squad_id\":\"$fireteam_id\",\"billet\":\"trooper\",\"sort_order\":30},
      {\"player_uid\":\"$player_four\",\"squad_id\":null,\"billet\":\"unassigned\",\"sort_order\":40}
    ]
  }" | assert_json 'data.ok === true'

echo "[smoke:battalions] Checking roster shape..."
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/units/$unit_id/roster" | assert_json '
  data.ok === true
  && data.unassigned.length >= 1
  && data.squads.some((squad) => squad.name === "Torrent Squad" && squad.leaders.length === 2 && squad.squad_leaders.length === 2 && squad.fireteam_leaders.length === 0 && squad.children.some((child) => child.name === "Blue Fireteam" && child.fireteam_leaders.length === 1))
'

echo "[smoke:battalions] Checking unit admin can update roster..."
curl -fsS -b "$ADMIN_COOKIE_JAR" -X PATCH "$BASE_URL/v1/units/$unit_id/players/$player_three" \
  -H "Content-Type: application/json" \
  -d '{"roster_status":"reserve","notes":"smoke update"}' | assert_json 'data.ok === true && data.player.roster_status === "reserve"'
curl -fsS -b "$ADMIN_COOKIE_JAR" -X PATCH "$BASE_URL/v1/units/$unit_id/players/$player_four" \
  -H "Content-Type: application/json" \
  -d "{\"rank\":null,\"rank_id\":\"$updated_rank_id\"}" | assert_json "data.ok === true && data.player.rank_id === '$updated_rank_id'"
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/units/$unit_id/roster" | assert_json "
  data.ok === true
  && data.unassigned.some((player) => player.player_uid === '$player_four' && player.rank === 'Rookie')
"

echo "[smoke:battalions] Checking member can read but not manage..."
curl -fsS -b "$MEMBER_COOKIE_JAR" "$BASE_URL/v1/units/$unit_id/roster" | assert_json 'data.ok === true'
member_manage_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -b "$MEMBER_COOKIE_JAR" -X POST "$BASE_URL/v1/units/$unit_id/squads" \
    -H "Content-Type: application/json" \
    -d '{"squad_key":"denied","name":"Denied"}'
)"
assert_status "403" "$member_manage_status" "member squad create"
member_delete_status="$(
  curl -sS -o /dev/null -w "%{http_code}" -b "$MEMBER_COOKIE_JAR" -X DELETE "$BASE_URL/v1/units/$unit_id/squads/$fireteam_id"
)"
assert_status "403" "$member_delete_status" "member squad delete"

echo "[smoke:battalions] Checking squad delete unassigns roster players..."
curl -fsS -b "$ADMIN_COOKIE_JAR" -X DELETE "$BASE_URL/v1/units/$unit_id/squads/$fireteam_id" |
  assert_json "data.ok === true && data.deleted_squad_ids.includes('$fireteam_id') && data.unassigned_count >= 2"
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/units/$unit_id/roster" | assert_json "
  data.ok === true
  && !JSON.stringify(data.squads).includes('Blue Fireteam')
  && data.unassigned.some((player) => player.player_uid === '$player_two')
"
recreated_fireteam_response="$(
  curl -fsS -b "$ADMIN_COOKIE_JAR" -X POST "$BASE_URL/v1/units/$unit_id/squads" \
    -H "Content-Type: application/json" \
    -d "{\"parent_squad_id\":\"$squad_id\",\"squad_key\":\"torrent-blue\",\"name\":\"Blue Fireteam\",\"squad_type\":\"fireteam\",\"hierarchy_mode\":\"flat\",\"sort_order\":20}"
)"
recreated_fireteam_id="$(printf "%s" "$recreated_fireteam_response" | json_value ".squad.id")"
if [[ "$recreated_fireteam_id" != "$fireteam_id" ]]; then
  echo "[smoke:battalions] Expected deleted squad key recreation to reactivate $fireteam_id, got $recreated_fireteam_id" >&2
  exit 1
fi
curl -fsS -b "$OWNER_COOKIE_JAR" "$BASE_URL/v1/units/$unit_id/roster" | assert_json '
  data.ok === true
  && data.squads.some((squad) => squad.name === "Torrent Squad" && squad.children.some((child) => child.name === "Blue Fireteam"))
'

echo "[smoke:battalions] OK unit_id=$unit_id owner_id=$owner_id admin_id=$admin_id"
