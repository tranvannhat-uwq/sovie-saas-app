BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0089') THEN
    RAISE EXCEPTION 'Migration 0090 requires migration 0089';
  END IF;
END;
$prerequisite$;

-- Supabase's managed auth schema does not delegate GRANT OPTION to project
-- migration roles. Read the same request.jwt.claim.sub setting used by
-- auth.uid() so the NOBYPASSRLS executor needs no auth-schema privilege.
CREATE OR REPLACE FUNCTION public.require_mobile_admin_reader()
RETURNS public.profiles
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  membership_role text;
  legacy_profile_role text;
  request_user_id uuid;
BEGIN
  request_user_id := NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
  IF request_user_id IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO actor FROM public.profiles
  WHERE auth_user_id = request_user_id AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION '403: active profile required' USING ERRCODE = '42501';
  END IF;
  legacy_profile_role := actor.role;

  SELECT membership.role INTO membership_role
  FROM public.organization_memberships membership
  WHERE membership.auth_user_id = request_user_id
    AND membership.organization_id = public.current_organization_id()
    AND membership.status = 'active'
  LIMIT 1;
  IF membership_role NOT IN ('owner', 'admin', 'mobile_admin_viewer') THEN
    RAISE EXCEPTION '403: mobile admin read access required'
      USING ERRCODE = '42501';
  END IF;

  IF legacy_profile_role <> 'admin' AND NOT public.maintenance_access_allowed() THEN
    RAISE EXCEPTION '503: system maintenance in progress' USING ERRCODE = '42501';
  END IF;
  actor.role := 'admin';
  RETURN actor;
END;
$$;

REVOKE ALL ON FUNCTION public.require_mobile_admin_reader() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.require_mobile_admin_reader() TO saas_rpc_executor;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0090', 'Resolve mobile Admin identity from the authenticated request claim')
ON CONFLICT (version) DO NOTHING;

COMMIT;
