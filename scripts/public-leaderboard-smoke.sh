#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:3000}"
TMP_DIR="$(mktemp -d)"
STAMP="$(date +%Y%m%d%H%M%S)"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/.env}"

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
  echo "[smoke:leaderboard:public] DATABASE_URL is required." >&2
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

echo "[smoke:leaderboard:public] Seeding player leaderboard rows..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -v stamp="$STAMP" <<'SQL'
WITH operation_seed AS (
  INSERT INTO operations (server_key, status, mission_uid, mission_name, world_name, started_at, ended_at)
  VALUES ('public-leaderboard-smoke', 'finished', 'public-leaderboard-smoke-' || :'stamp', 'Public Leaderboard Smoke', 'VR', now(), now())
  RETURNING id
),
unfinished_operation_seed AS (
  INSERT INTO operations (server_key, status, mission_uid, mission_name, world_name, started_at)
  VALUES ('public-leaderboard-smoke', 'started', 'public-leaderboard-smoke-unfinished-' || :'stamp', 'Public Leaderboard Unfinished Smoke', 'VR', now())
  RETURNING id
),
player_seed AS (
  INSERT INTO players (player_uid, last_name, raw_last_player)
  SELECT
    'public-leaderboard-smoke-' || :'stamp' || '-' || lpad(series::text, 2, '0'),
    CASE
      WHEN series = 1 THEN 'CT-01 ''Kix'' "Medic"'
      ELSE 'Public Player Smoke ' || lpad(series::text, 2, '0')
    END,
    '{}'::jsonb
  FROM generate_series(1, 21) AS series
  ON CONFLICT (player_uid) DO UPDATE
  SET last_name = EXCLUDED.last_name,
      deleted_at = NULL,
      updated_at = now()
  RETURNING player_uid, last_name
),
operation_player_seed AS (
  INSERT INTO operation_players (operation_id, player_uid, name_at_start, name_at_end, present_at_start, present_at_end)
  SELECT
    operation_seed.id,
    player_seed.player_uid,
    player_seed.last_name,
    player_seed.last_name,
    true,
    true
  FROM operation_seed
  CROSS JOIN player_seed
  UNION ALL
  SELECT
    unfinished_operation_seed.id,
    player_seed.player_uid,
    player_seed.last_name,
    NULL,
    true,
    false
  FROM unfinished_operation_seed
  CROSS JOIN player_seed
  WHERE split_part(player_seed.player_uid, '-', 5)::int = 1
  ON CONFLICT (operation_id, player_uid) DO UPDATE
  SET present_at_start = true,
      present_at_end = true,
      name_at_start = EXCLUDED.name_at_start,
      name_at_end = EXCLUDED.name_at_end,
      updated_at = now()
  RETURNING operation_id, player_uid
)
INSERT INTO operation_player_stats (
  operation_id,
  player_uid,
  infantry_kills,
  vehicle_kills,
  deaths,
  soft_vehicle_kills,
  armor_kills,
  air_kills
)
SELECT
  operation_player_seed.operation_id,
  operation_player_seed.player_uid,
  CASE
    WHEN operation_player_seed.operation_id = (SELECT id FROM unfinished_operation_seed) THEN 3000000
    WHEN split_part(operation_player_seed.player_uid, '-', 5)::int = 1 THEN 2000000
    ELSE 1000000 - split_part(operation_player_seed.player_uid, '-', 5)::int
  END,
  0,
  split_part(operation_player_seed.player_uid, '-', 5)::int,
  0,
  0,
  0
FROM operation_player_seed
ON CONFLICT (operation_id, player_uid) DO UPDATE
SET infantry_kills = EXCLUDED.infantry_kills,
    vehicle_kills = EXCLUDED.vehicle_kills,
    deaths = EXCLUDED.deaths,
    soft_vehicle_kills = EXCLUDED.soft_vehicle_kills,
    armor_kills = EXCLUDED.armor_kills,
    air_kills = EXCLUDED.air_kills,
    updated_at = now();
SQL

