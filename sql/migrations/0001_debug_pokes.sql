BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS debug_pokes (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    request_id TEXT UNIQUE,
    server_key TEXT,
    message TEXT,

    source_ip TEXT,
    user_agent TEXT,

    payload JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_debug_pokes_created_at
    ON debug_pokes (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_debug_pokes_server_key_created_at
    ON debug_pokes (server_key, created_at DESC);

COMMIT;
