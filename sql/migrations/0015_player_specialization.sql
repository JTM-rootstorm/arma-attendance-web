BEGIN;

ALTER TABLE players
    ADD COLUMN IF NOT EXISTS specialization INTEGER NOT NULL DEFAULT 0;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.players'::regclass
          AND conname = 'players_specialization_range_check'
    ) THEN
        ALTER TABLE players
            ADD CONSTRAINT players_specialization_range_check
            CHECK (specialization BETWEEN 0 AND 4);
    END IF;
END
$$;

COMMIT;
