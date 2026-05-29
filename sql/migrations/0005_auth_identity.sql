BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS app_users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    display_name TEXT,
    avatar_url TEXT,
    disabled_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS user_identities (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    provider TEXT NOT NULL CHECK (provider IN ('discord', 'steam')),
    provider_user_id TEXT NOT NULL,
    display_name TEXT,
    avatar_url TEXT,
    raw_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    linked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (provider, provider_user_id),
    UNIQUE (user_id, provider)
);

CREATE TABLE IF NOT EXISTS user_roles (
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'officer', 'viewer')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    grant_source TEXT NOT NULL DEFAULT 'manual',
    PRIMARY KEY (user_id, role)
);

CREATE TABLE IF NOT EXISTS user_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    session_token_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at TIMESTAMPTZ,
    user_agent TEXT,
    ip_address TEXT
);

CREATE TABLE IF NOT EXISTS oauth_states (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL CHECK (provider IN ('discord', 'steam')),
    redirect_after TEXT,
    code_verifier TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS admin_audit_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    actor_label TEXT NOT NULL,
    action TEXT NOT NULL,
    target_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_user_identities_user_id
    ON user_identities (user_id);

CREATE INDEX IF NOT EXISTS idx_user_roles_role
    ON user_roles (role);

CREATE INDEX IF NOT EXISTS idx_user_sessions_user_id
    ON user_sessions (user_id);

CREATE INDEX IF NOT EXISTS idx_user_sessions_expires_at
    ON user_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_oauth_states_expires_at
    ON oauth_states (expires_at);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_target_user_id
    ON admin_audit_events (target_user_id);

CREATE INDEX IF NOT EXISTS idx_admin_audit_events_created_at
    ON admin_audit_events (created_at DESC);

COMMIT;
