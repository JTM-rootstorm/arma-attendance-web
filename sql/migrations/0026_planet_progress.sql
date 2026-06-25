BEGIN;

CREATE TABLE IF NOT EXISTS planets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    completion_percent NUMERIC(6,3) NOT NULL DEFAULT 0.000,
    display_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT planets_slug_not_blank CHECK (length(trim(slug)) > 0),
    CONSTRAINT planets_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
    CONSTRAINT planets_name_not_blank CHECK (length(trim(name)) > 0),
    CONSTRAINT planets_completion_percent_range CHECK (completion_percent >= 0 AND completion_percent <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_planets_slug_unique
    ON planets (slug);

CREATE INDEX IF NOT EXISTS idx_planets_public_sort
    ON planets (is_active, display_order, name);

ALTER TABLE xp_reward_tiers
    ADD COLUMN IF NOT EXISTS planet_id UUID REFERENCES planets(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS planet_progress_percent NUMERIC(6,3) NOT NULL DEFAULT 0.000;

ALTER TABLE xp_reward_tiers
    DROP CONSTRAINT IF EXISTS xp_reward_tiers_planet_progress_percent_range,
    ADD CONSTRAINT xp_reward_tiers_planet_progress_percent_range
        CHECK (planet_progress_percent >= 0 AND planet_progress_percent <= 100);

CREATE INDEX IF NOT EXISTS idx_xp_reward_tiers_planet_id
    ON xp_reward_tiers (planet_id);

CREATE TABLE IF NOT EXISTS operation_planet_progress_awards (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    planet_id UUID NOT NULL REFERENCES planets(id) ON DELETE CASCADE,
    tier_id UUID REFERENCES xp_reward_tiers(id) ON DELETE SET NULL,
    mission_name TEXT NOT NULL,
    mission_name_match TEXT NOT NULL,
    progress_percent NUMERIC(6,3) NOT NULL,
    awarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT operation_planet_progress_awards_percent_range
        CHECK (progress_percent >= 0 AND progress_percent <= 100)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_operation_planet_progress_awards_operation_planet
    ON operation_planet_progress_awards (operation_id, planet_id);

CREATE INDEX IF NOT EXISTS idx_operation_planet_progress_awards_planet_id
    ON operation_planet_progress_awards (planet_id);

CREATE INDEX IF NOT EXISTS idx_operation_planet_progress_awards_tier_id
    ON operation_planet_progress_awards (tier_id);

COMMIT;
