BEGIN;

CREATE TABLE IF NOT EXISTS discord_guilds (
    guild_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    icon_url TEXT,
    bot_user_id TEXT,
    bot_present BOOLEAN NOT NULL DEFAULT true,
    last_role_sync_at TIMESTAMPTZ,
    last_member_sync_at TIMESTAMPTZ,
    raw_guild JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_discord_guilds_updated_at
    ON discord_guilds (updated_at DESC);

CREATE TABLE IF NOT EXISTS discord_roles (
    guild_id TEXT NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    role_id TEXT NOT NULL,
    name TEXT NOT NULL,
    color INTEGER,
    position INTEGER,
    managed BOOLEAN NOT NULL DEFAULT false,
    assignable BOOLEAN NOT NULL DEFAULT true,
    is_deleted BOOLEAN NOT NULL DEFAULT false,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    raw_role JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (guild_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_discord_roles_guild_position
    ON discord_roles (guild_id, position DESC NULLS LAST);

CREATE INDEX IF NOT EXISTS idx_discord_roles_guild_name
    ON discord_roles (guild_id, name);

CREATE TABLE IF NOT EXISTS player_discord_links (
    player_uid TEXT NOT NULL REFERENCES players(player_uid) ON DELETE CASCADE,
    discord_user_id TEXT NOT NULL,
    discord_username TEXT,
    discord_display_name TEXT,
    source TEXT NOT NULL DEFAULT 'manual'
        CHECK (source IN ('manual', 'bot', 'import')),
    verified_at TIMESTAMPTZ,
    raw_link JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (player_uid, discord_user_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_player_discord_links_discord_user_id_unique
    ON player_discord_links (discord_user_id);

CREATE INDEX IF NOT EXISTS idx_player_discord_links_player_uid
    ON player_discord_links (player_uid);

CREATE TABLE IF NOT EXISTS discord_attendance_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id TEXT NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    role_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT,
    is_enabled BOOLEAN NOT NULL DEFAULT true,
    min_attendance_points INTEGER NOT NULL DEFAULT 0,
    min_operation_count INTEGER NOT NULL DEFAULT 0,
    min_attendance_percent NUMERIC(5,2),
    lookback_days INTEGER,
    server_key TEXT,
    mission_uid_pattern TEXT,
    require_present_at_end BOOLEAN NOT NULL DEFAULT false,
    include_started_operations BOOLEAN NOT NULL DEFAULT false,
    grant_mode TEXT NOT NULL DEFAULT 'grant_only'
        CHECK (grant_mode IN ('grant_only', 'grant_and_revoke_preview')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT discord_attendance_rules_role_fk
        FOREIGN KEY (guild_id, role_id)
        REFERENCES discord_roles(guild_id, role_id)
        ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_discord_attendance_rules_guild_enabled
    ON discord_attendance_rules (guild_id, is_enabled);

CREATE INDEX IF NOT EXISTS idx_discord_attendance_rules_role
    ON discord_attendance_rules (guild_id, role_id);

CREATE TABLE IF NOT EXISTS discord_role_action_audits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    guild_id TEXT NOT NULL REFERENCES discord_guilds(guild_id) ON DELETE CASCADE,
    rule_id UUID REFERENCES discord_attendance_rules(id) ON DELETE SET NULL,
    player_uid TEXT REFERENCES players(player_uid) ON DELETE SET NULL,
    discord_user_id TEXT,
    role_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('grant', 'revoke_preview', 'skip')),
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN ('planned', 'reported_success', 'reported_failure', 'skipped')),
    reason TEXT,
    error_message TEXT,
    evaluation_id UUID,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    reported_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_discord_role_action_audits_guild_created
    ON discord_role_action_audits (guild_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_discord_role_action_audits_evaluation
    ON discord_role_action_audits (evaluation_id);

CREATE INDEX IF NOT EXISTS idx_discord_role_action_audits_player
    ON discord_role_action_audits (player_uid);

COMMIT;
