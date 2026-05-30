#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
API_TOKEN="${API_TOKEN:-dev-token}"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "[smoke:discord-auth-policy] DATABASE_URL is required." >&2
  exit 1
fi

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

api_post() {
  local path="$1"
  local body="$2"

  curl -fsS -X POST "$BASE_URL$path" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body"
}

api_put() {
  local path="$1"
  local body="$2"

  curl -fsS -X PUT "$BASE_URL$path" \
    -H "Authorization: Bearer $API_TOKEN" \
    -H "Content-Type: application/json" \
    -d "$body"
}

fallback_guild="1478100812818550845"
partner_guild="partner-guild-$STAMP"
fallback_unit_role="fallback-unit-$STAMP"
fallback_rank_role="fallback-rank-$STAMP"
partner_unit_role="partner-unit-$STAMP"
partner_rank_role="partner-rank-$STAMP"
partner_app_role="partner-app-$STAMP"
partner_deny_role="partner-deny-$STAMP"
attach_guild="attach-guild-$STAMP"
attach_role="attach-unit-$STAMP"
discord_user_id="discord-auth-policy-$STAMP"
deny_discord_user_id="discord-auth-policy-deny-$STAMP"
player_uid="discord:$discord_user_id"
deny_player_uid="discord:$deny_discord_user_id"

echo "[smoke:discord-auth-policy] Seeding users, units, and ranks..."
IFS='|' read -r fallback_unit_id partner_unit_id fallback_rank_id partner_rank_id user_id < <(
  psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
    -v stamp="$STAMP" \
    -v discord_user_id="$discord_user_id" \
    -v deny_discord_user_id="$deny_discord_user_id" \
    -v player_uid="$player_uid" \
    -v deny_player_uid="$deny_player_uid" <<'SQL'
WITH fallback_unit AS (
  INSERT INTO units (unit_key, slug, name, display_name)
  VALUES ('discord-auth-fallback-' || :'stamp', 'discord-auth-fallback-' || :'stamp', 'Discord Auth Fallback', 'Discord Auth Fallback')
  RETURNING id
),
partner_unit AS (
  INSERT INTO units (unit_key, slug, name, display_name)
  VALUES ('discord-auth-partner-' || :'stamp', 'discord-auth-partner-' || :'stamp', 'Discord Auth Partner', 'Discord Auth Partner')
  RETURNING id
),
fallback_rank AS (
  INSERT INTO unit_ranks (unit_id, rank_key, name, sort_order)
  SELECT id, 'private', 'Private', 10 FROM fallback_unit
  RETURNING id
),
partner_rank AS (
  INSERT INTO unit_ranks (unit_id, rank_key, name, sort_order)
  SELECT id, 'sergeant', 'Sergeant', 50 FROM partner_unit
  RETURNING id
),
test_user AS (
  INSERT INTO app_users (display_name, last_login_at)
  VALUES ('Discord Auth Policy Smoke', now())
  RETURNING id
),
deny_user AS (
  INSERT INTO app_users (display_name, last_login_at)
  VALUES ('Discord Auth Policy Deny Smoke', now())
  RETURNING id
),
identity_seed AS (
  INSERT INTO user_identities (user_id, provider, provider_user_id, display_name, raw_profile)
  SELECT id, 'discord', :'discord_user_id', 'Discord Auth Policy Smoke', '{}'::jsonb FROM test_user
),
deny_identity_seed AS (
  INSERT INTO user_identities (user_id, provider, provider_user_id, display_name, raw_profile)
  SELECT id, 'discord', :'deny_discord_user_id', 'Discord Auth Policy Deny Smoke', '{}'::jsonb FROM deny_user
),
player_seed AS (
  INSERT INTO players (player_uid, last_name, raw_last_player)
  VALUES (:'player_uid', 'Discord Auth Policy Smoke', '{}'::jsonb)
  ON CONFLICT (player_uid) DO UPDATE SET last_name = EXCLUDED.last_name, updated_at = now()
),
deny_player_seed AS (
  INSERT INTO players (player_uid, last_name, raw_last_player)
  VALUES (:'deny_player_uid', 'Discord Auth Policy Deny Smoke', '{}'::jsonb)
  ON CONFLICT (player_uid) DO UPDATE SET last_name = EXCLUDED.last_name, updated_at = now()
),
link_seed AS (
  INSERT INTO player_discord_links (player_uid, discord_user_id, discord_display_name, source, verified_at, raw_link)
  VALUES (:'player_uid', :'discord_user_id', 'Discord Auth Policy Smoke', 'auth', now(), '{}'::jsonb)
  ON CONFLICT (discord_user_id) DO UPDATE
  SET player_uid = EXCLUDED.player_uid, discord_display_name = EXCLUDED.discord_display_name, updated_at = now()
),
deny_link_seed AS (
  INSERT INTO player_discord_links (player_uid, discord_user_id, discord_display_name, source, verified_at, raw_link)
  VALUES (:'deny_player_uid', :'deny_discord_user_id', 'Discord Auth Policy Deny Smoke', 'auth', now(), '{}'::jsonb)
  ON CONFLICT (discord_user_id) DO UPDATE
  SET player_uid = EXCLUDED.player_uid, discord_display_name = EXCLUDED.discord_display_name, updated_at = now()
)
SELECT
  (SELECT id FROM fallback_unit)::text || '|' ||
  (SELECT id FROM partner_unit)::text || '|' ||
  (SELECT id FROM fallback_rank)::text || '|' ||
  (SELECT id FROM partner_rank)::text || '|' ||
  (SELECT id FROM test_user)::text;
SQL
)

