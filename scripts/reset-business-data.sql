BEGIN;

-- Run only through run-reset-business-data.ps1. Both settings are supplied by
-- the runner after a verified backup and an explicit typed confirmation.
DO $guard$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Reset refused: database owner postgres is required';
  END IF;
  IF current_setting('app.reset_environment', true) IS DISTINCT FROM 'PRODUCTION_APPROVED'
     OR current_setting('app.reset_confirmation', true) IS DISTINCT FROM
        'DELETE_ALL_CASHBOOK_ORDERS_CUSTOMERS_PURCHASES' THEN
    RAISE EXCEPTION 'Reset refused: production confirmation settings are missing';
  END IF;
END
$guard$;

CREATE TEMP TABLE reset_preserved_counts AS
SELECT 'profiles'::text AS table_name, count(*)::bigint AS row_count FROM public.profiles
UNION ALL SELECT 'companies', count(*) FROM public.companies
UNION ALL SELECT 'brands', count(*) FROM public.brands
UNION ALL SELECT 'product_groups', count(*) FROM public.product_groups
UNION ALL SELECT 'products', count(*) FROM public.products
UNION ALL SELECT 'pricelists', count(*) FROM public.pricelists
UNION ALL SELECT 'price_list_items', count(*) FROM public.price_list_items
UNION ALL SELECT 'suppliers', count(*) FROM public.suppliers
UNION ALL SELECT 'commission_rules', count(*) FROM public.commission_rules
UNION ALL SELECT 'kpi_targets', count(*) FROM public.kpi_targets
UNION ALL SELECT 'schema_migrations', count(*) FROM public.schema_migrations;

CREATE TEMP TABLE reset_changed_counts(
  table_name text PRIMARY KEY,
  rows_changed bigint NOT NULL
);

DO $reset$
DECLARE
  target_table text;
  changed_rows bigint;
  ordered_tables text[] := ARRAY[
    'payroll_adjustments', 'payroll_entries', 'payroll_periods',
    'sales_return_items', 'sales_returns', 'commission_transactions',
    'supplier_debt_transactions', 'purchase_payments', 'purchase_items', 'purchases',
    'payments', 'customer_debt_transactions', 'cashbook_transactions',
    'order_items', 'draft_orders', 'orders',
    'customer_assignments', 'starting_balances'
  ];
BEGIN
  FOREACH target_table IN ARRAY ordered_tables LOOP
    IF to_regclass(format('public.%I', target_table)) IS NOT NULL THEN
      EXECUTE format('DELETE FROM public.%I', target_table);
      GET DIAGNOSTICS changed_rows = ROW_COUNT;
      INSERT INTO reset_changed_counts VALUES (target_table, changed_rows);
    END IF;
  END LOOP;

  -- Keep every price list and every price-list item. Only detach a list from
  -- the customer that is about to be removed so it can be assigned again.
  UPDATE public.pricelists
  SET customer_id = NULL,
      updated_at = now(),
      updated_by = 'database-owner-reset'
  WHERE customer_id IS NOT NULL;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  INSERT INTO reset_changed_counts VALUES ('pricelists_detached_from_customers', changed_rows);

  DELETE FROM public.customers;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  INSERT INTO reset_changed_counts VALUES ('customers', changed_rows);

  -- Supplier profiles remain reusable, while all balances derived from the
  -- removed purchase/payment history return to a clean zero state.
  UPDATE public.suppliers
  SET opening_debt = 0,
      total_purchase = 0,
      total_paid = 0,
      debt = 0,
      updated_at = now(),
      updated_by = 'database-owner-reset';
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  INSERT INTO reset_changed_counts VALUES ('supplier_balances_reset', changed_rows);
END
$reset$;

DO $sequences$
DECLARE
  sequence_name text;
BEGIN
  FOREACH sequence_name IN ARRAY ARRAY[
    'order_display_seq', 'cashbook_display_seq',
    'sales_return_display_seq', 'purchase_display_seq'
  ] LOOP
    IF to_regclass(format('public.%I', sequence_name)) IS NOT NULL THEN
      PERFORM setval(format('public.%I', sequence_name)::regclass, 1, false);
    END IF;
  END LOOP;
