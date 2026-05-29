BEGIN;

ALTER TABLE operation_player_stats
    ADD COLUMN IF NOT EXISTS soft_vehicle_kills INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS armor_kills INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS air_kills INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS ground_vehicle_kills INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS all_vehicle_kills INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS scoreboard_score INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS stats_source TEXT,
    ADD COLUMN IF NOT EXISTS scoreboard_baseline JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS scoreboard_latest JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS raw_scoreboard_stats JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_operation_player_stats_scoreboard_source
    ON operation_player_stats (stats_source)
    WHERE stats_source IS NOT NULL;

COMMIT;
