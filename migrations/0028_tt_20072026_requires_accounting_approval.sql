BEGIN;

-- Existing installations may already have applied 0027 before TT 20/07/2026
-- was classified as restricted. Keep it print-only until Accounting explicitly
-- enables order saving from the price-list editor.
UPDATE public.pricelists
SET is_print_only = true,
    updated_at = now()
WHERE regexp_replace(
  upper(COALESCE(name, '') || ' ' || COALESCE(code, '')),
  '[^A-Z0-9]+',
  '',
  'g'
) LIKE '%TT20072026%';

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'pricelists'
      AND column_name = 'is_print_only'
  ) THEN
    RAISE EXCEPTION 'Migration 0028 stopped: is_print_only was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0028', 'Require Accounting approval before TT 20/07/2026 can persist orders')
ON CONFLICT (version) DO NOTHING;

COMMIT;