END
$sequences$;

DO $verify$
DECLARE
  mismatch text;
  remaining text;
BEGIN
  SELECT string_agg(before.table_name, ', ' ORDER BY before.table_name)
  INTO mismatch
  FROM reset_preserved_counts before
  JOIN LATERAL (
    SELECT CASE before.table_name
      WHEN 'profiles' THEN (SELECT count(*) FROM public.profiles)
      WHEN 'companies' THEN (SELECT count(*) FROM public.companies)
      WHEN 'brands' THEN (SELECT count(*) FROM public.brands)
      WHEN 'product_groups' THEN (SELECT count(*) FROM public.product_groups)
      WHEN 'products' THEN (SELECT count(*) FROM public.products)
      WHEN 'pricelists' THEN (SELECT count(*) FROM public.pricelists)
      WHEN 'price_list_items' THEN (SELECT count(*) FROM public.price_list_items)
      WHEN 'suppliers' THEN (SELECT count(*) FROM public.suppliers)
      WHEN 'commission_rules' THEN (SELECT count(*) FROM public.commission_rules)
      WHEN 'kpi_targets' THEN (SELECT count(*) FROM public.kpi_targets)
      WHEN 'schema_migrations' THEN (SELECT count(*) FROM public.schema_migrations)
    END AS row_count
  ) after ON true
  WHERE before.row_count IS DISTINCT FROM after.row_count;

  IF mismatch IS NOT NULL THEN
    RAISE EXCEPTION 'Reset rolled back because preserved tables changed row count: %', mismatch;
  END IF;

  SELECT string_agg(table_name, ', ' ORDER BY table_name)
  INTO remaining
  FROM (
    SELECT 'customers' AS table_name WHERE EXISTS (SELECT 1 FROM public.customers)
    UNION ALL SELECT 'orders' WHERE EXISTS (SELECT 1 FROM public.orders)
    UNION ALL SELECT 'draft_orders' WHERE EXISTS (SELECT 1 FROM public.draft_orders)
    UNION ALL SELECT 'sales_returns' WHERE EXISTS (SELECT 1 FROM public.sales_returns)
    UNION ALL SELECT 'cashbook_transactions' WHERE EXISTS (SELECT 1 FROM public.cashbook_transactions)
    UNION ALL SELECT 'customer_debt_transactions' WHERE EXISTS (SELECT 1 FROM public.customer_debt_transactions)
    UNION ALL SELECT 'purchases' WHERE EXISTS (SELECT 1 FROM public.purchases)
    UNION ALL SELECT 'purchase_payments' WHERE EXISTS (SELECT 1 FROM public.purchase_payments)
    UNION ALL SELECT 'supplier_debt_transactions' WHERE EXISTS (SELECT 1 FROM public.supplier_debt_transactions)
  ) leftovers;

  IF remaining IS NOT NULL THEN
    RAISE EXCEPTION 'Reset rolled back because operational rows remain: %', remaining;
  END IF;
  IF EXISTS (SELECT 1 FROM public.pricelists WHERE customer_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Reset rolled back because a price list still references a deleted customer';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.suppliers
    WHERE opening_debt <> 0 OR total_purchase <> 0 OR total_paid <> 0 OR debt <> 0
  ) THEN
    RAISE EXCEPTION 'Reset rolled back because supplier balances are not zero';
  END IF;
END
$verify$;

INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
VALUES (
  'system', 'BUSINESS_DATA_RESET', to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
  NULL,
  jsonb_build_object(
    'changed_counts', (SELECT jsonb_object_agg(table_name, rows_changed) FROM reset_changed_counts),
    'preserved_counts', (SELECT jsonb_object_agg(table_name, row_count) FROM reset_preserved_counts),
    'price_lists_deleted', 0,
    'price_list_items_deleted', 0,
    'supplier_profiles_deleted', 0,
    'catalogue_deleted', false
  ),
  'database-owner:' || current_user,
  now()
);

TABLE reset_changed_counts;
TABLE reset_preserved_counts;

COMMIT;
