BEGIN;

ALTER TABLE oauth_states
    ADD COLUMN IF NOT EXISTS purpose TEXT NOT NULL DEFAULT 'login',
    ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES app_users(id) ON DELETE CASCADE;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.oauth_states'::regclass
          AND conname = 'oauth_states_purpose_check'
    ) THEN
        ALTER TABLE oauth_states
            ADD CONSTRAINT oauth_states_purpose_check
            CHECK (purpose IN ('login', 'discord_refresh'));
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_oauth_states_user_purpose
    ON oauth_states (user_id, purpose, expires_at);

ALTER TABLE discord_member_snapshots
    DROP CONSTRAINT IF EXISTS discord_member_snapshots_source_check;

ALTER TABLE discord_member_snapshots
    ADD CONSTRAINT discord_member_snapshots_source_check
    CHECK (source IN ('oauth_login', 'oauth_refresh', 'oauth_refresh_absent', 'bot_snapshot', 'bot_event', 'manual_import'));

COMMIT;
