BEGIN;

ALTER TABLE discord_guilds
    ADD COLUMN IF NOT EXISTS guild_type TEXT NOT NULL DEFAULT 'unknown',
    ADD COLUMN IF NOT EXISTS grants_login BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS sync_members BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS is_fallback BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS unit_priority INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS rank_priority INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS permission_priority INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS config_order INTEGER NOT NULL DEFAULT 1000,
    ADD COLUMN IF NOT EXISTS config_source TEXT NOT NULL DEFAULT 'db',
    ADD COLUMN IF NOT EXISTS last_config_loaded_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_discord_guilds_login_enabled
    ON discord_guilds (grants_login, guild_type, unit_priority DESC, rank_priority DESC);

CREATE TABLE IF NOT EXISTS discord_member_snapshots (
    guild_id TEXT NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    discord_user_id TEXT NOT NULL,
    user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    role_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
    nick TEXT,
    joined_at TIMESTAMPTZ,
    member_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    source TEXT NOT NULL DEFAULT 'oauth_login'
        CHECK (source IN ('oauth_login', 'bot_snapshot', 'bot_event', 'manual_import')),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, discord_user_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_member_snapshots_user
    ON discord_member_snapshots (user_id, last_seen_at DESC);

CREATE INDEX IF NOT EXISTS idx_discord_member_snapshots_discord_user
    ON discord_member_snapshots (discord_user_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS discord_role_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id TEXT NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    role_id TEXT NOT NULL,
    mapping_type TEXT NOT NULL CHECK (
        mapping_type IN (
            'unit_primary',
            'unit_secondary',
            'rank',
            'unit_role',
            'app_role',
            'roster_status',
            'deny_login'
        )
    ),
    unit_id UUID REFERENCES units(id) ON DELETE CASCADE,
    rank_id UUID REFERENCES unit_ranks(id) ON DELETE SET NULL,
    unit_role TEXT,
    app_role TEXT,
    roster_status TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT discord_role_mappings_role_fk
        FOREIGN KEY (guild_id, role_id)
        REFERENCES discord_roles(guild_id, role_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_discord_role_mappings_guild_role
    ON discord_role_mappings (guild_id, role_id, is_enabled);

CREATE INDEX IF NOT EXISTS idx_discord_role_mappings_type
    ON discord_role_mappings (mapping_type, is_enabled, priority DESC);

CREATE TABLE IF NOT EXISTS discord_assignment_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    player_uid TEXT REFERENCES players(player_uid) ON DELETE SET NULL,
    discord_user_id TEXT,
    action TEXT NOT NULL,
    field TEXT NOT NULL,
    previous_value JSONB,
    next_value JSONB,
    winning_claim JSONB,
    ignored_claims JSONB NOT NULL DEFAULT '[]'::jsonb,
    source TEXT NOT NULL DEFAULT 'discord_reconcile',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discord_assignment_audits_user_created
    ON discord_assignment_audits (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_discord_assignment_audits_player_created
    ON discord_assignment_audits (player_uid, created_at DESC);

ALTER TABLE unit_players
    ADD COLUMN IF NOT EXISTS assignment_locked BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS assignment_priority INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS source_guild_id TEXT,
    ADD COLUMN IF NOT EXISTS source_role_id TEXT;

COMMIT;
