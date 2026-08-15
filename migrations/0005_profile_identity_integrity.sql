BEGIN;

DO $migration$
DECLARE missing_columns text;
BEGIN
  IF to_regclass('public.profiles') IS NULL THEN
    RAISE EXCEPTION 'public.profiles is missing; apply migration 0002 first';
  END IF;

  SELECT string_agg(required.column_name, ', ' ORDER BY required.column_name)
  INTO missing_columns
  FROM (VALUES
    ('id'), ('auth_user_id'), ('username'), ('role'), ('is_active'),
    ('created_at'), ('updated_at')
  ) required(column_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns actual
    WHERE actual.table_schema = 'public'
      AND actual.table_name = 'profiles'
      AND actual.column_name = required.column_name
  );

  IF missing_columns IS NOT NULL THEN
    RAISE EXCEPTION 'public.profiles is incompatible; missing columns: %', missing_columns;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.profiles
    WHERE role IS NULL OR role NOT IN ('admin', 'accounting', 'sale')
  ) THEN
    RAISE EXCEPTION 'Invalid profile roles exist; diagnose and correct them before 0005';
  END IF;

  IF EXISTS (
    SELECT auth_user_id FROM public.profiles
    WHERE auth_user_id IS NOT NULL
    GROUP BY auth_user_id HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate profiles.auth_user_id values exist; no data was changed';
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_record
    JOIN pg_attribute column_record
      ON column_record.attrelid = constraint_record.conrelid
     AND column_record.attnum = ANY(constraint_record.conkey)
    WHERE constraint_record.conrelid = 'public.profiles'::regclass
      AND constraint_record.contype = 'u'
      AND array_length(constraint_record.conkey, 1) = 1
      AND column_record.attname = 'auth_user_id'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_auth_user_id_unique UNIQUE (auth_user_id);
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_record
    WHERE constraint_record.conrelid = 'public.profiles'::regclass
      AND constraint_record.contype = 'c'
      AND pg_get_constraintdef(constraint_record.oid) LIKE '%role%admin%accounting%sale%'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_role_valid
      CHECK (role IN ('admin', 'accounting', 'sale'));
  END IF;
END
$migration$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint constraint_record
    WHERE constraint_record.conrelid = 'public.profiles'::regclass
      AND constraint_record.contype = 'f'
      AND constraint_record.confrelid = 'auth.users'::regclass
      AND pg_get_constraintdef(constraint_record.oid) LIKE 'FOREIGN KEY (auth_user_id)%'
  ) THEN
    ALTER TABLE public.profiles
      ADD CONSTRAINT profiles_auth_user_id_fkey
      FOREIGN KEY (auth_user_id) REFERENCES auth.users(id)
      ON UPDATE RESTRICT ON DELETE RESTRICT
      NOT VALID;
    ALTER TABLE public.profiles
      VALIDATE CONSTRAINT profiles_auth_user_id_fkey;
  END IF;
END
$migration$;

-- Reinstall the canonical read policy explicitly. Inactive users can still
-- read their own row so the frontend can distinguish "locked" from "missing";
-- current_profile_role() remains inactive-aware for all business access.
DROP POLICY IF EXISTS profiles_select ON public.profiles;
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (
    auth_user_id = auth.uid()
    OR public.is_admin_or_accounting()
  );

GRANT SELECT ON TABLE public.profiles TO authenticated;
REVOKE ALL ON TABLE public.profiles FROM PUBLIC, anon;

CREATE OR REPLACE FUNCTION public.rpc_my_profile_link_status()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'profile_exists', EXISTS (
      SELECT 1 FROM public.profiles WHERE auth_user_id = auth.uid()
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_my_profile_link_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_my_profile_link_status() TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0005', 'Profile/Auth identity integrity and canonical self-read policy')
ON CONFLICT (version) DO NOTHING;

-- Ask Supabase PostgREST to refresh the schema after the transaction commits.
NOTIFY pgrst, 'reload schema';

COMMIT;
