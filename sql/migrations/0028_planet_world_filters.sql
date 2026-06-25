BEGIN;

CREATE TABLE IF NOT EXISTS planet_world_filters (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    planet_id UUID NOT NULL REFERENCES planets(id) ON DELETE CASCADE,
    world_name_match TEXT NOT NULL,
    created_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT planet_world_filters_match_not_blank CHECK (length(trim(world_name_match)) > 0)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_planet_world_filters_planet_match_unique
    ON planet_world_filters (planet_id, lower(world_name_match));

CREATE INDEX IF NOT EXISTS idx_planet_world_filters_planet_id
    ON planet_world_filters (planet_id);

ALTER TABLE operation_planet_progress_awards
    ADD COLUMN IF NOT EXISTS world_name_match TEXT;

COMMIT;
