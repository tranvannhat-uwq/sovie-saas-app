BEGIN;

CREATE TABLE IF NOT EXISTS public.system_maintenance (
  id boolean PRIMARY KEY DEFAULT true CHECK (id = true),
  enabled boolean NOT NULL DEFAULT false,
  message text NOT NULL DEFAULT 'Hệ thống đang bảo trì. Vui lòng quay lại sau.' CHECK (char_length(message) <= 240),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL
);

INSERT INTO public.system_maintenance(id, enabled)
VALUES (true, false)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE public.system_maintenance ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.system_maintenance FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.maintenance_access_allowed()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    NOT COALESCE((SELECT enabled FROM public.system_maintenance WHERE id = true), false)
    OR EXISTS (
      SELECT 1 FROM public.profiles
      WHERE auth_user_id = auth.uid() AND is_active = true AND role = 'admin'
    )
$$;

CREATE OR REPLACE FUNCTION public.current_profile_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor_role text;
BEGIN
  SELECT role INTO actor_role FROM public.profiles
  WHERE auth_user_id = auth.uid() AND is_active = true
  LIMIT 1;
  IF actor_role IS NULL THEN RETURN NULL; END IF;
  IF actor_role <> 'admin' AND NOT public.maintenance_access_allowed() THEN RETURN NULL; END IF;
  RETURN actor_role;
END;
$$;

CREATE OR REPLACE FUNCTION public.current_profile_username()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT profile.username FROM public.profiles profile
  WHERE profile.auth_user_id = auth.uid()
    AND profile.is_active = true
    AND public.maintenance_access_allowed()
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.require_authenticated_profile()
RETURNS public.profiles
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO actor FROM public.profiles
  WHERE auth_user_id = auth.uid() AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION '403: active profile required' USING ERRCODE = '42501';
  END IF;
  IF actor.role <> 'admin' AND NOT public.maintenance_access_allowed() THEN
    RAISE EXCEPTION '503: system maintenance in progress' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_maintenance_status()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'enabled', enabled,
    'message', message,
    'updated_at', updated_at,
    'updated_by', updated_by
  ) FROM public.system_maintenance WHERE id = true
$$;

CREATE OR REPLACE FUNCTION public.rpc_set_maintenance_mode(p_enabled boolean, p_message text DEFAULT '')
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; result public.system_maintenance%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM public.profiles
  WHERE auth_user_id = auth.uid() AND is_active = true;
  IF NOT FOUND OR actor.role <> 'admin' THEN
    RAISE EXCEPTION '403: admin role required' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.system_maintenance(id, enabled, message, updated_at, updated_by)
  VALUES (
    true,
    COALESCE(p_enabled, false),
    COALESCE(NULLIF(btrim(p_message), ''), 'Hệ thống đang bảo trì. Vui lòng quay lại sau.'),
    now(),
    auth.uid()
  )
  ON CONFLICT (id) DO UPDATE SET
    enabled = EXCLUDED.enabled,
    message = EXCLUDED.message,
    updated_at = EXCLUDED.updated_at,
    updated_by = EXCLUDED.updated_by
  RETURNING * INTO result;
  RETURN jsonb_build_object(
    'enabled', result.enabled,
    'message', result.message,
    'updated_at', result.updated_at,
    'updated_by', result.updated_by
  );
END;
$$;

REVOKE ALL ON FUNCTION public.maintenance_access_allowed() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_get_maintenance_status() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_set_maintenance_mode(boolean, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.maintenance_access_allowed() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_maintenance_status() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_maintenance_mode(boolean, text) TO authenticated;

DO $migration$
DECLARE target record;
BEGIN
  FOR target IN
    SELECT n.nspname AS schema_name, c.relname AS table_name
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('r', 'p')
      AND c.relrowsecurity = true
      AND c.relname NOT IN ('profiles', 'system_maintenance', 'schema_migrations')
  LOOP
    EXECUTE format('DROP POLICY IF EXISTS maintenance_admin_only ON %I.%I', target.schema_name, target.table_name);
    EXECUTE format(
      'CREATE POLICY maintenance_admin_only ON %I.%I AS RESTRICTIVE FOR ALL TO authenticated USING ((SELECT public.maintenance_access_allowed())) WITH CHECK ((SELECT public.maintenance_access_allowed()))',
      target.schema_name, target.table_name
    );
  END LOOP;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0039', 'Admin-controlled maintenance mode with server-side employee access block')
ON CONFLICT(version) DO NOTHING;

COMMIT;
