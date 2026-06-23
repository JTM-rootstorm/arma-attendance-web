#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
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
  echo "[smoke:discord-refresh] DATABASE_URL is required." >&2
  exit 1
fi

json_field() {
  local field="$1"

  node -e '
const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
const path = process.argv[1].split(".");
let value = data;
for (const key of path) value = value?.[key];
if (value === undefined || value === null) process.exit(1);
console.log(value);
' "$field"
}

url_param() {
  local url="$1"
  local param="$2"

  node -e '
const url = new URL(process.argv[1]);
console.log(url.searchParams.get(process.argv[2]) ?? "");
' "$url" "$param"
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

assert_eq() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [[ "$actual" != "$expected" ]]; then
    echo "[smoke:discord-refresh] Expected $label to be '$expected', got '$actual'" >&2
    exit 1
  fi
}

sql_scalar() {
  psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 "$@"
}

api_post() {
  local path="$1"
  local body="$2"

  curl -fsS -X POST "$BASE_URL$path" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body"
}

discord_user_id="discord-refresh-$STAMP"
player_uid="discord:$discord_user_id"
primary_guild="refresh-primary-$STAMP"
secondary_guild="refresh-secondary-$STAMP"
primary_role="primary-role-$STAMP"
primary_rank_role="primary-rank-$STAMP"
secondary_role="secondary-role-$STAMP"
secondary_rank_role="secondary-rank-$STAMP"

echo "[smoke:discord-refresh] Creating authenticated test session..."
login_response="$(
  curl -fsS -c "$COOKIE_JAR" -X POST "$BASE_URL/auth/test/login" \
    -H "Content-Type: application/json" \
    -d "{\"provider_user_id\":\"$discord_user_id\",\"display_name\":\"Discord Refresh Smoke\",\"roles\":[\"owner\"]}"
)"
user_id="$(printf "%s" "$login_response" | json_field "user_id")"
csrf_token="$(curl -fsS -b "$COOKIE_JAR" "$BASE_URL/auth/csrf" | json_field "csrf_token")"

echo "[smoke:discord-refresh] Starting refresh OAuth and checking state binding..."
refresh_response="$(
  curl -fsS -b "$COOKIE_JAR" -X POST "$BASE_URL/v1/me/discord/refresh" \
    -H "Content-Type: application/json" \
    -H "X-CSRF-Token: $csrf_token" \
    -d '{"return_to":"/?view=me"}'
)"
refresh_url="$(printf "%s" "$refresh_response" | json_field "discord_refresh_url")"
oauth_state="$(url_param "$refresh_url" "state")"
state_row="$(sql_scalar -v state="$oauth_state" <<'SQL'
SELECT purpose || '|' || COALESCE(user_id::text, '') || '|' || COALESCE(redirect_after, '')
FROM oauth_states
WHERE state = :'state';
SQL
)"
assert_eq "discord_refresh|$user_id|/?view=me" "$state_row" "refresh OAuth state"

