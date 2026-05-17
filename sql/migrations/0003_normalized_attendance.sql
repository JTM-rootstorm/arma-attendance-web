BEGIN;

CREATE TABLE IF NOT EXISTS players (
    player_uid TEXT PRIMARY KEY,

    last_name TEXT,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    raw_last_player JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_players_last_name
    ON players (last_name)
    WHERE last_name IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_players_last_seen_at
    ON players (last_seen_at DESC);

CREATE TABLE IF NOT EXISTS operation_players (
    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,
    player_uid TEXT NOT NULL REFERENCES players(player_uid) ON DELETE CASCADE,

    name_at_start TEXT,
    name_at_end TEXT,

    side_at_start TEXT,
    side_at_end TEXT,

    group_at_start TEXT,
    group_at_end TEXT,

    role_at_start TEXT,
    role_at_end TEXT,

    unit_class_at_start TEXT,
    unit_class_at_end TEXT,

    vehicle_class_at_start TEXT,
    vehicle_class_at_end TEXT,

    present_at_start BOOLEAN NOT NULL DEFAULT false,
    present_at_end BOOLEAN NOT NULL DEFAULT false,

    raw_start_player JSONB,
    raw_end_player JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (operation_id, player_uid)
);

CREATE INDEX IF NOT EXISTS idx_operation_players_player_uid
    ON operation_players (player_uid);

CREATE INDEX IF NOT EXISTS idx_operation_players_present_start
    ON operation_players (operation_id, present_at_start)
    WHERE present_at_start = true;

CREATE INDEX IF NOT EXISTS idx_operation_players_present_end
    ON operation_players (operation_id, present_at_end)
    WHERE present_at_end = true;

CREATE TABLE IF NOT EXISTS operation_player_stats (
    operation_id UUID NOT NULL,
    player_uid TEXT NOT NULL,

    infantry_kills INTEGER NOT NULL DEFAULT 0,
    vehicle_kills INTEGER NOT NULL DEFAULT 0,
    player_kills INTEGER NOT NULL DEFAULT 0,
    ai_kills INTEGER NOT NULL DEFAULT 0,
    friendly_kills INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,

    raw_stats JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (operation_id, player_uid),

    FOREIGN KEY (operation_id, player_uid)
        REFERENCES operation_players(operation_id, player_uid)
        ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_operation_player_stats_player_uid
    ON operation_player_stats (player_uid);

COMMIT;
