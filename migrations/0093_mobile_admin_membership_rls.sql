BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0092') THEN
    RAISE EXCEPTION 'Migration 0093 requires migration 0092';
  END IF;
END;
$prerequisite$;

DROP POLICY IF EXISTS saas_rpc_executor_mobile_membership_read
  ON public.organization_memberships;
CREATE POLICY saas_rpc_executor_mobile_membership_read
ON public.organization_memberships
FOR SELECT TO saas_rpc_executor
USING (
  auth_user_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
  AND organization_id = public.current_organization_id()
  AND status = 'active'
);

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
  IF membership_role IS NULL
      OR membership_role NOT IN ('owner', 'admin', 'mobile_admin_viewer') THEN
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
VALUES ('0093', 'Scope mobile executor membership reads to the authenticated active organization')
ON CONFLICT (version) DO NOTHING;

COMMIT;
