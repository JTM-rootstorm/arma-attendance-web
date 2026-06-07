CREATE TABLE IF NOT EXISTS auth_link_tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_hash TEXT NOT NULL UNIQUE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    purpose TEXT NOT NULL,
    return_to TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    consumed_at TIMESTAMPTZ,
    ip_address TEXT,
    user_agent TEXT,
    CONSTRAINT auth_link_tickets_purpose_check CHECK (purpose IN ('steam_link'))
);

CREATE INDEX IF NOT EXISTS idx_auth_link_tickets_user_id ON auth_link_tickets(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_link_tickets_active
    ON auth_link_tickets(purpose, expires_at)
    WHERE consumed_at IS NULL;
