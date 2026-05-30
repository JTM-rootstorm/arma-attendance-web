BEGIN;

WITH duplicate_mappings AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY
                guild_id,
                role_id,
                mapping_type,
                COALESCE(unit_id::text, ''),
                COALESCE(rank_id::text, ''),
                COALESCE(unit_role, ''),
                COALESCE(app_role, ''),
                COALESCE(roster_status, '')
            ORDER BY updated_at DESC, created_at DESC, id DESC
        ) AS row_number
    FROM discord_role_mappings
)
DELETE FROM discord_role_mappings drm
USING duplicate_mappings dm
WHERE drm.id = dm.id
  AND dm.row_number > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uq_discord_role_mappings_natural
    ON discord_role_mappings (
        guild_id,
        role_id,
        mapping_type,
        COALESCE(unit_id::text, ''),
        COALESCE(rank_id::text, ''),
        COALESCE(unit_role, ''),
        COALESCE(app_role, ''),
        COALESCE(roster_status, '')
    );

COMMIT;
