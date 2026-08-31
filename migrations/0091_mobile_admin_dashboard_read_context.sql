BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0090') THEN
    RAISE EXCEPTION 'Migration 0091 requires migration 0090';
  END IF;
END;
$prerequisite$;

-- Existing business RPCs stay closed to mobile_admin_viewer. The sole
-- exception is a transaction-local context set inside the reviewed compact
-- dashboard wrapper while it calls the existing read-only reporting RPC.
CREATE OR REPLACE FUNCTION public.require_authenticated_profile()
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
  mobile_read_context text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO actor FROM public.profiles
  WHERE auth_user_id = auth.uid() AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION '403: active profile required' USING ERRCODE = '42501';
  END IF;
  legacy_profile_role := actor.role;

  SELECT membership.role INTO membership_role
  FROM public.organization_memberships membership
  WHERE membership.auth_user_id = auth.uid()
    AND membership.organization_id = public.current_organization_id()
    AND membership.status = 'active'
  LIMIT 1;
  IF membership_role IS NULL THEN
    RAISE EXCEPTION '403: active organization membership required'
      USING ERRCODE = '42501';
  END IF;

  mobile_read_context := current_setting('app.mobile_admin_read_context', true);
  IF membership_role = 'mobile_admin_viewer'
      AND mobile_read_context = 'compact_dashboard' THEN
    actor.role := 'admin';
  ELSIF membership_role IN ('owner', 'admin', 'accounting', 'sale') THEN
    actor.role := CASE membership_role
      WHEN 'owner' THEN 'admin'
      WHEN 'admin' THEN 'admin'
      WHEN 'accounting' THEN 'accounting'
      WHEN 'sale' THEN 'sale'
    END;
  ELSE
    RAISE EXCEPTION '403: business application access denied'
      USING ERRCODE = '42501';
  END IF;

  IF legacy_profile_role <> 'admin' AND NOT public.maintenance_access_allowed() THEN
    RAISE EXCEPTION '503: system maintenance in progress' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END;
$$;

GRANT CREATE ON SCHEMA public TO saas_rpc_executor;
SET LOCAL ROLE saas_rpc_executor;
DO $dashboard_context$
DECLARE
  dashboard_oid oid;
  definition text;
  original_call constant text := 'raw := public.rpc_get_phase5_dashboard(p_filters);';
  guarded_call constant text := $replacement$
PERFORM set_config('app.mobile_admin_read_context', 'compact_dashboard', true);
  raw := public.rpc_get_phase5_dashboard(p_filters);
  PERFORM set_config('app.mobile_admin_read_context', '', true);$replacement$;
BEGIN
  dashboard_oid := to_regprocedure('public.rpc_mobile_admin_dashboard(jsonb)');
  IF dashboard_oid IS NULL THEN
    RAISE EXCEPTION 'rpc_mobile_admin_dashboard(jsonb) is missing';
  END IF;
  definition := pg_get_functiondef(dashboard_oid);
  IF position(original_call IN definition) = 0 THEN
    RAISE EXCEPTION 'Could not locate dashboard reporting call';
  END IF;
  definition := replace(definition, original_call, guarded_call);
  EXECUTE definition;
END;
$dashboard_context$;
ALTER FUNCTION public.rpc_mobile_admin_dashboard(jsonb) VOLATILE;
RESET ROLE;
REVOKE CREATE ON SCHEMA public FROM saas_rpc_executor;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0091', 'Isolate legacy reporting behind the compact mobile dashboard read context')
ON CONFLICT (version) DO NOTHING;

COMMIT;