attach_unit_id="$(
  psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 -v stamp="$STAMP" <<'SQL'
INSERT INTO units (unit_key, slug, name, display_name)
VALUES ('discord-auth-attach-' || :'stamp', 'discord-auth-attach-' || :'stamp', 'Discord Attach Unit', 'Discord Attach Unit')
RETURNING id;
SQL
)"
attach_unit_id="$(printf "%s\n" "$attach_unit_id" | head -n 1)"

echo "[smoke:discord-auth-policy] Syncing fallback and partner guild role snapshots..."
api_post "/v1/discord/guilds/sync" "{
  \"guild\": { \"guild_id\": \"$fallback_guild\", \"name\": \"TCWA3 Main\", \"bot_present\": true },
  \"roles\": [
    { \"role_id\": \"$fallback_unit_role\", \"name\": \"Fallback Unit\", \"position\": 10, \"assignable\": true },
    { \"role_id\": \"$fallback_rank_role\", \"name\": \"Fallback Private\", \"position\": 9, \"assignable\": true }
  ]
}" | assert_json "data.ok === true"
api_post "/v1/discord/guilds/sync" "{
  \"guild\": { \"guild_id\": \"$partner_guild\", \"name\": \"Partner Guild\", \"bot_present\": true },
  \"roles\": [
    { \"role_id\": \"$partner_unit_role\", \"name\": \"Partner Unit\", \"position\": 20, \"assignable\": true },
    { \"role_id\": \"$partner_rank_role\", \"name\": \"Partner Sergeant\", \"position\": 19, \"assignable\": true },
    { \"role_id\": \"$partner_app_role\", \"name\": \"Partner Viewer\", \"position\": 18, \"assignable\": true },
    { \"role_id\": \"$partner_deny_role\", \"name\": \"Partner Deny\", \"position\": 30, \"assignable\": true }
  ]
}" | assert_json "data.ok === true"
api_post "/v1/discord/guilds/sync" "{
  \"guild\": { \"guild_id\": \"$attach_guild\", \"name\": \"Attach Guild\", \"bot_present\": true },
  \"roles\": []
}" | assert_json "data.ok === true"

echo "[smoke:discord-auth-policy] Setting auth guild policy and role mappings..."
api_put "/v1/discord/guilds/$fallback_guild/auth-policy" '{
  "guild_type": "fallback",
  "grants_login": true,
  "sync_members": true,
  "is_fallback": true,
  "unit_priority": 10,
  "rank_priority": 10,
  "permission_priority": 50,
  "config_order": 1000
}' | assert_json "data.ok === true"
api_put "/v1/discord/guilds/$partner_guild/auth-policy" '{
  "guild_type": "partner",
  "grants_login": true,
  "sync_members": true,
  "is_fallback": false,
  "unit_priority": 100,
  "rank_priority": 100,
  "permission_priority": 20,
  "config_order": 100
}' | assert_json "data.ok === true"

