#!/usr/bin/env bash

smoke_sql_scalar() {
  local sql="$1"
  shift

  psql "$DATABASE_URL" -At -v ON_ERROR_STOP=1 "$@" <<SQL
$sql
SQL
}

smoke_cleanup_xp_data() {
  local stamp="$1"
  local mission_uid_pattern="$2"
  local player_uid_pattern="$3"
  local tier_match_pattern="$4"

  if [[ -z "${DATABASE_URL:-}" ]]; then
    return
  fi

  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
    -v stamp="$stamp" \
    -v mission_uid_pattern="$mission_uid_pattern" \
    -v player_uid_pattern="$player_uid_pattern" \
    -v tier_match_pattern="$tier_match_pattern" >/dev/null 2>&1 <<'SQL' || true
WITH target_operations AS (
  SELECT id
  FROM operations
  WHERE mission_uid LIKE :'mission_uid_pattern'
),
award_totals AS (
  SELECT
    oxa.player_uid,
    SUM(oxa.xp_amount)::int AS xp_amount
  FROM operation_xp_awards oxa
  JOIN target_operations target ON target.id = oxa.operation_id
  GROUP BY oxa.player_uid
),
planet_award_totals AS (
  SELECT
    oppa.planet_id,
    SUM(oppa.progress_percent)::numeric(6,3) AS progress_percent
  FROM operation_planet_progress_awards oppa
  JOIN target_operations target ON target.id = oppa.operation_id
  GROUP BY oppa.planet_id
),
updated_players AS (
  UPDATE players p
  SET
    xp_total = greatest(0, p.xp_total - award_totals.xp_amount),
    updated_at = now()
  FROM award_totals
  WHERE p.player_uid = award_totals.player_uid
  RETURNING p.player_uid
),
updated_planets AS (
  UPDATE planets p
  SET
    completion_percent = greatest(0.000, p.completion_percent - planet_award_totals.progress_percent)::numeric(6,3),
    updated_at = now()
  FROM planet_award_totals
  WHERE p.id = planet_award_totals.planet_id
  RETURNING p.id
),
deleted_operations AS (
  DELETE FROM operations o
  USING target_operations target
  WHERE o.id = target.id
  RETURNING o.id
),
deleted_tiers AS (
  DELETE FROM xp_reward_tiers
  WHERE mission_name_match LIKE :'tier_match_pattern'
  RETURNING id
)
DELETE FROM players p
WHERE p.player_uid LIKE :'player_uid_pattern'
  AND NOT EXISTS (SELECT 1 FROM operation_players op WHERE op.player_uid = p.player_uid)
  AND NOT EXISTS (SELECT 1 FROM operation_xp_awards oxa WHERE oxa.player_uid = p.player_uid)
  AND NOT EXISTS (SELECT 1 FROM unit_players up WHERE up.player_uid = p.player_uid);
SQL
}
