-- Run only on isolated Supabase staging after migration 0101.
BEGIN;

CREATE TEMP TABLE rpc_dependency_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);

INSERT INTO rpc_dependency_results
SELECT 'price_list_helper_is_executor_only',
  has_function_privilege(
    'saas_rpc_executor',
    'public.p1_price_list_is_effective(public.pricelists)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.p1_price_list_is_effective(public.pricelists)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.p1_price_list_is_effective(public.pricelists)',
    'EXECUTE'
  ),
  format(
    'executor=%s, authenticated=%s, anon=%s',
    has_function_privilege(
      'saas_rpc_executor',
      'public.p1_price_list_is_effective(public.pricelists)',
      'EXECUTE'
    ),
    has_function_privilege(
      'authenticated',
      'public.p1_price_list_is_effective(public.pricelists)',
      'EXECUTE'
    ),
    has_function_privilege(
      'anon',
      'public.p1_price_list_is_effective(public.pricelists)',
      'EXECUTE'
    )
  );

INSERT INTO rpc_dependency_results
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
SELECT 'all_business_rpc_dependencies_are_executable',
  count(*) FILTER (
    WHERE NOT has_function_privilege(
      'saas_rpc_executor', procedure.oid, 'EXECUTE'
    )
  ) = 0,
  format(
    'reachable=%s, missing=%s',
    count(*),
    count(*) FILTER (
      WHERE NOT has_function_privilege(
        'saas_rpc_executor', procedure.oid, 'EXECUTE'
      )
    )
  )
FROM reachable
JOIN pg_proc procedure ON procedure.oid = reachable.oid;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed
  FROM rpc_dependency_results
  WHERE NOT passed;

  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'SaaS RPC dependency permission tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE rpc_dependency_results;
ROLLBACK;
