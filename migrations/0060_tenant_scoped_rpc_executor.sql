BEGIN;

-- Run business RPCs as a non-login, non-BYPASSRLS owner instead of the
-- database owner. This lets one reviewed tenant policy constrain the mature
-- financial function graph without trusting tenant ids from the browser.
DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saas_rpc_executor') THEN
    CREATE ROLE saas_rpc_executor NOLOGIN NOBYPASSRLS;
  END IF;
END;
$role$;

ALTER ROLE saas_rpc_executor NOLOGIN NOBYPASSRLS;
-- Supabase's dashboard migration role has CREATEROLE but is intentionally not
-- a superuser; membership is required before it may transfer function owners.
DO $executor_admin$
BEGIN
  EXECUTE format('GRANT saas_rpc_executor TO %I', current_user);
END;
$executor_admin$;
GRANT USAGE, CREATE ON SCHEMA public TO saas_rpc_executor;

-- Preserve legacy function contracts while making the active organization
-- membership authoritative. owner maps to admin for compatibility.
CREATE OR REPLACE FUNCTION public.current_profile_role()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  membership_role text;
  legacy_profile_role text;
BEGIN
  SELECT profile.role INTO legacy_profile_role
  FROM public.profiles profile
  WHERE profile.auth_user_id = auth.uid() AND profile.is_active = true
  LIMIT 1;

  IF legacy_profile_role IS NULL THEN RETURN NULL; END IF;
  IF legacy_profile_role <> 'admin' AND NOT public.maintenance_access_allowed() THEN
    RETURN NULL;
  END IF;

  SELECT membership.role INTO membership_role
  FROM public.organization_memberships membership
  WHERE membership.auth_user_id = auth.uid()
    AND membership.organization_id = public.current_organization_id()
    AND membership.status = 'active'
  LIMIT 1;

  RETURN CASE membership_role
    WHEN 'owner' THEN 'admin'
    WHEN 'admin' THEN 'admin'
    WHEN 'accounting' THEN 'accounting'
    WHEN 'sale' THEN 'sale'
    ELSE NULL
  END;
END;
$$;

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

GRANT EXECUTE ON FUNCTION public.current_organization_id() TO saas_rpc_executor;
GRANT EXECUTE ON FUNCTION public.current_profile_role() TO saas_rpc_executor;
GRANT EXECUTE ON FUNCTION public.current_profile_username() TO saas_rpc_executor;
GRANT EXECUTE ON FUNCTION public.require_authenticated_profile() TO saas_rpc_executor;
GRANT EXECUTE ON FUNCTION public.is_admin() TO saas_rpc_executor;
GRANT EXECUTE ON FUNCTION public.is_admin_or_accounting() TO saas_rpc_executor;
GRANT EXECUTE ON FUNCTION public.get_current_username() TO saas_rpc_executor;
GRANT EXECUTE ON FUNCTION public.maintenance_access_allowed() TO saas_rpc_executor;
GRANT EXECUTE ON FUNCTION public.can_access_organization(uuid) TO saas_rpc_executor;
GRANT EXECUTE ON FUNCTION public.has_organization_role(uuid, text[]) TO saas_rpc_executor;

DO $tenant_rpc_tables$
DECLARE
  table_name text;
  business_tables constant text[] := ARRAY[
    'companies', 'customers', 'brands', 'product_groups', 'products',
    'pricelists', 'price_list_items', 'orders', 'draft_orders', 'order_items',
    'cashbook_transactions', 'payments', 'sales_returns', 'sales_return_items',
    'customer_debt_transactions', 'finished_goods_stock', 'raw_materials',
    'semi_finished', 'recipes', 'production_logs', 'audit_logs',
    'commission_transactions', 'customer_assignments', 'commission_rules',
    'starting_balances', 'suppliers', 'purchases', 'purchase_items',
    'purchase_payments', 'supplier_debt_transactions', 'kpi_targets',
    'payroll_periods', 'payroll_adjustments', 'payroll_entries', 'activity_logs'
  ];
BEGIN
  FOREACH table_name IN ARRAY business_tables LOOP
    EXECUTE format(
      'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO saas_rpc_executor',
      table_name
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS saas_rpc_executor_tenant_scope ON public.%I',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY saas_rpc_executor_tenant_scope ON public.%I FOR ALL TO saas_rpc_executor USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id())',
      table_name
    );
  END LOOP;
END;
$tenant_rpc_tables$;

-- Reporting may resolve employee display identities, but never profiles from
-- an unrelated organization.
GRANT SELECT ON TABLE public.profiles TO saas_rpc_executor;
DROP POLICY IF EXISTS saas_rpc_executor_profile_scope ON public.profiles;
CREATE POLICY saas_rpc_executor_profile_scope ON public.profiles
FOR SELECT TO saas_rpc_executor
USING (
  auth_user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.organization_memberships membership
    WHERE membership.auth_user_id = profiles.auth_user_id
      AND membership.organization_id = public.current_organization_id()
      AND membership.status = 'active'
  )
);

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO saas_rpc_executor;

-- Find every authenticated business SECURITY DEFINER and every public
-- SECURITY DEFINER it calls recursively. Identity/control-plane helpers remain
-- database-owned because they are already auth.uid()-scoped and are used by RLS.
DO $tenant_rpc_graph$
DECLARE
  function_item record;
BEGIN
  FOR function_item IN
    WITH RECURSIVE functions AS (
      SELECT p.oid, p.proname, p.prosecdef,
        pg_get_functiondef(p.oid) AS definition
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE n.nspname = 'public'
    ), roots AS (
      SELECT function.oid
      FROM functions function
      WHERE function.prosecdef
        AND has_function_privilege('authenticated', function.oid, 'EXECUTE')
        AND function.definition ~* '\m(companies|brands|products|product_groups|pricelists|price_list_items|customers|orders|order_items|draft_orders|customer_debt_transactions|cashbook_transactions|payments|supplier_debt_transactions|suppliers|purchases|purchase_items|purchase_payments|sales_returns|sales_return_items|commission_transactions|payroll_periods|payroll_adjustments|payroll_entries|audit_logs|activity_logs)\M'
    ), edges AS (
      SELECT caller.oid AS caller_oid, callee.oid AS callee_oid
      FROM functions caller
      JOIN functions callee ON caller.oid <> callee.oid
      WHERE caller.definition ~ ('public\.' || callee.proname || '\s*\(')
    ), reachable(oid) AS (
      SELECT oid FROM roots
      UNION
      SELECT edge.callee_oid
      FROM reachable parent
      JOIN edges edge ON edge.caller_oid = parent.oid
    )
    SELECT DISTINCT procedure.oid::regprocedure AS signature
    FROM reachable
    JOIN pg_proc procedure ON procedure.oid = reachable.oid
    WHERE procedure.prosecdef
      AND procedure.proname NOT IN (
        'current_profile_role', 'current_profile_username',
        'require_authenticated_profile', 'is_admin', 'is_admin_or_accounting',
        'get_current_username', 'maintenance_access_allowed',
        'can_access_organization', 'has_organization_role',
        'current_organization_id'
      )
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO saas_rpc_executor',
      function_item.signature);
  END LOOP;
END;
$tenant_rpc_graph$;

-- Ownership transfer requires CREATE temporarily; runtime execution does not.
REVOKE CREATE ON SCHEMA public FROM saas_rpc_executor;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0060', 'Run browser business RPC graphs as a tenant-scoped non-BYPASSRLS executor')
ON CONFLICT (version) DO NOTHING;

COMMIT;