echo "[smoke:discord-refresh] Seeding Discord role mappings and snapshots..."
IFS='|' read -r primary_unit_id secondary_unit_id stale_unit_id manual_unit_id < <(
  psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
    -v stamp="$STAMP" \
    -v user_id="$user_id" \
    -v discord_user_id="$discord_user_id" \
    -v player_uid="$player_uid" \
    -v primary_guild="$primary_guild" \
    -v secondary_guild="$secondary_guild" \
    -v primary_role="$primary_role" \
    -v primary_rank_role="$primary_rank_role" \
    -v secondary_role="$secondary_role" \
    -v secondary_rank_role="$secondary_rank_role" <<'SQL'
WITH primary_unit AS (
  INSERT INTO units (unit_key, slug, name, display_name)
  VALUES ('discord-refresh-primary-' || :'stamp', 'discord-refresh-primary-' || :'stamp', 'Discord Refresh Primary', 'Discord Refresh Primary')
  RETURNING id
),
secondary_unit AS (
  INSERT INTO units (unit_key, slug, name, display_name)
  VALUES ('discord-refresh-secondary-' || :'stamp', 'discord-refresh-secondary-' || :'stamp', 'Discord Refresh Secondary', 'Discord Refresh Secondary')
  RETURNING id
),
stale_unit AS (
  INSERT INTO units (unit_key, slug, name, display_name)
  VALUES ('discord-refresh-stale-' || :'stamp', 'discord-refresh-stale-' || :'stamp', 'Discord Refresh Stale', 'Discord Refresh Stale')
  RETURNING id
),
manual_unit AS (
  INSERT INTO units (unit_key, slug, name, display_name)
  VALUES ('discord-refresh-manual-' || :'stamp', 'discord-refresh-manual-' || :'stamp', 'Discord Refresh Manual', 'Discord Refresh Manual')
  RETURNING id
),
primary_rank AS (
  INSERT INTO unit_ranks (unit_id, rank_key, name, sort_order)
  SELECT id, 'sergeant', 'Sergeant', 50 FROM primary_unit
  RETURNING id
),
secondary_rank AS (
  INSERT INTO unit_ranks (unit_id, rank_key, name, sort_order)
  SELECT id, 'corporal', 'Corporal', 40 FROM secondary_unit
  RETURNING id
),
player_seed AS (
  INSERT INTO players (player_uid, last_name, raw_last_player)
  VALUES (:'player_uid', 'Discord Refresh Smoke', '{}'::jsonb)
  ON CONFLICT (player_uid) DO UPDATE SET last_name = EXCLUDED.last_name, updated_at = now()
),
link_seed AS (
  INSERT INTO player_discord_links (player_uid, discord_user_id, discord_display_name, source, verified_at, raw_link)
  VALUES (:'player_uid', :'discord_user_id', 'Discord Refresh Smoke', 'auth', now(), '{}'::jsonb)
  ON CONFLICT (discord_user_id) DO UPDATE
  SET player_uid = EXCLUDED.player_uid, discord_display_name = EXCLUDED.discord_display_name, updated_at = now()
),
guild_seed AS (
  INSERT INTO discord_guilds (guild_id, name, guild_type, grants_login, sync_members, unit_priority, rank_priority, config_order)
  VALUES
    (:'primary_guild', 'Refresh Primary Guild', 'unit', true, true, 100, 100, 10),
    (:'secondary_guild', 'Refresh Secondary Guild', 'unit', true, true, 20, 20, 20)
  ON CONFLICT (guild_id) DO UPDATE
  SET grants_login = EXCLUDED.grants_login,
      sync_members = EXCLUDED.sync_members,
      unit_priority = EXCLUDED.unit_priority,
      rank_priority = EXCLUDED.rank_priority,
      config_order = EXCLUDED.config_order,
      updated_at = now()
),
role_seed AS (
  INSERT INTO discord_roles (guild_id, role_id, name, position)
  VALUES
    (:'primary_guild', :'primary_role', 'Primary Unit', 100),
    (:'primary_guild', :'primary_rank_role', 'Primary Rank', 90),
    (:'secondary_guild', :'secondary_role', 'Secondary Unit', 80),
    (:'secondary_guild', :'secondary_rank_role', 'Secondary Rank', 70)
  ON CONFLICT (guild_id, role_id) DO UPDATE
  SET name = EXCLUDED.name, position = EXCLUDED.position, is_deleted = false, updated_at = now()
),
mapping_seed AS (
  INSERT INTO discord_role_mappings (guild_id, role_id, mapping_type, unit_id, rank_id, priority)
  SELECT :'primary_guild', :'primary_role', 'unit_primary', id, NULL::uuid, 100 FROM primary_unit
  UNION ALL
  SELECT :'primary_guild', :'primary_rank_role', 'rank', pu.id, pr.id, 100 FROM primary_unit pu CROSS JOIN primary_rank pr
  UNION ALL
  SELECT :'secondary_guild', :'secondary_role', 'unit_secondary', id, NULL::uuid, 20 FROM secondary_unit
  UNION ALL
  SELECT :'secondary_guild', :'secondary_rank_role', 'rank', su.id, sr.id, 20 FROM secondary_unit su CROSS JOIN secondary_rank sr
  ON CONFLICT DO NOTHING
),
snapshot_seed AS (
  INSERT INTO discord_member_snapshots (guild_id, discord_user_id, user_id, role_ids, nick, member_payload, source)
  VALUES
    (:'primary_guild', :'discord_user_id', :'user_id', jsonb_build_array(:'primary_role', :'primary_rank_role'), 'Primary Refresh', '{}'::jsonb, 'oauth_refresh'),
    (:'secondary_guild', :'discord_user_id', :'user_id', jsonb_build_array(:'secondary_role', :'secondary_rank_role'), 'Secondary Refresh', '{}'::jsonb, 'oauth_refresh')
  ON CONFLICT (guild_id, discord_user_id) DO UPDATE
  SET role_ids = EXCLUDED.role_ids, source = EXCLUDED.source, updated_at = now(), last_seen_at = now()
),
stale_assignment AS (
  INSERT INTO unit_players (unit_id, player_uid, roster_status, assignment_source, assignment_priority, is_active)
  SELECT id, :'player_uid', 'active', 'discord', 1, true FROM stale_unit
  ON CONFLICT (unit_id, player_uid) DO UPDATE
  SET roster_status = 'active', assignment_source = 'discord', assignment_locked = false, is_active = true, updated_at = now()
),
manual_assignment AS (
  INSERT INTO unit_players (unit_id, player_uid, roster_status, assignment_source, assignment_locked, assignment_priority, is_active)
  SELECT id, :'player_uid', 'active', 'manual', true, 1, true FROM manual_unit
  ON CONFLICT (unit_id, player_uid) DO UPDATE
  SET roster_status = 'active', assignment_source = 'manual', assignment_locked = true, is_active = true, updated_at = now()
)
SELECT
  (SELECT id FROM primary_unit)::text || '|' ||
  (SELECT id FROM secondary_unit)::text || '|' ||
  (SELECT id FROM stale_unit)::text || '|' ||
  (SELECT id FROM manual_unit)::text;
SQL
)

