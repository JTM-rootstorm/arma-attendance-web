BEGIN;

DROP INDEX IF EXISTS idx_xp_reward_tiers_planet_id;

ALTER TABLE xp_reward_tiers
    DROP COLUMN IF EXISTS planet_id;

COMMIT;
