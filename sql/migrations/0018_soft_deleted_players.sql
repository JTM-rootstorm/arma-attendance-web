BEGIN;

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_players_active_last_seen
    ON players (last_seen_at DESC)
    WHERE deleted_at IS NULL;

COMMIT;
