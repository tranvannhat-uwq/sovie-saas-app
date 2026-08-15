BEGIN;

-- Compatibility repair for legacy suppliers schemas upgraded through 0009.
-- Migration 0009 RPCs update suppliers.updated_at, while some legacy schemas
-- only had suppliers.created_at. Existing rows are preserved.
ALTER TABLE public.suppliers
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'suppliers'
      AND column_name = 'updated_at'
  ) THEN
    RAISE EXCEPTION 'Migration 0010 stopped: suppliers.updated_at was not created';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0010', 'Legacy supplier updated_at compatibility for Phase 4 RPCs')
ON CONFLICT (version) DO NOTHING;

COMMIT;
