-- Read-only inventory. Run with psql against an isolated staging clone before
-- applying P0. Save the output beside the encrypted database dump.
\pset pager off
\echo 'Database identity'
SELECT current_database() AS database_name, current_user AS database_user,
       version() AS postgres_version, now() AS captured_at;

\echo 'Business table row counts'
SELECT table_name,
       (xpath('/row/count/text()', query_to_xml(
         format('SELECT count(*) AS count FROM public.%I', table_name),
         false, true, ''
       )))[1]::text::bigint AS row_count
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_type = 'BASE TABLE'
  AND table_name IN (
    'users', 'profiles', 'customers', 'products', 'product_groups',
    'pricelists', 'price_list_items', 'orders', 'order_items', 'draft_orders',
    'payments', 'customer_debt_transactions', 'cashbook_transactions',
    'sales_returns', 'sales_return_items', 'finished_goods_stock',
    'raw_materials', 'semi_finished', 'recipes', 'production_logs',
    'audit_logs', 'starting_balances', 'suppliers', 'customer_assignments',
    'commission_rules', 'commission_transactions'
  )
ORDER BY table_name;

\echo 'RLS and policies'
SELECT table_name, row_security_active(format('public.%I', table_name)::regclass) AS rls_active
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname = 'public'
ORDER BY tablename, policyname;

\echo 'RPC signatures and owners'
SELECT procedure_name, routine_type, security_type, external_language
FROM information_schema.routines
WHERE routine_schema = 'public'
ORDER BY procedure_name;

\echo 'Auth/profile linkage gaps'
DO $inventory$
DECLARE missing record;
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE NOTICE 'Legacy public.users does not exist (expected on a clean project).';
    RETURN;
  END IF;
  FOR missing IN EXECUTE $sql$
    SELECT legacy.id, legacy.username
    FROM public.users legacy
    LEFT JOIN auth.users auth_user
      ON auth_user.id::text = legacy.id OR lower(auth_user.email) = lower(legacy.username)
    WHERE auth_user.id IS NULL
  $sql$ LOOP
    RAISE NOTICE 'Unmatched legacy identity: id=%, username=%', missing.id, missing.username;
  END LOOP;
END
$inventory$;

\echo 'Prefixed schema safety check'
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'wl\_%' ESCAPE '\'
ORDER BY table_name;
