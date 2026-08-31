BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0086') THEN
    RAISE EXCEPTION 'Migration 0087 requires migration 0086';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saas_rpc_executor') THEN
    RAISE EXCEPTION 'Migration 0087 requires tenant RPC executor migration 0060';
  END IF;
END;
$prerequisite$;

-- A mobile viewer remains an authenticated organization member so RLS can
-- resolve its tenant, but it is deliberately not a legacy business role.
ALTER TABLE public.organization_memberships
  DROP CONSTRAINT IF EXISTS organization_memberships_role_check;
ALTER TABLE public.organization_memberships
  ADD CONSTRAINT organization_memberships_role_check
  CHECK (role IN ('owner', 'admin', 'accounting', 'sale', 'mobile_admin_viewer'));

-- All existing business RPCs continue through this helper. Reject the mobile
-- viewer here so a captured JWT cannot call a write RPC outside the mobile UI.
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
  IF membership_role NOT IN ('owner', 'admin', 'accounting', 'sale') THEN
    RAISE EXCEPTION '403: business application access denied'
      USING ERRCODE = '42501';
  END IF;

  actor.role := CASE membership_role
    WHEN 'owner' THEN 'admin'
    WHEN 'admin' THEN 'admin'
    WHEN 'accounting' THEN 'accounting'
    WHEN 'sale' THEN 'sale'
  END;

  IF legacy_profile_role <> 'admin' AND NOT public.maintenance_access_allowed() THEN
    RAISE EXCEPTION '503: system maintenance in progress' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END;
$$;

-- This is the only authentication gate used by the compact mobile read RPCs.
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

CREATE OR REPLACE FUNCTION public.rpc_mobile_my_access()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  membership_role text;
BEGIN
  actor := public.require_mobile_admin_reader();
  SELECT membership.role INTO membership_role
  FROM public.organization_memberships membership
  WHERE membership.auth_user_id = actor.auth_user_id
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

-- A viewer may inspect SaaS context but must not mutate its default workspace.
CREATE OR REPLACE FUNCTION public.rpc_set_default_organization(p_organization_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.can_access_organization(p_organization_id) THEN
    RAISE EXCEPTION '403: organization membership required' USING ERRCODE = '42501';
  END IF;
  IF public.has_organization_role(p_organization_id, ARRAY['mobile_admin_viewer']) THEN
    RAISE EXCEPTION '403: read-only mobile identity' USING ERRCODE = '42501';
  END IF;
  UPDATE public.organization_memberships
  SET is_default = false, updated_at = now()
  WHERE auth_user_id = auth.uid() AND is_default = true;
  UPDATE public.organization_memberships
  SET is_default = true, updated_at = now()
  WHERE auth_user_id = auth.uid()
    AND organization_id = p_organization_id AND status = 'active';
  RETURN p_organization_id;
END;
$$;

-- Transfer every mobile function to the reviewed NOBYPASSRLS executor before
-- recreating it as SECURITY DEFINER. Its tenant RLS policies remain effective.
GRANT CREATE ON SCHEMA public TO saas_rpc_executor;
ALTER FUNCTION public.rpc_mobile_admin_dashboard(jsonb) OWNER TO saas_rpc_executor;
ALTER FUNCTION public.rpc_mobile_orders_paginated(text, text, int, int) OWNER TO saas_rpc_executor;
ALTER FUNCTION public.rpc_mobile_order_detail(text, text) OWNER TO saas_rpc_executor;
ALTER FUNCTION public.rpc_mobile_customers_paginated(text, int, int) OWNER TO saas_rpc_executor;
ALTER FUNCTION public.rpc_mobile_customer_detail(text) OWNER TO saas_rpc_executor;
ALTER FUNCTION public.rpc_mobile_customer_debts(text, int, int) OWNER TO saas_rpc_executor;
ALTER FUNCTION public.rpc_mobile_customer_debt_transactions(text, int, int) OWNER TO saas_rpc_executor;
ALTER FUNCTION public.rpc_mobile_employees(text, int, int, timestamptz, timestamptz) OWNER TO saas_rpc_executor;

SET LOCAL ROLE saas_rpc_executor;
DO $mobile_functions$
DECLARE
  function_item record;
  definition text;
BEGIN
  FOR function_item IN
    SELECT procedure.oid
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = ANY(ARRAY[
        'rpc_mobile_admin_dashboard', 'rpc_mobile_orders_paginated',
        'rpc_mobile_order_detail', 'rpc_mobile_customers_paginated',
        'rpc_mobile_customer_detail', 'rpc_mobile_customer_debts',
        'rpc_mobile_customer_debt_transactions', 'rpc_mobile_employees'
      ])
  LOOP
    definition := pg_get_functiondef(function_item.oid);
    definition := replace(
      definition,
      'public.require_authenticated_profile()',
      'public.require_mobile_admin_reader()'
    );
    definition := replace(definition, 'SECURITY INVOKER', 'SECURITY DEFINER');
    EXECUTE definition;
  END LOOP;
END;
$mobile_functions$;
RESET ROLE;

ALTER FUNCTION public.require_mobile_admin_reader() OWNER TO saas_rpc_executor;
ALTER FUNCTION public.rpc_mobile_my_access() OWNER TO saas_rpc_executor;
REVOKE CREATE ON SCHEMA public FROM saas_rpc_executor;

REVOKE ALL ON FUNCTION public.require_mobile_admin_reader() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.require_mobile_admin_reader() TO saas_rpc_executor;
REVOKE ALL ON FUNCTION public.rpc_mobile_my_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_my_access() TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0087', 'Add database-enforced read-only identity for mobile Admin')
ON CONFLICT (version) DO NOTHING;

COMMIT;
