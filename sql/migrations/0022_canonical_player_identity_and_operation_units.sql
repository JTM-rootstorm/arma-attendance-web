BEGIN;

ALTER TABLE operation_units DROP CONSTRAINT IF EXISTS operation_units_source_check;
ALTER TABLE operation_units
    ADD CONSTRAINT operation_units_source_check
    CHECK (source IN ('manual', 'server_key', 'mission_rule', 'import', 'operation_primary', 'participant_roster'));

WITH linked_identities AS (
    SELECT
        discord.user_id,
        discord.provider_user_id AS discord_user_id,
        steam.provider_user_id AS steam_player_uid,
        COALESCE(steam.display_name, discord.display_name, steam.provider_user_id) AS display_name
    FROM user_identities discord
    JOIN user_identities steam
      ON steam.user_id = discord.user_id
     AND steam.provider = 'steam'
    WHERE discord.provider = 'discord'
)
INSERT INTO players (player_uid, last_name, raw_last_player)
SELECT
    steam_player_uid,
    display_name,
    jsonb_build_object(
        'source', 'migration',
        'migration', '0022_canonical_player_identity_and_operation_units'
    )
FROM linked_identities
ON CONFLICT (player_uid) DO UPDATE
SET
    last_name = COALESCE(players.last_name, EXCLUDED.last_name),
    deleted_at = NULL,
    updated_at = now();

WITH linked_identities AS (
    SELECT
        discord.provider_user_id AS discord_user_id,
        steam.provider_user_id AS steam_player_uid
    FROM user_identities discord
    JOIN user_identities steam
      ON steam.user_id = discord.user_id
     AND steam.provider = 'steam'
    WHERE discord.provider = 'discord'
)
UPDATE player_discord_links pdl
SET
    player_uid = li.steam_player_uid,
    verified_at = COALESCE(pdl.verified_at, now()),
    updated_at = now(),
    raw_link = pdl.raw_link || jsonb_build_object(
        'canonicalized_by', '0022_canonical_player_identity_and_operation_units',
        'previous_player_uid', pdl.player_uid
    )
FROM linked_identities li
WHERE pdl.discord_user_id = li.discord_user_id
  AND (
    pdl.player_uid = ('discord:' || li.discord_user_id)
    OR pdl.source IN ('auth', 'bot')
  )
  AND NOT (
    pdl.source = 'manual'
    AND pdl.player_uid <> ('discord:' || li.discord_user_id)
    AND pdl.player_uid NOT LIKE 'discord:%'
    AND pdl.player_uid <> li.steam_player_uid
  );

WITH placeholder_links AS (
    SELECT
        ('discord:' || pdl.discord_user_id) AS placeholder_uid,
        pdl.player_uid AS canonical_uid
    FROM player_discord_links pdl
    WHERE pdl.player_uid NOT LIKE 'discord:%'
),
placeholder_unit_players AS (
    SELECT up.*, pl.canonical_uid
    FROM unit_players up
    JOIN placeholder_links pl ON pl.placeholder_uid = up.player_uid
),
upserted AS (
    INSERT INTO unit_players (
        unit_id,
        player_uid,
        rank,
        roster_name,
        is_active,
        notes,
        rank_sort,
        roster_status,
        joined_unit_at,
        left_unit_at,
        assignment_source,
        rank_id,
        assignment_locked,
        assignment_priority,
        source_guild_id,
        source_role_id
    )
    SELECT
        unit_id,
        canonical_uid,
        rank,
        roster_name,
        is_active,
        notes,
        rank_sort,
        roster_status,
        joined_unit_at,
        left_unit_at,
        assignment_source,
        rank_id,
        assignment_locked,
        assignment_priority,
        source_guild_id,
        source_role_id
    FROM placeholder_unit_players
    ON CONFLICT (unit_id, player_uid) DO UPDATE
    SET
        roster_name = CASE
            WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.roster_name
            ELSE COALESCE(NULLIF(unit_players.roster_name, ''), EXCLUDED.roster_name)
        END,
        rank = CASE
            WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.rank
            ELSE COALESCE(unit_players.rank, EXCLUDED.rank)
        END,
        rank_id = CASE
            WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.rank_id
            ELSE COALESCE(unit_players.rank_id, EXCLUDED.rank_id)
        END,
        is_active = unit_players.is_active OR EXCLUDED.is_active,
        roster_status = CASE
            WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.roster_status
            WHEN unit_players.roster_status = 'active' OR EXCLUDED.roster_status = 'active' THEN 'active'
            WHEN unit_players.roster_status = 'reserve' OR EXCLUDED.roster_status = 'reserve' THEN 'reserve'
            WHEN unit_players.roster_status = 'loa' OR EXCLUDED.roster_status = 'loa' THEN 'loa'
            ELSE EXCLUDED.roster_status
        END,
        joined_unit_at = COALESCE(unit_players.joined_unit_at, EXCLUDED.joined_unit_at),
        left_unit_at = CASE
            WHEN unit_players.is_active OR EXCLUDED.is_active THEN NULL
            ELSE COALESCE(unit_players.left_unit_at, EXCLUDED.left_unit_at)
        END,
        assignment_source = CASE
            WHEN unit_players.assignment_locked OR unit_players.assignment_source = 'manual' THEN unit_players.assignment_source
            ELSE COALESCE(NULLIF(unit_players.assignment_source, ''), EXCLUDED.assignment_source)
        END,
        assignment_priority = GREATEST(unit_players.assignment_priority, EXCLUDED.assignment_priority),
        source_guild_id = COALESCE(unit_players.source_guild_id, EXCLUDED.source_guild_id),
        source_role_id = COALESCE(unit_players.source_role_id, EXCLUDED.source_role_id),
        updated_at = now()
    RETURNING unit_id, player_uid
)
DELETE FROM unit_players up
USING placeholder_links pl
WHERE up.player_uid = pl.placeholder_uid;