api_post "/v1/discord/guilds/$fallback_guild/role-mappings" "{
  \"role_id\": \"$fallback_unit_role\",
  \"mapping_type\": \"unit_primary\",
  \"unit_id\": \"$fallback_unit_id\",
  \"priority\": 10
}" | assert_json "data.ok === true"
api_post "/v1/discord/guilds/$fallback_guild/role-mappings" "{
  \"role_id\": \"$fallback_unit_role\",
  \"mapping_type\": \"unit_primary\",
  \"unit_id\": \"$fallback_unit_id\",
  \"priority\": 10
}" | assert_json "data.ok === true"
api_post "/v1/discord/guilds/$fallback_guild/role-mappings" "{
  \"role_id\": \"$fallback_rank_role\",
  \"mapping_type\": \"rank\",
  \"unit_id\": \"$fallback_unit_id\",
  \"rank_id\": \"$fallback_rank_id\",
  \"priority\": 10
}" | assert_json "data.ok === true"
api_post "/v1/discord/guilds/$partner_guild/role-mappings" "{
  \"role_id\": \"$partner_unit_role\",
  \"mapping_type\": \"unit_primary\",
  \"unit_id\": \"$partner_unit_id\",
  \"priority\": 100
}" | assert_json "data.ok === true"
api_post "/v1/discord/guilds/$partner_guild/role-mappings" "{
  \"role_id\": \"$partner_rank_role\",
  \"mapping_type\": \"rank\",
  \"unit_id\": \"$partner_unit_id\",
  \"rank_id\": \"$partner_rank_id\",
  \"priority\": 100
}" | assert_json "data.ok === true"
api_post "/v1/discord/guilds/$partner_guild/role-mappings" "{
  \"role_id\": \"$partner_app_role\",
  \"mapping_type\": \"app_role\",
  \"app_role\": \"viewer\",
  \"priority\": 100
}" | assert_json "data.ok === true"
api_post "/v1/discord/guilds/$partner_guild/role-mappings" "{
  \"role_id\": \"$partner_deny_role\",
  \"mapping_type\": \"deny_login\",
  \"priority\": 1000
}" | assert_json "data.ok === true"

psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
  -v guild_id="$fallback_guild" \
  -v role_id="$fallback_unit_role" \
  -v unit_id="$fallback_unit_id" <<'SQL' |
SELECT COUNT(*) = 1
FROM discord_role_mappings
WHERE guild_id = :'guild_id'
  AND role_id = :'role_id'
  AND mapping_type = 'unit_primary'
  AND unit_id = :'unit_id';
SQL
  grep -qx "t"

echo "[smoke:discord-auth-policy] Checking COMMS role attach enables login mapping..."
api_post "/v1/discord/guilds/$attach_guild/roles" "{
  \"role_id\": \"$attach_role\",
  \"name\": \"Attach Unit\",
  \"unit_id\": \"$attach_unit_id\",
  \"priority\": 25,
  \"assignable\": true
}" | assert_json "data.ok === true && data.mapping.mapping_type === 'unit_primary' && data.member_mapping.mapping_type === 'unit_role' && data.member_mapping.unit_role === 'member'"

psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
  -v guild_id="$attach_guild" \
  -v role_id="$attach_role" \
  -v unit_id="$attach_unit_id" <<'SQL' |
SELECT EXISTS (
  SELECT 1
  FROM discord_guilds dg
  WHERE dg.guild_id = :'guild_id'
    AND dg.grants_login = true
    AND dg.sync_members = true
) AND (
  SELECT COUNT(*) = 2
  FROM discord_role_mappings drm
  WHERE drm.guild_id = :'guild_id'
    AND drm.role_id = :'role_id'
    AND drm.unit_id = :'unit_id'
    AND drm.mapping_type IN ('unit_primary', 'unit_role')
    AND drm.is_enabled = true
);
SQL
  grep -qx "t"

echo "[smoke:discord-auth-policy] Posting snapshots and checking partner priority wins..."
api_post "/v1/discord/guilds/$fallback_guild/member-snapshots" "{
  \"reconcile\": false,
  \"members\": [{ \"discord_user_id\": \"$discord_user_id\", \"roles\": [\"$fallback_unit_role\", \"$fallback_rank_role\"] }]
}" | assert_json "data.ok === true"
api_post "/v1/discord/guilds/$partner_guild/member-snapshots" "{
  \"reconcile\": true,
  \"members\": [{ \"discord_user_id\": \"$discord_user_id\", \"roles\": [\"$partner_unit_role\", \"$partner_rank_role\", \"$partner_app_role\"] }]
}" | assert_json "data.ok === true && data.reconciled[0].winning_claims.unit_primary.unitId === '$partner_unit_id'"

psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
  -v player_uid="$player_uid" \
  -v unit_id="$partner_unit_id" \
  -v rank_id="$partner_rank_id" <<'SQL' |
SELECT EXISTS (
  SELECT 1 FROM unit_players
  WHERE player_uid = :'player_uid'
    AND unit_id = :'unit_id'
    AND rank_id = :'rank_id'
    AND is_active = true
);
SQL
  grep -qx "t"

psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
  -v user_id="$user_id" <<'SQL' |
SELECT EXISTS (
  SELECT 1 FROM user_roles
  WHERE user_id = :'user_id'
    AND role = 'viewer'
    AND grant_source = 'discord'
);
SQL
  grep -qx "t"

echo "[smoke:discord-auth-policy] Checking deny role blocks reconciliation writes..."
api_post "/v1/discord/guilds/$partner_guild/member-snapshots" "{
  \"reconcile\": true,
  \"members\": [{ \"discord_user_id\": \"$deny_discord_user_id\", \"roles\": [\"$partner_unit_role\", \"$partner_app_role\", \"$partner_deny_role\"] }]
}" | assert_json "data.ok === true && data.reconciled[0].denied === true && data.reconciled[0].applied.length === 0"

psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
  -v player_uid="$deny_player_uid" \
  -v deny_discord_user_id="$deny_discord_user_id" <<'SQL' |
SELECT NOT EXISTS (
  SELECT 1 FROM unit_players
  WHERE player_uid = :'player_uid'
    AND assignment_source = 'discord'
    AND is_active = true
) AND NOT EXISTS (
  SELECT 1 FROM user_roles ur
  JOIN user_identities ui ON ui.user_id = ur.user_id
  WHERE ui.provider = 'discord'
    AND ui.provider_user_id = :'deny_discord_user_id'
    AND ur.grant_source = 'discord'
) AND EXISTS (
  SELECT 1 FROM discord_assignment_audits
  WHERE discord_user_id = :'deny_discord_user_id'
    AND action = 'deny'
    AND field = 'login'
);
SQL
  grep -qx "t"

echo "[smoke:discord-auth-policy] Removing partner roles and checking fallback becomes effective..."
api_post "/v1/discord/guilds/$partner_guild/member-snapshots" "{
  \"reconcile\": true,
  \"members\": [{ \"discord_user_id\": \"$discord_user_id\", \"roles\": [] }]
}" | assert_json "data.ok === true && data.reconciled[0].winning_claims.unit_primary.unitId === '$fallback_unit_id'"

psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
  -v player_uid="$player_uid" \
  -v unit_id="$fallback_unit_id" \
  -v rank_id="$fallback_rank_id" <<'SQL' |
SELECT EXISTS (
  SELECT 1 FROM unit_players
  WHERE player_uid = :'player_uid'
    AND unit_id = :'unit_id'
    AND rank_id = :'rank_id'
    AND is_active = true
);
SQL
  grep -qx "t"

echo "[smoke:discord-auth-policy] Checking manual locked assignments are preserved..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v player_uid="$player_uid" \
  -v partner_unit_id="$partner_unit_id" \
  -v partner_rank_id="$partner_rank_id" <<'SQL'
INSERT INTO unit_players (
  unit_id,
  player_uid,
  roster_status,
  assignment_source,
  assignment_locked,
  rank_id,
  is_active
)
VALUES (:'partner_unit_id', :'player_uid', 'active', 'manual', true, :'partner_rank_id', true)
ON CONFLICT (unit_id, player_uid) DO UPDATE
SET assignment_source = 'manual',
    assignment_locked = true,
    rank_id = EXCLUDED.rank_id,
    roster_status = 'active',
    is_active = true,
    updated_at = now();
SQL

api_post "/v1/discord/reconcile" "{
  \"discord_user_id\": \"$discord_user_id\",
  \"dry_run\": false
}" | assert_json "data.ok === true && data.manual_locked === true"

psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 \
  -v player_uid="$player_uid" \
  -v unit_id="$partner_unit_id" <<'SQL' |
SELECT EXISTS (
  SELECT 1 FROM unit_players
  WHERE player_uid = :'player_uid'
    AND unit_id = :'unit_id'
    AND assignment_locked = true
    AND is_active = true
);
SQL
  grep -qx "t"

echo "[smoke:discord-auth-policy] OK user_id=$user_id"
