BEGIN;

-- Database-owner staging reset only. The runner must set both local settings.
DO $guard$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Reset refused: database owner postgres is required';
  END IF;
  IF current_setting('app.reset_environment', true) IS DISTINCT FROM 'STAGING_ONLY'
     OR current_setting('app.reset_confirmation', true) IS DISTINCT FROM 'DELETE_OPERATIONAL_TEST_DATA' THEN
    RAISE EXCEPTION 'Reset refused: staging confirmation settings are missing';
  END IF;
  IF EXISTS (SELECT 1 FROM public.pricelists WHERE customer_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Reset refused: one or more preserved price lists still reference a customer';
  END IF;
END
$guard$;

CREATE TEMP TABLE p6_preserved_counts AS
SELECT 'profiles'::text AS table_name, count(*)::bigint AS row_count FROM public.profiles
UNION ALL SELECT 'companies', count(*) FROM public.companies
UNION ALL SELECT 'brands', count(*) FROM public.brands
UNION ALL SELECT 'product_groups', count(*) FROM public.product_groups
UNION ALL SELECT 'products', count(*) FROM public.products
UNION ALL SELECT 'pricelists', count(*) FROM public.pricelists
UNION ALL SELECT 'price_list_items', count(*) FROM public.price_list_items
UNION ALL SELECT 'commission_rules', count(*) FROM public.commission_rules
UNION ALL SELECT 'schema_migrations', count(*) FROM public.schema_migrations;

CREATE TEMP TABLE p6_deleted_counts(table_name text PRIMARY KEY, rows_deleted bigint NOT NULL);

DO $delete$
DECLARE
  target_table text;
  deleted_rows bigint;
  ordered_tables text[] := ARRAY[
    'payroll_adjustments', 'payroll_entries', 'payroll_periods', 'kpi_targets',
    'sales_return_items', 'sales_returns', 'commission_transactions',
    'supplier_debt_transactions', 'purchase_payments', 'purchase_items', 'purchases',
    'payments', 'customer_debt_transactions', 'cashbook_transactions',
    'order_items', 'draft_orders', 'orders',
    'customer_assignments', 'starting_balances', 'customers', 'suppliers'
  ];
BEGIN
  FOREACH target_table IN ARRAY ordered_tables LOOP
    IF to_regclass(format('public.%I', target_table)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I', target_table);
      GET DIAGNOSTICS deleted_rows = ROW_COUNT;
      INSERT INTO p6_deleted_counts VALUES (target_table, deleted_rows);
    END IF;
  END LOOP;
END
$delete$;

-- A clean test environment may restart display numbers because every owning
-- operational row was removed in the same transaction.
SELECT setval('public.order_display_seq', 1, false);
SELECT setval('public.cashbook_display_seq', 1, false);
SELECT setval('public.sales_return_display_seq', 1, false);
SELECT setval('public.purchase_display_seq', 1, false);

DO $verify$
DECLARE mismatch text;
BEGIN
  SELECT string_agg(before.table_name, ', ' ORDER BY before.table_name)
  INTO mismatch
  FROM p6_preserved_counts before
  JOIN LATERAL (
    SELECT CASE before.table_name
      WHEN 'profiles' THEN (SELECT count(*) FROM public.profiles)
      WHEN 'companies' THEN (SELECT count(*) FROM public.companies)
      WHEN 'brands' THEN (SELECT count(*) FROM public.brands)
      WHEN 'product_groups' THEN (SELECT count(*) FROM public.product_groups)
      WHEN 'products' THEN (SELECT count(*) FROM public.products)
      WHEN 'pricelists' THEN (SELECT count(*) FROM public.pricelists)
      WHEN 'price_list_items' THEN (SELECT count(*) FROM public.price_list_items)
      WHEN 'commission_rules' THEN (SELECT count(*) FROM public.commission_rules)
      WHEN 'schema_migrations' THEN (SELECT count(*) FROM public.schema_migrations)
    END AS row_count
  ) after ON true
  WHERE before.row_count IS DISTINCT FROM after.row_count;

  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'Reset rolled back because preserved tables changed: %', mismatch;
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers)
     OR EXISTS (SELECT 1 FROM public.orders)
     OR EXISTS (SELECT 1 FROM public.cashbook_transactions)
     OR EXISTS (SELECT 1 FROM public.purchases)
     OR EXISTS (SELECT 1 FROM public.suppliers) THEN
    RAISE EXCEPTION 'Reset rolled back because operational rows remain';
  END IF;
END
$verify$;

INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
VALUES (
  'system', 'STAGING_TEST_DATA_RESET', to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
  NULL,
  jsonb_build_object(
    'deleted_counts', (SELECT jsonb_object_agg(table_name, rows_deleted) FROM p6_deleted_counts),
    'preserved_counts', (SELECT jsonb_object_agg(table_name, row_count) FROM p6_preserved_counts),
    'warehouse_and_production_tables_touched', false
  ),
  'database-owner:' || current_user,
  now()
);

TABLE p6_deleted_counts;
TABLE p6_preserved_counts;

COMMIT;