WITH placeholder_links AS (
    SELECT
        ('discord:' || pdl.discord_user_id) AS placeholder_uid,
        pdl.player_uid AS canonical_uid
    FROM player_discord_links pdl
    WHERE pdl.player_uid NOT LIKE 'discord:%'
)
UPDATE unit_roster_assignments ura
SET
    player_uid = pl.canonical_uid,
    updated_at = now()
FROM placeholder_links pl
WHERE ura.player_uid = pl.placeholder_uid;

WITH placeholder_links AS (
    SELECT
        ('discord:' || pdl.discord_user_id) AS placeholder_uid,
        pdl.player_uid AS canonical_uid
    FROM player_discord_links pdl
    WHERE pdl.player_uid NOT LIKE 'discord:%'
),
placeholder_operation_players AS (
    SELECT op.*, pl.canonical_uid
    FROM operation_players op
    JOIN placeholder_links pl ON pl.placeholder_uid = op.player_uid
),
upserted AS (
    INSERT INTO operation_players (
        operation_id,
        player_uid,
        name_at_start,
        name_at_end,
        side_at_start,
        side_at_end,
        group_at_start,
        group_at_end,
        role_at_start,
        role_at_end,
        unit_class_at_start,
        unit_class_at_end,
        vehicle_class_at_start,
        vehicle_class_at_end,
        present_at_start,
        present_at_end,
        raw_start_player,
        raw_end_player
    )
    SELECT
        operation_id,
        canonical_uid,
        name_at_start,
        name_at_end,
        side_at_start,
        side_at_end,
        group_at_start,
        group_at_end,
        role_at_start,
        role_at_end,
        unit_class_at_start,
        unit_class_at_end,
        vehicle_class_at_start,
        vehicle_class_at_end,
        present_at_start,
        present_at_end,
        raw_start_player,
        raw_end_player
    FROM placeholder_operation_players
    ON CONFLICT (operation_id, player_uid) DO UPDATE
    SET
        name_at_start = COALESCE(operation_players.name_at_start, EXCLUDED.name_at_start),
        name_at_end = COALESCE(operation_players.name_at_end, EXCLUDED.name_at_end),
        side_at_start = COALESCE(operation_players.side_at_start, EXCLUDED.side_at_start),
        side_at_end = COALESCE(operation_players.side_at_end, EXCLUDED.side_at_end),
        group_at_start = COALESCE(operation_players.group_at_start, EXCLUDED.group_at_start),
        group_at_end = COALESCE(operation_players.group_at_end, EXCLUDED.group_at_end),
        role_at_start = COALESCE(operation_players.role_at_start, EXCLUDED.role_at_start),
        role_at_end = COALESCE(operation_players.role_at_end, EXCLUDED.role_at_end),
        unit_class_at_start = COALESCE(operation_players.unit_class_at_start, EXCLUDED.unit_class_at_start),
        unit_class_at_end = COALESCE(operation_players.unit_class_at_end, EXCLUDED.unit_class_at_end),
        vehicle_class_at_start = COALESCE(operation_players.vehicle_class_at_start, EXCLUDED.vehicle_class_at_start),
        vehicle_class_at_end = COALESCE(operation_players.vehicle_class_at_end, EXCLUDED.vehicle_class_at_end),
        present_at_start = operation_players.present_at_start OR EXCLUDED.present_at_start,
        present_at_end = operation_players.present_at_end OR EXCLUDED.present_at_end,
        raw_start_player = COALESCE(operation_players.raw_start_player, EXCLUDED.raw_start_player),
        raw_end_player = COALESCE(operation_players.raw_end_player, EXCLUDED.raw_end_player),
        updated_at = now()
    RETURNING operation_id, player_uid
)
DELETE FROM operation_players op
USING placeholder_links pl
WHERE op.player_uid = pl.placeholder_uid;

