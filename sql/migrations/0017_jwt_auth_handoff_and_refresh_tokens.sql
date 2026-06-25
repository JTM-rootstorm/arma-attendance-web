BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE oauth_states
    ADD COLUMN IF NOT EXISTS flow_mode TEXT NOT NULL DEFAULT 'cookie';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.oauth_states'::regclass
          AND conname = 'oauth_states_flow_mode_check'
    ) THEN
        ALTER TABLE oauth_states
            ADD CONSTRAINT oauth_states_flow_mode_check
            CHECK (flow_mode IN ('cookie', 'jwt'));
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS auth_jwt_handoff_codes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code_hash TEXT NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    return_to TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    ip_address TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_jwt_handoff_codes_user
    ON auth_jwt_handoff_codes (user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_jwt_handoff_codes_expires
    ON auth_jwt_handoff_codes (expires_at);

CREATE TABLE IF NOT EXISTS auth_refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    family_id UUID NOT NULL DEFAULT gen_random_uuid(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    rotated_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    replaced_by_token_id UUID REFERENCES auth_refresh_tokens(id) ON DELETE SET NULL,
    ip_address TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_user
    ON auth_refresh_tokens (user_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_family
    ON auth_refresh_tokens (family_id);

CREATE INDEX IF NOT EXISTS idx_auth_refresh_tokens_expires
    ON auth_refresh_tokens (expires_at);

COMMIT;
