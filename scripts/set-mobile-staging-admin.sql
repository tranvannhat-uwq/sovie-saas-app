BEGIN;

-- STAGING ONLY: promote the single active Auth-linked mobile profile to Admin.
-- Target project: mqxqswwssmemkimnolfu. Safe to run repeatedly.
SELECT set_config('app.mobile_admin_environment', 'STAGING_ONLY', true);
SELECT set_config('app.mobile_admin_project_ref', 'mqxqswwssmemkimnolfu', true);

DO $guard$
DECLARE
  linked_profile_count integer;
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Admin bootstrap refused: Supabase SQL Editor owner is required';
  END IF;
  IF current_setting('app.mobile_admin_environment', true) IS DISTINCT FROM 'STAGING_ONLY'
     OR current_setting('app.mobile_admin_project_ref', true) IS DISTINCT FROM 'mqxqswwssmemkimnolfu' THEN
    RAISE EXCEPTION 'Admin bootstrap refused: staging confirmation is missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0053') THEN
    RAISE EXCEPTION 'Admin bootstrap refused: migration 0053 is required';
  END IF;

  SELECT count(*) INTO linked_profile_count
  FROM public.profiles
  WHERE auth_user_id IS NOT NULL AND is_active = true;
  IF linked_profile_count <> 1 THEN
    RAISE EXCEPTION 'Admin bootstrap refused: expected one active Auth-linked profile, found %', linked_profile_count;
  END IF;
END
$guard$;

UPDATE public.profiles
SET role = 'admin', updated_at = now()
WHERE auth_user_id IS NOT NULL
  AND is_active = true
  AND role IS DISTINCT FROM 'admin';

SELECT id, username, display_name, role, company_id, is_active
FROM public.profiles
WHERE auth_user_id IS NOT NULL AND is_active = true;

COMMIT;
