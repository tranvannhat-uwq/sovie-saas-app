-- Run only on isolated Supabase staging after migration 0057.
BEGIN;

CREATE TEMP TABLE tenant_envelope_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);

WITH expected(table_name) AS (
  SELECT unnest(ARRAY[
    'companies', 'customers', 'brands', 'product_groups', 'products',
    'pricelists', 'price_list_items', 'orders', 'draft_orders', 'order_items',
    'cashbook_transactions', 'payments', 'sales_returns', 'sales_return_items',
    'customer_debt_transactions', 'finished_goods_stock', 'raw_materials',
    'semi_finished', 'recipes', 'production_logs', 'audit_logs',
    'commission_transactions', 'customer_assignments', 'commission_rules',
    'starting_balances', 'suppliers', 'purchases', 'purchase_items',
    'purchase_payments', 'supplier_debt_transactions', 'kpi_targets',
    'payroll_periods', 'payroll_adjustments', 'payroll_entries', 'activity_logs'
  ]::text[])
), actual AS (
  SELECT table_name
  FROM information_schema.columns
  WHERE table_schema = 'public' AND column_name = 'organization_id'
)
INSERT INTO tenant_envelope_results
SELECT 'all_business_tables_have_organization_id',
  NOT EXISTS (SELECT table_name FROM expected EXCEPT SELECT table_name FROM actual),
  COALESCE((SELECT string_agg(table_name, ', ')
    FROM (SELECT table_name FROM expected EXCEPT SELECT table_name FROM actual) missing), 'none missing');

DO $verify_backfill$
DECLARE
  table_name text;
  null_count bigint;
  wrong_legacy_count bigint;
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
      'SELECT count(*), count(*) FILTER (WHERE organization_id <> $1) FROM public.%I WHERE organization_id IS NULL OR organization_id <> $1',
      table_name
    ) INTO null_count, wrong_legacy_count
      USING '00000000-0000-4000-8000-000000000001'::uuid;
    INSERT INTO tenant_envelope_results VALUES (
      'legacy_backfill_' || table_name,
      null_count = 0 AND wrong_legacy_count = 0,
      format('unassigned_or_wrong=%s', null_count)
    );
  END LOOP;
END;
$verify_backfill$;

INSERT INTO tenant_envelope_results
SELECT 'all_foreign_keys_are_validated',
  count(*) >= 35 AND bool_and(convalidated),
  format('validated=%s total=%s', count(*) FILTER (WHERE convalidated), count(*))
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
  AND conname LIKE '%\_organization\_id\_fkey' ESCAPE '\';

INSERT INTO tenant_envelope_results
SELECT 'guard_function_is_not_browser_callable',
  NOT has_function_privilege('anon', 'public.enforce_business_row_organization()', 'EXECUTE')
    AND NOT has_function_privilege('authenticated', 'public.enforce_business_row_organization()', 'EXECUTE'),
  'trigger function execute privilege';

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM tenant_envelope_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'SaaS tenant-envelope tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE tenant_envelope_results;
ROLLBACK;
