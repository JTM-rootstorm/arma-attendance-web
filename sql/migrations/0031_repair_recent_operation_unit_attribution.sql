BEGIN;

CREATE TEMP TABLE recent_operation_unit_attribution_repair_summary ON COMMIT DROP AS
WITH repair_window AS (
  SELECT COALESCE(
    LEAST(
      (SELECT applied_at FROM schema_migrations WHERE version = 30),
      '2026-06-23 23:47:59+00'::timestamptz
    ),
    '2026-06-23 23:47:59+00'::timestamptz
  ) AS repair_since
),
operation_context AS (
  SELECT o.id AS operation_id, o.unit_id AS primary_unit_id
  FROM operations o
  CROSS JOIN repair_window rw
  WHERE o.updated_at >= rw.repair_since
     OR o.ended_at >= rw.repair_since
     OR o.started_at >= rw.repair_since
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
valid_preferences AS (
  SELECT
    pp.operation_id,
    pp.operation_player_uid,
    pup.represented_unit_id AS unit_id
  FROM participant_players pp
  JOIN player_unit_preferences pup
    ON pup.player_uid = pp.canonical_player_uid
  JOIN canonical_active_unit_players cup
    ON cup.player_uid = pp.canonical_player_uid
    AND cup.unit_id = pup.represented_unit_id
  WHERE pup.represented_unit_id IS NOT NULL
),
fallback_memberships AS (
  SELECT DISTINCT ON (pp.operation_id, pp.operation_player_uid)
    pp.operation_id,
    pp.operation_player_uid,
    cup.unit_id
  FROM participant_players pp
  JOIN canonical_active_unit_players cup ON cup.player_uid = pp.canonical_player_uid
  JOIN unit_players up
    ON up.unit_id = cup.unit_id
    AND (
      up.player_uid = pp.canonical_player_uid
      OR EXISTS (
        SELECT 1
        FROM player_discord_links pdl
        WHERE up.player_uid = ('discord:' || pdl.discord_user_id)
          AND pdl.player_uid = pp.canonical_player_uid
      )
    )
  ORDER BY pp.operation_id, pp.operation_player_uid, up.assignment_priority DESC, up.updated_at DESC, cup.unit_id
),
selected_player_units AS (
  SELECT
    pp.operation_id,
    pp.operation_player_uid AS player_uid,
    COALESCE(vp.unit_id, fm.unit_id, oc.primary_unit_id) AS unit_id,
    CASE
      WHEN vp.unit_id IS NOT NULL THEN 'represented_unit'
      WHEN fm.unit_id IS NOT NULL THEN 'active_membership'
      ELSE 'operation_primary'
    END AS source
  FROM participant_players pp
  JOIN operation_context oc ON oc.operation_id = pp.operation_id
  LEFT JOIN valid_preferences vp
    ON vp.operation_id = pp.operation_id
    AND vp.operation_player_uid = pp.operation_player_uid
  LEFT JOIN fallback_memberships fm
    ON fm.operation_id = pp.operation_id
    AND fm.operation_player_uid = pp.operation_player_uid
  WHERE COALESCE(vp.unit_id, fm.unit_id, oc.primary_unit_id) IS NOT NULL
),
upserted_player_units AS (
  INSERT INTO operation_player_units (operation_id, player_uid, unit_id, source)
  SELECT operation_id, player_uid, unit_id, source
  FROM selected_player_units
  ON CONFLICT (operation_id, player_uid) DO UPDATE
  SET unit_id = EXCLUDED.unit_id,
      source = EXCLUDED.source
  WHERE operation_player_units.unit_id IS DISTINCT FROM EXCLUDED.unit_id
     OR operation_player_units.source IS DISTINCT FROM EXCLUDED.source
  RETURNING operation_id, player_uid, unit_id, source
),
inserted_operation_units AS (
  INSERT INTO operation_units (operation_id, unit_id, source)
  SELECT DISTINCT operation_id, unit_id, 'participant_roster'
  FROM selected_player_units
  ON CONFLICT (operation_id, unit_id) DO NOTHING
  RETURNING operation_id, unit_id
),
removed_stale_participant_units AS (
  DELETE FROM operation_units ou
  USING operation_context oc
  WHERE ou.operation_id = oc.operation_id
    AND ou.source = 'participant_roster'
    AND NOT EXISTS (
      SELECT 1
      FROM operation_player_units opu
      WHERE opu.operation_id = ou.operation_id
        AND opu.unit_id = ou.unit_id
    )
  RETURNING ou.operation_id, ou.unit_id
)
SELECT
  (SELECT repair_since FROM repair_window) AS repair_since,
  (SELECT COUNT(*) FROM operation_context)::int AS candidate_operations,
  (SELECT COUNT(*) FROM selected_player_units)::int AS selected_player_rows,
  (SELECT COUNT(*) FROM upserted_player_units)::int AS repaired_player_unit_rows,
  (SELECT COUNT(*) FROM inserted_operation_units)::int AS inserted_operation_unit_rows,
  (SELECT COUNT(*) FROM removed_stale_participant_units)::int AS removed_stale_participant_unit_rows;

SELECT *
FROM recent_operation_unit_attribution_repair_summary;

COMMIT;
