BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE units
    ADD COLUMN IF NOT EXISTS slug TEXT;

UPDATE units
SET slug = unit_key
WHERE slug IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_units_slug_unique
    ON units (slug)
    WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS unit_user_roles (
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('officer', 'admin', 'tcw_admin')),
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    granted_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    grant_source TEXT NOT NULL DEFAULT 'manual',
    PRIMARY KEY (unit_id, user_id, role)
);

INSERT INTO unit_user_roles (unit_id, user_id, role, granted_at, granted_by_user_id, grant_source)
SELECT unit_id, user_id, role, granted_at, granted_by_user_id, grant_source
FROM unit_memberships
WHERE role IN ('officer', 'admin')
ON CONFLICT (unit_id, user_id, role) DO NOTHING;

CREATE INDEX IF NOT EXISTS idx_unit_user_roles_user_role
    ON unit_user_roles (user_id, role);

CREATE TABLE IF NOT EXISTS operation_units (
    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    source TEXT NOT NULL DEFAULT 'manual'
      CHECK (source IN ('manual', 'server_key', 'mission_rule', 'import')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (operation_id, unit_id)
);

INSERT INTO operation_units (operation_id, unit_id, source)
SELECT id, unit_id, 'import'
FROM operations
WHERE unit_id IS NOT NULL
ON CONFLICT (operation_id, unit_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS unit_server_keys (
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    server_key TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (unit_id, server_key)
);

INSERT INTO unit_server_keys (unit_id, server_key)
SELECT DISTINCT unit_id, server_key
FROM operations
WHERE unit_id IS NOT NULL
  AND server_key IS NOT NULL
ON CONFLICT (unit_id, server_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS machine_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    token_kind TEXT NOT NULL CHECK (token_kind IN ('api', 'bot', 'arma_server')),
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    revoked_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_machine_tokens_active_kind
    ON machine_tokens (token_kind, is_active)
    WHERE revoked_at IS NULL;

COMMIT;