WITH placeholder_links AS (
    SELECT
        ('discord:' || pdl.discord_user_id) AS placeholder_uid,
        pdl.player_uid AS canonical_uid
    FROM player_discord_links pdl
    WHERE pdl.player_uid NOT LIKE 'discord:%'
),
placeholder_stats AS (
    SELECT ops.*, pl.canonical_uid
    FROM operation_player_stats ops
    JOIN placeholder_links pl ON pl.placeholder_uid = ops.player_uid
),
inserted AS (
    INSERT INTO operation_player_stats (
        operation_id,
        player_uid,
        infantry_kills,
        vehicle_kills,
        player_kills,
        ai_kills,
        friendly_kills,
        deaths,
        raw_stats,
        soft_vehicle_kills,
        armor_kills,
        air_kills,
        ground_vehicle_kills,
        all_vehicle_kills,
        scoreboard_score,
        stats_source,
        scoreboard_baseline,
        scoreboard_latest,
        raw_scoreboard_stats
    )
    SELECT
        operation_id,
        canonical_uid,
        infantry_kills,
        vehicle_kills,
        player_kills,
        ai_kills,
        friendly_kills,
        deaths,
        raw_stats,
        soft_vehicle_kills,
        armor_kills,
        air_kills,
        ground_vehicle_kills,
        all_vehicle_kills,
        scoreboard_score,
        stats_source,
        scoreboard_baseline,
        scoreboard_latest,
        raw_scoreboard_stats
    FROM placeholder_stats
    ON CONFLICT (operation_id, player_uid) DO NOTHING
    RETURNING operation_id, player_uid
)
DELETE FROM operation_player_stats ops
USING placeholder_links pl
WHERE ops.player_uid = pl.placeholder_uid;

DELETE FROM players p
WHERE p.player_uid LIKE 'discord:%'
  AND NOT EXISTS (SELECT 1 FROM player_discord_links pdl WHERE pdl.player_uid = p.player_uid)
  AND NOT EXISTS (SELECT 1 FROM unit_players up WHERE up.player_uid = p.player_uid)
  AND NOT EXISTS (SELECT 1 FROM unit_roster_assignments ura WHERE ura.player_uid = p.player_uid)
  AND NOT EXISTS (SELECT 1 FROM operation_players op WHERE op.player_uid = p.player_uid)
  AND NOT EXISTS (SELECT 1 FROM operation_player_stats ops WHERE ops.player_uid = p.player_uid);

INSERT INTO operation_units (operation_id, unit_id, source)
SELECT id, unit_id, 'operation_primary'
FROM operations
WHERE unit_id IS NOT NULL
ON CONFLICT (operation_id, unit_id) DO NOTHING;

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
    WHERE up.is_active = true
      AND up.roster_status <> 'inactive'
),
participant_units AS (
    SELECT DISTINCT op.operation_id, cup.unit_id
    FROM operation_players op
    JOIN canonical_unit_players cup ON cup.player_uid = op.player_uid
    JOIN operations o ON o.id = op.operation_id
    WHERE o.status = 'finished'
      AND (op.present_at_start = true OR op.present_at_end = true)
)
INSERT INTO operation_units (operation_id, unit_id, source)
SELECT operation_id, unit_id, 'participant_roster'
FROM participant_units
ON CONFLICT (operation_id, unit_id) DO NOTHING;

COMMIT;
