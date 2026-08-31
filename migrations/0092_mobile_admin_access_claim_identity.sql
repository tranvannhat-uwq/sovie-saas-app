BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0091') THEN
    RAISE EXCEPTION 'Migration 0092 requires migration 0091';
  END IF;
END;
$prerequisite$;

CREATE OR REPLACE FUNCTION public.rpc_mobile_my_access()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_user_id uuid;
  membership_role text;
BEGIN
  PERFORM public.require_mobile_admin_reader();
  request_user_id := NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;

  SELECT membership.role INTO membership_role
  FROM public.organization_memberships membership
  WHERE membership.auth_user_id = request_user_id
    AND membership.organization_id = public.current_organization_id()
    AND membership.status = 'active'
  LIMIT 1;

  RETURN jsonb_build_object(
    'allowed', true,
    'membership_role', membership_role,
    'read_only', membership_role = 'mobile_admin_viewer',
    'organization_id', public.current_organization_id()
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_mobile_my_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_my_access() TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0092', 'Resolve mobile access metadata from the authenticated request claim')
ON CONFLICT (version) DO NOTHING;

COMMIT;
