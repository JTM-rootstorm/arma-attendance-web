BEGIN;

CREATE TABLE IF NOT EXISTS player_unit_preferences (
    player_uid TEXT PRIMARY KEY REFERENCES players(player_uid) ON DELETE CASCADE,
    represented_unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
    updated_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_player_unit_preferences_represented_unit
    ON player_unit_preferences (represented_unit_id);

CREATE TABLE IF NOT EXISTS operation_player_units (
    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    player_uid TEXT NOT NULL REFERENCES players(player_uid) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'represented_unit'
      CHECK (source IN ('represented_unit', 'active_membership', 'operation_primary', 'migration')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (operation_id, player_uid)
);

CREATE INDEX IF NOT EXISTS idx_operation_player_units_unit_operation
    ON operation_player_units (unit_id, operation_id);

CREATE INDEX IF NOT EXISTS idx_operation_player_units_player
    ON operation_player_units (player_uid);

WITH active_memberships AS (
    SELECT DISTINCT ON (up.player_uid)
        up.player_uid,
        up.unit_id
    FROM unit_players up
    JOIN units u ON u.id = up.unit_id
    WHERE up.is_active = true
      AND up.roster_status <> 'inactive'
      AND u.is_active = true
      AND u.deleted_at IS NULL
    ORDER BY up.player_uid, up.assignment_priority DESC, up.updated_at DESC, up.unit_id
)
INSERT INTO player_unit_preferences (player_uid, represented_unit_id)
SELECT player_uid, unit_id
FROM active_memberships
ON CONFLICT (player_uid) DO NOTHING;

WITH canonical_unit_players AS (
    SELECT DISTINCT
        up.unit_id,
        COALESCE(
            CASE
                WHEN pdl.player_uid NOT LIKE 'discord:%' THEN pdl.player_uid
                ELSE NULL
            END,
            up.player_uid
        ) AS player_uid
    FROM unit_players up
    LEFT JOIN player_discord_links pdl
      ON up.player_uid = ('discord:' || pdl.discord_user_id)
),
candidate_attribution AS (
    SELECT DISTINCT ON (op.operation_id, op.player_uid)
        op.operation_id,
        op.player_uid,
        cup.unit_id,
        CASE
            WHEN ou.source IN ('server_key', 'operation_primary') THEN 'operation_primary'
            ELSE 'migration'
        END AS source
    FROM operation_players op
    JOIN canonical_unit_players cup ON cup.player_uid = op.player_uid
    JOIN operation_units ou
      ON ou.operation_id = op.operation_id
     AND ou.unit_id = cup.unit_id
    LEFT JOIN operations o ON o.id = op.operation_id
    WHERE op.present_at_start = true OR op.present_at_end = true
    ORDER BY
        op.operation_id,
        op.player_uid,
        CASE WHEN cup.unit_id = o.unit_id THEN 0 ELSE 1 END,
        CASE
            WHEN ou.source IN ('participant_roster', 'import') THEN 0
            WHEN ou.source IN ('server_key', 'operation_primary') THEN 1
            ELSE 2
        END,
        ou.created_at,
        cup.unit_id
)
INSERT INTO operation_player_units (operation_id, player_uid, unit_id, source)
SELECT operation_id, player_uid, unit_id, source
FROM candidate_attribution
ON CONFLICT (operation_id, player_uid) DO NOTHING;

INSERT INTO operation_player_units (operation_id, player_uid, unit_id, source)
SELECT op.operation_id, op.player_uid, o.unit_id, 'operation_primary'
FROM operation_players op
JOIN operations o ON o.id = op.operation_id
WHERE o.unit_id IS NOT NULL
  AND (op.present_at_start = true OR op.present_at_end = true)
  AND NOT EXISTS (
      SELECT 1
      FROM operation_player_units opu
      WHERE opu.operation_id = op.operation_id
        AND opu.player_uid = op.player_uid
  )
ON CONFLICT (operation_id, player_uid) DO NOTHING;

INSERT INTO operation_units (operation_id, unit_id, source)
SELECT DISTINCT operation_id, unit_id, 'participant_roster'
FROM operation_player_units
ON CONFLICT (operation_id, unit_id) DO NOTHING;

COMMIT;