echo "[smoke:leaderboard:public] Checking /v1 leaderboard without auth..."
curl -fsS "$BASE_URL/v1/leaderboard/units?limit=50" |
  assert_json 'data.ok === true && Array.isArray(data.leaderboard) && data.pagination.limit === 50'

echo "[smoke:leaderboard:public] Checking /v1 leaderboard with stale Authorization..."
curl -fsS -H "Authorization: Bearer undefined" "$BASE_URL/v1/leaderboard/units?limit=50" |
  assert_json 'data.ok === true && Array.isArray(data.leaderboard) && data.leaderboard.every((entry) => entry.unit_id === null && entry.unit_key === null)'

echo "[smoke:leaderboard:public] Checking public alias without auth..."
curl -fsS -D "$TMP_DIR/public.headers" "$BASE_URL/public/leaderboard/units?limit=50" |
  assert_json 'data.ok === true && Array.isArray(data.leaderboard) && data.leaderboard.every((entry) => entry.unit_id === null && entry.unit_key === null)'

if ! grep -iq '^cache-control: public, max-age=60' "$TMP_DIR/public.headers"; then
  echo "[smoke:leaderboard:public] Missing Cache-Control: public, max-age=60." >&2
  cat "$TMP_DIR/public.headers" >&2
  exit 1
fi

echo "[smoke:leaderboard:public] Checking public alias ignores stale Authorization..."
curl -fsS -H "Authorization: Bearer null" "$BASE_URL/public/leaderboard/units?limit=50" |
  assert_json 'data.ok === true && Array.isArray(data.leaderboard) && data.leaderboard.every((entry) => entry.unit_id === null && entry.unit_key === null)'

echo "[smoke:leaderboard:public] Checking public player leaderboard without auth..."
curl -fsS -D "$TMP_DIR/public-players.headers" "$BASE_URL/public/leaderboard/players" |
  assert_json "
    data.ok === true
    && Array.isArray(data.leaderboard)
    && data.leaderboard.length <= 20
    && data.pagination.limit === 20
    && data.leaderboard[0]?.rank === 1
    && data.leaderboard[0]?.name === 'CT-01 \\'Kix\\' \"Medic\"'
    && data.leaderboard[0]?.operation_count === 1
    && data.leaderboard[0]?.infantry_kills === 2000000
    && !data.leaderboard.some((entry) => entry.name === 'Public Player Smoke 21')
    && data.leaderboard.every((entry) => entry.player_uid === null)
    && data.leaderboard.every((entry) => !('discord_user_id' in entry) && !('steam_id' in entry) && !('raw_payload' in entry) && !('raw_stats' in entry))
  "

if ! grep -iq '^cache-control: public, max-age=60' "$TMP_DIR/public-players.headers"; then
  echo "[smoke:leaderboard:public] Missing player Cache-Control: public, max-age=60." >&2
  cat "$TMP_DIR/public-players.headers" >&2
  exit 1
fi

echo "[smoke:leaderboard:public] Checking public player leaderboard ignores stale Authorization..."
curl -fsS -H "Authorization: Bearer undefined" "$BASE_URL/public/leaderboard/players" |
  assert_json "data.ok === true && Array.isArray(data.leaderboard) && data.leaderboard.every((entry) => entry.player_uid === null)"

echo "[smoke:leaderboard:public] Checking player leaderboard limit clamp..."
curl -fsS "$BASE_URL/public/leaderboard/players?limit=5" |
  assert_json "data.ok === true && data.pagination.limit === 5 && data.leaderboard.length <= 5"

invalid_status="$(curl -sS -o "$TMP_DIR/invalid-limit.json" -w "%{http_code}" "$BASE_URL/public/leaderboard/players?limit=21")"
if [[ "$invalid_status" != "400" ]]; then
  echo "[smoke:leaderboard:public] Expected limit=21 to return HTTP 400, got $invalid_status." >&2
  cat "$TMP_DIR/invalid-limit.json" >&2
  exit 1
fi

assert_json "data.ok === false && data.error?.code === 'validation_failed'" < "$TMP_DIR/invalid-limit.json"

echo "[smoke:leaderboard:public] OK"
