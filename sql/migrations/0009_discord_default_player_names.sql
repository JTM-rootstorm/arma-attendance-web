BEGIN;

WITH steam_auth_players AS (
    SELECT
        p.player_uid,
        COALESCE(ui_discord.display_name, au.display_name) AS discord_default_name
    FROM players p
    JOIN user_identities ui_steam
        ON ui_steam.provider = 'steam'
        AND ui_steam.provider_user_id = p.player_uid
    JOIN app_users au ON au.id = ui_steam.user_id
    LEFT JOIN user_identities ui_discord
        ON ui_discord.user_id = au.id
        AND ui_discord.provider = 'discord'
    WHERE p.raw_last_player->>'source' = 'auth'
      AND p.last_name = p.player_uid
      AND COALESCE(ui_discord.display_name, au.display_name) IS NOT NULL
),
players_update AS (
    UPDATE players p
    SET
        last_name = sap.discord_default_name,
        raw_last_player = jsonb_set(
            COALESCE(p.raw_last_player, '{}'::jsonb),
            '{display_name}',
            to_jsonb(sap.discord_default_name),
            true
        ),
        updated_at = now()
    FROM steam_auth_players sap
    WHERE p.player_uid = sap.player_uid
    RETURNING p.player_uid, sap.discord_default_name
)
UPDATE unit_players up
SET
    roster_name = pu.discord_default_name,
    updated_at = now()
FROM players_update pu
WHERE up.player_uid = pu.player_uid
  AND up.roster_name = up.player_uid;

COMMIT;
