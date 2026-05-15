BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS operations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    server_key TEXT NOT NULL,

    status TEXT NOT NULL DEFAULT 'started'
        CHECK (status IN ('started', 'finished', 'abandoned')),

    mission_uid TEXT,
    mission_name TEXT,
    world_name TEXT,

    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at TIMESTAMPTZ,

    raw_start_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    raw_end_payload JSONB,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operations_started_at
    ON operations (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_operations_server_key_started_at
    ON operations (server_key, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_operations_status_started_at
    ON operations (status, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_operations_mission_uid
    ON operations (mission_uid)
    WHERE mission_uid IS NOT NULL;

CREATE TABLE IF NOT EXISTS operation_payloads (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,

    request_id TEXT NOT NULL UNIQUE,

    kind TEXT NOT NULL
        CHECK (kind IN ('start', 'finish')),

    payload JSONB NOT NULL,

    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_operation_payloads_operation_id_received_at
    ON operation_payloads (operation_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_operation_payloads_kind_received_at
    ON operation_payloads (kind, received_at DESC);

CREATE TABLE IF NOT EXISTS ingest_requests (
    request_id TEXT PRIMARY KEY,

    operation_id UUID REFERENCES operations(id) ON DELETE SET NULL,

    endpoint TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    response JSONB NOT NULL DEFAULT '{}'::jsonb,

    received_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingest_requests_operation_id
    ON ingest_requests (operation_id);

CREATE INDEX IF NOT EXISTS idx_ingest_requests_received_at
    ON ingest_requests (received_at DESC);

COMMIT;
