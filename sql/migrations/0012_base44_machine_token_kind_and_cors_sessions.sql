BEGIN;

ALTER TABLE machine_tokens
    ADD COLUMN IF NOT EXISTS description TEXT,
    ADD COLUMN IF NOT EXISTS allowed_origin TEXT,
    ADD COLUMN IF NOT EXISTS scopes JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
DECLARE
    constraint_name text;
BEGIN
    SELECT conname
    INTO constraint_name
    FROM pg_constraint
    WHERE conrelid = 'public.machine_tokens'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%token_kind%'
    LIMIT 1;

    IF constraint_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE machine_tokens DROP CONSTRAINT %I', constraint_name);
    END IF;
END
$$;

ALTER TABLE machine_tokens
    ADD CONSTRAINT machine_tokens_token_kind_check
    CHECK (token_kind IN ('api', 'bot', 'arma_server', 'base44_integration'));

CREATE INDEX IF NOT EXISTS idx_machine_tokens_kind_active
    ON machine_tokens (token_kind, is_active)
    WHERE revoked_at IS NULL;

COMMIT;
