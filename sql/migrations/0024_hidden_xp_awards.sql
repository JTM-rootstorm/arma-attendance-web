BEGIN;

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS xp_total INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS operation_xp_awards (
    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    player_uid TEXT NOT NULL REFERENCES players(player_uid) ON DELETE CASCADE,
    tier_id UUID REFERENCES xp_reward_tiers(id) ON DELETE SET NULL,
    mission_name TEXT NOT NULL,
    mission_name_match TEXT NOT NULL,
    xp_amount INTEGER NOT NULL CHECK (xp_amount > 0),
    awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (operation_id, player_uid)
);

CREATE INDEX IF NOT EXISTS idx_operation_xp_awards_player_uid
    ON operation_xp_awards (player_uid);

CREATE INDEX IF NOT EXISTS idx_operation_xp_awards_tier_id
    ON operation_xp_awards (tier_id);

COMMIT;
