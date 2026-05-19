BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS units (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    description TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    primary_discord_guild_id TEXT REFERENCES discord_guilds(guild_id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO units (unit_key, name, description)
VALUES ('tcw', 'TCW', 'Default unit')
ON CONFLICT (unit_key) DO NOTHING;

CREATE TABLE IF NOT EXISTS unit_memberships (
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('member', 'officer', 'admin')),
    granted_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    grant_source TEXT NOT NULL DEFAULT 'manual',
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (unit_id, user_id, role)
);

CREATE INDEX IF NOT EXISTS idx_unit_memberships_user_role
    ON unit_memberships (user_id, role);

CREATE TABLE IF NOT EXISTS unit_players (
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    player_uid TEXT NOT NULL REFERENCES players(player_uid) ON DELETE CASCADE,
    rank TEXT,
    roster_name TEXT,
    is_active BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (unit_id, player_uid)
);

CREATE INDEX IF NOT EXISTS idx_unit_players_player_uid
    ON unit_players (player_uid);

INSERT INTO unit_players (unit_id, player_uid, roster_name)
SELECT u.id, p.player_uid, p.last_name
FROM units u
CROSS JOIN players p
WHERE u.unit_key = 'tcw'
ON CONFLICT (unit_id, player_uid) DO NOTHING;

ALTER TABLE operations
    ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES units(id) ON DELETE SET NULL;

UPDATE operations
SET unit_id = (SELECT id FROM units WHERE unit_key = 'tcw')
WHERE unit_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_operations_unit_started_at
    ON operations (unit_id, started_at DESC);

ALTER TABLE discord_attendance_rules
    ADD COLUMN IF NOT EXISTS unit_id UUID REFERENCES units(id) ON DELETE CASCADE;

UPDATE discord_attendance_rules
SET unit_id = (SELECT id FROM units WHERE unit_key = 'tcw')
WHERE unit_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_discord_attendance_rules_unit_enabled
    ON discord_attendance_rules (unit_id, is_enabled);

CREATE TABLE IF NOT EXISTS unit_discord_guilds (
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    guild_id TEXT NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (unit_id, guild_id)
);

INSERT INTO unit_discord_guilds (unit_id, guild_id)
SELECT u.id, dg.guild_id
FROM units u
CROSS JOIN discord_guilds dg
WHERE u.unit_key = 'tcw'
ON CONFLICT (unit_id, guild_id) DO NOTHING;

ALTER TABLE user_roles DROP CONSTRAINT IF EXISTS user_roles_role_check;
ALTER TABLE user_roles
    ADD CONSTRAINT user_roles_role_check
    CHECK (role IN ('viewer', 'officer', 'admin', 'tcw_admin', 'owner'));

COMMIT;
