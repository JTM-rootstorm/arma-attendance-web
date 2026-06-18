BEGIN;

CREATE TABLE IF NOT EXISTS xp_reward_tiers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mission_name_match TEXT NOT NULL,
    xp_amount INTEGER NOT NULL,
    created_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT xp_reward_tiers_mission_name_match_not_blank CHECK (length(trim(mission_name_match)) > 0),
    CONSTRAINT xp_reward_tiers_xp_amount_positive CHECK (xp_amount > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_reward_tiers_match_ci
    ON xp_reward_tiers (lower(trim(mission_name_match)));

CREATE INDEX IF NOT EXISTS idx_xp_reward_tiers_created_at
    ON xp_reward_tiers (created_at DESC);

COMMIT;
