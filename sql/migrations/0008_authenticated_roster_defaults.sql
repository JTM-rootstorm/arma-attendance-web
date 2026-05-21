BEGIN;

ALTER TABLE player_discord_links DROP CONSTRAINT IF EXISTS player_discord_links_source_check;
ALTER TABLE player_discord_links
    ADD CONSTRAINT player_discord_links_source_check
    CHECK (source IN ('manual', 'bot', 'import', 'auth'));

WITH default_unit AS (
    INSERT INTO units (unit_key, name, description)
    VALUES ('tcw', 'TCW', 'Default unit')
    ON CONFLICT (unit_key) DO UPDATE SET updated_at = now()
    RETURNING id
),
active_users AS (
    SELECT id, display_name
    FROM app_users
    WHERE disabled_at IS NULL
),
identity_choice AS (
    SELECT DISTINCT ON (ui.user_id)
        ui.user_id,
        CASE
            WHEN ui.provider = 'steam' THEN ui.provider_user_id
            ELSE 'discord:' || ui.provider_user_id
        END AS player_uid,
        COALESCE(ui.display_name, au.display_name, ui.provider || ' ' || ui.provider_user_id) AS display_name,
        ui.provider,
        ui.provider_user_id
    FROM active_users au
    JOIN user_identities ui ON ui.user_id = au.id
    ORDER BY ui.user_id, CASE WHEN ui.provider = 'steam' THEN 0 ELSE 1 END, ui.last_seen_at DESC
),
players_upsert AS (
    INSERT INTO players (player_uid, last_name, raw_last_player)
    SELECT
        player_uid,
        display_name,
        jsonb_build_object(
            'source', 'auth',
            'user_id', user_id,
            'provider', provider,
            'provider_user_id', provider_user_id
        )
    FROM identity_choice
    ON CONFLICT (player_uid) DO UPDATE
    SET
        last_name = COALESCE(players.last_name, EXCLUDED.last_name),
        updated_at = now()
    RETURNING player_uid
),
default_memberships AS (
    INSERT INTO unit_memberships (unit_id, user_id, role, grant_source)
    SELECT du.id, au.id, 'member', 'auth-default'
    FROM default_unit du
    CROSS JOIN active_users au
    ON CONFLICT DO NOTHING
    RETURNING user_id
),
default_roster AS (
    INSERT INTO unit_players (unit_id, player_uid, roster_name)
    SELECT du.id, ic.player_uid, ic.display_name
    FROM default_unit du
    JOIN identity_choice ic ON true
    JOIN players_upsert pu ON pu.player_uid = ic.player_uid
    ON CONFLICT (unit_id, player_uid) DO UPDATE
    SET
        roster_name = COALESCE(unit_players.roster_name, EXCLUDED.roster_name),
        is_active = true,
        updated_at = now()
    RETURNING player_uid
),
discord_links AS (
    SELECT
        ic.player_uid,
        ui.provider_user_id AS discord_user_id,
        ui.display_name AS discord_display_name,
        jsonb_build_object('source', 'auth', 'user_id', ui.user_id) AS raw_link
    FROM identity_choice ic
    JOIN players_upsert pu ON pu.player_uid = ic.player_uid
    JOIN user_identities ui ON ui.user_id = ic.user_id
    WHERE ui.provider = 'discord'
)
INSERT INTO player_discord_links (
    player_uid,
    discord_user_id,
    discord_display_name,
    source,
    verified_at,
    raw_link
)
SELECT player_uid, discord_user_id, discord_display_name, 'auth', now(), raw_link
FROM discord_links
ON CONFLICT (discord_user_id) DO UPDATE
SET
    player_uid = EXCLUDED.player_uid,
    discord_display_name = EXCLUDED.discord_display_name,
    source = EXCLUDED.source,
    verified_at = COALESCE(player_discord_links.verified_at, EXCLUDED.verified_at),
    raw_link = EXCLUDED.raw_link,
    updated_at = now()
WHERE player_discord_links.source = 'auth';

COMMIT;
