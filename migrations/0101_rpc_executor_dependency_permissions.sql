BEGIN;

-- Migration 0060 moved browser-callable business SECURITY DEFINER functions
-- to a tenant-scoped owner. Its dependency walk transferred ownership only
-- for SECURITY DEFINER callees, so revoked SECURITY INVOKER helpers (notably
-- p1_price_list_is_effective) were no longer executable while confirming an
-- order. Keep those helpers private and grant their complete reachable graph
-- only to the NOLOGIN RPC executor.
DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'saas_rpc_executor'
      AND NOT rolcanlogin
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION
      'Migration 0101 stopped: saas_rpc_executor must exist as NOLOGIN NOBYPASSRLS';
  END IF;
END;
$preflight$;

REVOKE ALL ON FUNCTION public.p1_price_list_is_effective(public.pricelists)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.p1_price_list_is_effective(public.pricelists)
  TO saas_rpc_executor;

DO $rpc_dependency_privileges$
DECLARE
  function_item record;
BEGIN
  FOR function_item IN
    WITH RECURSIVE functions AS (
      SELECT procedure.oid, procedure.proname, procedure.prosecdef,
        pg_get_functiondef(procedure.oid) AS definition
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = 'public'
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
    WHERE NOT has_function_privilege(
      'saas_rpc_executor', procedure.oid, 'EXECUTE'
    )
  LOOP
    EXECUTE format(
      'GRANT EXECUTE ON FUNCTION %s TO saas_rpc_executor',
      function_item.signature
    );
  END LOOP;
END;
$rpc_dependency_privileges$;

DO $verification$
DECLARE
  missing_dependencies text;
BEGIN
  IF NOT has_function_privilege(
    'saas_rpc_executor',
    'public.p1_price_list_is_effective(public.pricelists)',
    'EXECUTE'
  ) THEN
    RAISE EXCEPTION
      'Migration 0101 stopped: order price-list helper remains inaccessible to the RPC executor';
  END IF;

  IF has_function_privilege(
      'anon',
      'public.p1_price_list_is_effective(public.pricelists)',
      'EXECUTE'
    ) OR has_function_privilege(
      'authenticated',
      'public.p1_price_list_is_effective(public.pricelists)',
      'EXECUTE'
    ) THEN
    RAISE EXCEPTION
      'Migration 0101 stopped: the internal price-list helper became browser-callable';
  END IF;

  WITH RECURSIVE functions AS (
    SELECT procedure.oid, procedure.proname, procedure.prosecdef,
      pg_get_functiondef(procedure.oid) AS definition
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
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
  SELECT string_agg(procedure.oid::regprocedure::text, ', ' ORDER BY procedure.oid::regprocedure::text)
  INTO missing_dependencies
  FROM reachable
  JOIN pg_proc procedure ON procedure.oid = reachable.oid
  WHERE NOT has_function_privilege(
    'saas_rpc_executor', procedure.oid, 'EXECUTE'
  );

  IF missing_dependencies IS NOT NULL THEN
    RAISE EXCEPTION
      'Migration 0101 stopped: RPC executor lacks dependency privileges for %',
      missing_dependencies;
  END IF;
END;
$verification$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0101', 'Grant private business RPC dependencies to the tenant-scoped executor')
ON CONFLICT (version) DO NOTHING;

COMMIT;