echo "[smoke:discord-refresh] Reconciling primary and secondary memberships..."
api_post "/v1/discord/reconcile" "{\"discord_user_id\":\"$discord_user_id\",\"dry_run\":false}" |
  assert_json "data.ok === true && data.winning_claims.unit_memberships.length === 2 && data.represented_unit_id === '$primary_unit_id'"

active_count="$(sql_scalar -v player_uid="$player_uid" -v primary_unit_id="$primary_unit_id" -v secondary_unit_id="$secondary_unit_id" <<'SQL'
SELECT count(*)
FROM unit_players
WHERE player_uid = :'player_uid'
  AND unit_id IN (:'primary_unit_id'::uuid, :'secondary_unit_id'::uuid)
  AND is_active = true
  AND assignment_source = 'discord';
SQL
)"
assert_eq "2" "$active_count" "active Discord-derived memberships"

stale_active="$(sql_scalar -v player_uid="$player_uid" -v stale_unit_id="$stale_unit_id" <<'SQL'
SELECT count(*)
FROM unit_players
WHERE player_uid = :'player_uid' AND unit_id = :'stale_unit_id'::uuid AND is_active = true;
SQL
)"
assert_eq "0" "$stale_active" "stale Discord assignment"

manual_active="$(sql_scalar -v player_uid="$player_uid" -v manual_unit_id="$manual_unit_id" <<'SQL'
SELECT count(*)
FROM unit_players
WHERE player_uid = :'player_uid'
  AND unit_id = :'manual_unit_id'::uuid
  AND is_active = true
  AND assignment_source = 'manual'
  AND assignment_locked = true;
SQL
)"
assert_eq "1" "$manual_active" "locked manual assignment"

represented_unit="$(sql_scalar -v player_uid="$player_uid" <<'SQL'
SELECT represented_unit_id::text
FROM player_unit_preferences
WHERE player_uid = :'player_uid';
SQL
)"
assert_eq "$primary_unit_id" "$represented_unit" "initial represented unit"

echo "[smoke:discord-refresh] Snapshotting primary guild absence and repairing represented unit..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v primary_guild="$primary_guild" \
  -v discord_user_id="$discord_user_id" <<'SQL' >/dev/null
UPDATE discord_member_snapshots
SET role_ids = '[]'::jsonb,
    nick = NULL,
    joined_at = NULL,
    member_payload = '{"absent":true,"source":"oauth_refresh_absent"}'::jsonb,
    source = 'oauth_refresh_absent',
    last_seen_at = now(),
    updated_at = now()
WHERE guild_id = :'primary_guild'
  AND discord_user_id = :'discord_user_id';
SQL

api_post "/v1/discord/reconcile" "{\"discord_user_id\":\"$discord_user_id\",\"dry_run\":false}" |
  assert_json "data.ok === true && data.winning_claims.unit_memberships.length === 1 && data.represented_unit_id === '$secondary_unit_id'"

primary_active="$(sql_scalar -v player_uid="$player_uid" -v primary_unit_id="$primary_unit_id" <<'SQL'
SELECT count(*)
FROM unit_players
WHERE player_uid = :'player_uid' AND unit_id = :'primary_unit_id'::uuid AND is_active = true;
SQL
)"
assert_eq "0" "$primary_active" "removed primary Discord assignment"

represented_unit="$(sql_scalar -v player_uid="$player_uid" <<'SQL'
SELECT represented_unit_id::text
FROM player_unit_preferences
WHERE player_uid = :'player_uid';
SQL
)"
assert_eq "$secondary_unit_id" "$represented_unit" "repaired represented unit"

echo "[smoke:discord-refresh] OK"
