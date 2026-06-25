BEGIN;

CREATE TEMP TABLE pre_multi_unit_primary_attribution_summary ON COMMIT DROP AS
WITH repair_window AS (
  SELECT '2026-06-23 23:47:59+00'::timestamptz AS cutoff_at
),
operation_context AS (
  SELECT o.id AS operation_id
  FROM operations o
  CROSS JOIN repair_window rw
  WHERE o.started_at < rw.cutoff_at
),
participant_players AS (
  SELECT DISTINCT
    oc.operation_id,
    op.player_uid AS operation_player_uid,
    COALESCE(
      CASE
        WHEN pdl.player_uid IS NOT NULL AND pdl.player_uid NOT LIKE 'discord:%' THEN pdl.player_uid
        ELSE NULL
      END,
      op.player_uid
    ) AS canonical_player_uid
  FROM operation_context oc
  JOIN operation_players op ON op.operation_id = oc.operation_id
  LEFT JOIN player_discord_links pdl
    ON op.player_uid = ('discord:' || pdl.discord_user_id)
  WHERE op.present_at_start = true OR op.present_at_end = true
),
canonical_active_unit_players AS (
  SELECT DISTINCT
    up.unit_id,
    COALESCE(
      CASE
        WHEN pdl.player_uid IS NOT NULL AND pdl.player_uid NOT LIKE 'discord:%' THEN pdl.player_uid
        ELSE NULL
      END,
      up.player_uid
    ) AS player_uid
  FROM unit_players up
  JOIN units u ON u.id = up.unit_id
  LEFT JOIN player_discord_links pdl
    ON up.player_uid = ('discord:' || pdl.discord_user_id)
  WHERE up.is_active = true
    AND up.roster_status <> 'inactive'
    AND u.is_active = true
    AND u.deleted_at IS NULL
),
primary_at_run_time AS (
  SELECT
    pp.operation_id,
    pp.operation_player_uid AS player_uid,
    pup.represented_unit_id AS unit_id
  FROM participant_players pp
  JOIN player_unit_preferences pup
    ON pup.player_uid = pp.canonical_player_uid
  JOIN canonical_active_unit_players cup
    ON cup.player_uid = pp.canonical_player_uid
    AND cup.unit_id = pup.represented_unit_id
  WHERE pup.represented_unit_id IS NOT NULL
),
already_attached AS (
  SELECT pat.operation_id, pat.player_uid, pat.unit_id
  FROM primary_at_run_time pat
  JOIN operation_player_units opu
    ON opu.operation_id = pat.operation_id
    AND opu.player_uid = pat.player_uid
    AND opu.unit_id = pat.unit_id
),
upserted_player_units AS (
  INSERT INTO operation_player_units (operation_id, player_uid, unit_id, source)
  SELECT operation_id, player_uid, unit_id, 'migration'
  FROM primary_at_run_time
  ON CONFLICT (operation_id, player_uid) DO UPDATE
  SET unit_id = EXCLUDED.unit_id,
      source = EXCLUDED.source
  WHERE operation_player_units.unit_id IS DISTINCT FROM EXCLUDED.unit_id
  RETURNING operation_id, player_uid, unit_id, source
),
inserted_operation_units AS (
  INSERT INTO operation_units (operation_id, unit_id, source)
  SELECT DISTINCT operation_id, unit_id, 'participant_roster'
  FROM primary_at_run_time
  ON CONFLICT (operation_id, unit_id) DO NOTHING
  RETURNING operation_id, unit_id
)
SELECT
  (SELECT cutoff_at FROM repair_window) AS cutoff_at,
  (SELECT COUNT(*) FROM operation_context)::int AS candidate_operations,
  (SELECT COUNT(*) FROM primary_at_run_time)::int AS primary_player_rows,
  (SELECT COUNT(*) FROM already_attached)::int AS already_attached_player_rows,
  (SELECT COUNT(*) FROM upserted_player_units)::int AS repaired_player_unit_rows,
  (SELECT COUNT(*) FROM inserted_operation_units)::int AS inserted_operation_unit_rows;

SELECT *
FROM pre_multi_unit_primary_attribution_summary;

COMMIT;
