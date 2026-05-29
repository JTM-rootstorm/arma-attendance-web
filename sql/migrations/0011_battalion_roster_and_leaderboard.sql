BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE units
    ADD COLUMN IF NOT EXISTS display_name TEXT,
    ADD COLUMN IF NOT EXISTS callsign TEXT,
    ADD COLUMN IF NOT EXISTS emblem_url TEXT,
    ADD COLUMN IF NOT EXISTS sort_order INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

ALTER TABLE unit_players
    ADD COLUMN IF NOT EXISTS rank_sort INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS roster_status TEXT NOT NULL DEFAULT 'active',
    ADD COLUMN IF NOT EXISTS joined_unit_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS left_unit_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS assignment_source TEXT NOT NULL DEFAULT 'manual';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.unit_players'::regclass
          AND conname = 'unit_players_roster_status_check'
    ) THEN
        ALTER TABLE unit_players
            ADD CONSTRAINT unit_players_roster_status_check
            CHECK (roster_status IN ('active', 'reserve', 'loa', 'inactive'));
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS unit_ranks (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    rank_key TEXT NOT NULL,
    name TEXT NOT NULL,
    short_name TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (unit_id, rank_key)
);

ALTER TABLE unit_players
    ADD COLUMN IF NOT EXISTS rank_id UUID REFERENCES unit_ranks(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_unit_ranks_unit_sort
    ON unit_ranks (unit_id, sort_order, name)
    WHERE is_active = true;

CREATE TABLE IF NOT EXISTS unit_squads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    parent_squad_id UUID REFERENCES unit_squads(id) ON DELETE CASCADE,
    squad_key TEXT NOT NULL,
    name TEXT NOT NULL,
    squad_type TEXT NOT NULL DEFAULT 'squad',
    hierarchy_mode TEXT NOT NULL DEFAULT 'flat',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (unit_id, squad_key)
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.unit_squads'::regclass
          AND conname = 'unit_squads_squad_type_check'
    ) THEN
        ALTER TABLE unit_squads
            ADD CONSTRAINT unit_squads_squad_type_check
            CHECK (squad_type IN ('company', 'platoon', 'squad', 'fireteam', 'detachment'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.unit_squads'::regclass
          AND conname = 'unit_squads_hierarchy_mode_check'
    ) THEN
        ALTER TABLE unit_squads
            ADD CONSTRAINT unit_squads_hierarchy_mode_check
            CHECK (hierarchy_mode IN ('flat', 'tree'));
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_unit_squads_unit_parent_sort
    ON unit_squads (unit_id, parent_squad_id, sort_order)
    WHERE is_active = true;

CREATE TABLE IF NOT EXISTS unit_roster_assignments (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
    player_uid TEXT NOT NULL REFERENCES players(player_uid) ON DELETE CASCADE,
    squad_id UUID REFERENCES unit_squads(id) ON DELETE SET NULL,
    billet TEXT NOT NULL DEFAULT 'trooper',
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_primary BOOLEAN NOT NULL DEFAULT true,
    assignment_source TEXT NOT NULL DEFAULT 'manual',
    assigned_by_user_id UUID REFERENCES app_users(id) ON DELETE SET NULL,
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.unit_roster_assignments'::regclass
          AND conname = 'unit_roster_assignments_billet_check'
    ) THEN
        ALTER TABLE unit_roster_assignments
            ADD CONSTRAINT unit_roster_assignments_billet_check
            CHECK (billet IN ('unassigned', 'squad_lead', 'fireteam_lead', 'trooper'));
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.unit_roster_assignments'::regclass
          AND conname = 'unit_roster_assignments_assignment_source_check'
    ) THEN
        ALTER TABLE unit_roster_assignments
            ADD CONSTRAINT unit_roster_assignments_assignment_source_check
            CHECK (assignment_source IN ('manual', 'discord', 'import', 'system'));
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_unit_roster_assignments_one_active_primary
    ON unit_roster_assignments (unit_id, player_uid)
    WHERE ended_at IS NULL AND is_primary = true;

CREATE INDEX IF NOT EXISTS idx_unit_roster_assignments_unit_squad
    ON unit_roster_assignments (unit_id, squad_id, sort_order)
    WHERE ended_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_unit_roster_assignments_player
    ON unit_roster_assignments (player_uid)
    WHERE ended_at IS NULL;

COMMIT;
