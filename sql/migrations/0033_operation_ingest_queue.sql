BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS operation_ingest_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    request_id TEXT NOT NULL UNIQUE REFERENCES ingest_requests(request_id) ON DELETE CASCADE,
    operation_id UUID NOT NULL REFERENCES operations(id) ON DELETE CASCADE,

    endpoint TEXT NOT NULL,
    kind TEXT NOT NULL
        CHECK (kind IN ('start', 'finish')),

    payload JSONB NOT NULL,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'failed')),

    attempt_count INTEGER NOT NULL DEFAULT 0
        CHECK (attempt_count >= 0),

    available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    locked_at TIMESTAMPTZ,
    locked_by TEXT,

    last_error_code TEXT,
    last_error_message TEXT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_operation_ingest_jobs_pending
    ON operation_ingest_jobs (available_at, created_at)
    WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_operation_ingest_jobs_operation_order
    ON operation_ingest_jobs (operation_id, created_at)
    WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_operation_ingest_jobs_status_updated_at
    ON operation_ingest_jobs (status, updated_at DESC);

COMMIT;
