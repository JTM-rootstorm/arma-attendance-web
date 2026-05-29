BEGIN;

ALTER TABLE units
    ADD COLUMN IF NOT EXISTS squad_xml_title TEXT,
    ADD COLUMN IF NOT EXISTS squad_xml_web_url TEXT,
    ADD COLUMN IF NOT EXISTS squad_xml_picture_filename TEXT NOT NULL DEFAULT 'logo.paa';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.units'::regclass
          AND conname = 'chk_units_squad_xml_picture_filename_paa'
    ) THEN
        ALTER TABLE units
            ADD CONSTRAINT chk_units_squad_xml_picture_filename_paa
            CHECK (squad_xml_picture_filename ~ '^[A-Za-z0-9._-]+\.paa$');
    END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_units_slug_active_public_squad_xml
    ON units (slug)
    WHERE deleted_at IS NULL AND is_active = true;

CREATE INDEX IF NOT EXISTS idx_units_unit_key_active_public_squad_xml
    ON units (unit_key)
    WHERE deleted_at IS NULL AND is_active = true;

COMMIT;
