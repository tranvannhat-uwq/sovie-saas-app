-- Run only on an isolated staging database after migrations 0001..0006.
-- All fixture changes are rolled back.
BEGIN;

CREATE TEMP TABLE p0_test_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);
GRANT ALL ON TABLE pg_temp.p0_test_results TO anon, authenticated;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'This test must run on Supabase/Postgres with anon and authenticated roles';
  END IF;
END $$;

INSERT INTO auth.users(
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000001', 'authenticated', 'authenticated', 'p0-admin@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000002', 'authenticated', 'authenticated', 'p0-accounting@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000003', 'authenticated', 'authenticated', 'p0-sale@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id, auth_user_id, username, display_name, role, is_active)
VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'p0-admin@test.invalid', 'P0 Admin', 'admin', true),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'p0-accounting@test.invalid', 'P0 Accounting', 'accounting', true),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000003', 'p0-sale@test.invalid', 'P0 Sale', 'sale', true)
ON CONFLICT (id) DO UPDATE SET role = EXCLUDED.role, auth_user_id = EXCLUDED.auth_user_id, is_active = true;

INSERT INTO public.customers(id, code, name, managed_by, debt)
VALUES ('p0-customer-sale', 'P0-SALE', 'P0 Sale Customer', 'p0-sale@test.invalid', 1000)
ON CONFLICT (id) DO UPDATE SET managed_by = EXCLUDED.managed_by, debt = 1000;

INSERT INTO public.pricelists(id, name, type, price_list_type, customer_id, is_active, is_available_for_sales)
VALUES
  ('p0-public-list', 'P0 Public', 'sales', 'sales', NULL, true, true),
  ('p0-private-list', 'P0 Dealer Secret', 'dealer_private', 'dealer_private', 'p0-customer-sale', true, false)
ON CONFLICT (id) DO UPDATE SET price_list_type = EXCLUDED.price_list_type,
  type = EXCLUDED.type, customer_id = EXCLUDED.customer_id,
  is_active = EXCLUDED.is_active, is_available_for_sales = EXCLUDED.is_available_for_sales;

INSERT INTO public.products(id, code, name, brand, is_active)
VALUES ('p0-product', 'P0-PRODUCT', 'P0 Security Product', 'P0', true)
ON CONFLICT (id) DO UPDATE SET is_active = true;

INSERT INTO public.price_list_items(id, price_list_id, product_id, price)
VALUES ('p0-private-price-item', 'p0-private-list', 'p0-product', 123456)
ON CONFLICT (id) DO UPDATE SET price = EXCLUDED.price;

-- 1/2. Anon has neither table privileges nor financial RPC execution.
INSERT INTO p0_test_results VALUES (
  'anon_cannot_read_business_tables',
  NOT has_table_privilege('anon', 'public.customers', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.orders', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.pricelists', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.purchases', 'SELECT')
    AND NOT has_table_privilege('anon', 'public.supplier_debt_transactions', 'SELECT'),
  'catalog privilege check'
);
INSERT INTO p0_test_results VALUES (
  'anon_cannot_execute_financial_rpcs',
  NOT has_function_privilege('anon', 'public.rpc_confirm_order(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_record_customer_payment(text,numeric,text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_cancel_customer_payment(text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_record_sales_return(text,text,numeric,text,jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_cancel_sales_return(text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_record_sales_return(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_cancel_sales_return(text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_create_purchase(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_record_supplier_payment(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_cancel_supplier_payment(text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_cancel_purchase(text,text)', 'EXECUTE'),
  'catalog privilege check'
);

-- Helper executes as the caller and converts an expected RPC rejection to true.
CREATE FUNCTION pg_temp.private_price_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_confirm_order(jsonb_build_object(
    'id', 'p0-rejected-order', 'customerId', 'p0-customer-sale',
    'idempotencyKey', '30000000-0000-4000-8000-000000000001',
    'customerName', 'P0 Sale Customer', 'pricelistId', 'p0-private-list',
    'totalPayable', 1,
    'items', jsonb_build_array(jsonb_build_object(
      'productId', 'x', 'productCode', 'x', 'quantity', 1,
      'unitPrice', 1, 'finalUnitPrice', 1, 'priceListId', 'p0-private-list'
    ))
  ));
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.private_price_rejected() TO authenticated;

CREATE FUNCTION pg_temp.sale_adjust_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_adjust_customer_debt('p0-customer-sale', 1, 'must be rejected');
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.sale_adjust_rejected() TO authenticated;

CREATE FUNCTION pg_temp.private_draft_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  INSERT INTO public.draft_orders(
    id, customer_id, customer_name, pricelist_id, items, created_by, status
  ) VALUES (
    'p0-private-draft', 'p0-customer-sale', 'P0 Sale Customer',
    'p0-private-list', '[]'::jsonb, 'forged-admin', 'draft'
  );
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END $$;
GRANT EXECUTE ON FUNCTION pg_temp.private_draft_rejected() TO authenticated;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);

-- 3. Private list metadata and prices are invisible to sale.
INSERT INTO p0_test_results
SELECT 'sale_cannot_read_private_price_list', count(*) = 0, 'RLS row count'
FROM public.pricelists WHERE id = 'p0-private-list';
INSERT INTO p0_test_results
SELECT 'sale_cannot_read_private_price_item', count(*) = 0, 'RLS row count'
FROM public.price_list_items WHERE id = 'p0-private-price-item';

-- 4. A direct private-list ID is rejected by the RPC gate.
INSERT INTO p0_test_results
SELECT 'sale_private_price_rpc_rejected', pg_temp.private_price_rejected(), 'RPC 42501 expected';
INSERT INTO p0_test_results
SELECT 'sale_private_price_draft_rejected', pg_temp.private_draft_rejected(), 'RLS 42501 expected';
INSERT INTO p0_test_results
SELECT 'sale_financial_rpc_rejected', pg_temp.sale_adjust_rejected(), 'RPC 42501 expected';

-- 5. Sale cannot mutate debt, cashbook, or audit rows.
WITH changed AS (
  UPDATE public.customers SET debt = 999999 WHERE id = 'p0-customer-sale' RETURNING 1
)
INSERT INTO p0_test_results SELECT 'sale_cannot_update_debt', count(*) = 0, 'RLS update count' FROM changed;
INSERT INTO p0_test_results VALUES (
  'sale_has_no_cashbook_write_policy',
  NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public'
    AND tablename = 'cashbook_transactions' AND cmd <> 'SELECT'
    AND (roles = '{authenticated}' OR roles @> ARRAY['authenticated']::name[])
    AND qual NOT LIKE '%is_admin_or_accounting%'),
  'policy catalog check'
);
INSERT INTO p0_test_results VALUES (
  'sale_has_no_audit_write_grant',
  NOT has_table_privilege('authenticated', 'public.audit_logs', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.audit_logs', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.audit_logs', 'DELETE'),
  'grant check'
);

RESET ROLE;

-- 6/8. Accounting can execute its RPC, and actor is auth.uid(), not client input.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', true);
INSERT INTO p0_test_results
SELECT 'accounting_can_read_private_price_list', count(*) = 1, 'RLS row count'
FROM public.pricelists WHERE id = 'p0-private-list';
SELECT public.rpc_adjust_customer_debt('p0-customer-sale', 900, 'P0 actor test');
INSERT INTO p0_test_results
SELECT 'accounting_rpc_uses_auth_uid',
  EXISTS (
    SELECT 1 FROM public.customer_debt_transactions
    WHERE customer_id = 'p0-customer-sale'
      AND description = 'P0 actor test'
      AND created_by = '00000000-0000-0000-0000-000000000002'
  ),
  'ledger actor must equal accounting auth.uid()';
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', true);
WITH changed AS (
  UPDATE public.profiles SET display_name = 'P0 Sale Updated'
  WHERE id = '00000000-0000-0000-0000-000000000003' RETURNING 1
)
INSERT INTO p0_test_results
SELECT 'admin_can_manage_profiles', count(*) = 1, 'RLS update count' FROM changed;
RESET ROLE;

-- 7. Browser storage cannot influence these database helpers.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000003', true);
INSERT INTO p0_test_results
SELECT 'role_comes_from_database_profile', public.current_profile_role() = 'sale',
  'request contains only JWT sub; browser role is not read';
RESET ROLE;

-- Admin/accounting positive grants.
INSERT INTO p0_test_results VALUES (
  'authenticated_rpc_surface_present',
  has_function_privilege('authenticated', 'public.rpc_confirm_order(jsonb)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.rpc_record_customer_payment(text,numeric,text,text,text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.rpc_record_sales_return(jsonb)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.rpc_cancel_sales_return(text,text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.rpc_create_purchase(jsonb)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.rpc_record_supplier_payment(jsonb)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.rpc_cancel_supplier_payment(text,text)', 'EXECUTE')
    AND has_function_privilege('authenticated', 'public.rpc_cancel_purchase(text,text)', 'EXECUTE'),
  'grant check'
);

INSERT INTO p0_test_results
SELECT 'legacy_financial_overloads_are_not_executable', NOT EXISTS (
  SELECT 1
  FROM pg_proc proc
  JOIN pg_namespace ns ON ns.oid = proc.pronamespace
  WHERE ns.nspname = 'public'
    AND proc.proname IN (
      'rpc_record_customer_payment', 'rpc_cancel_customer_payment',
      'rpc_record_sales_return', 'rpc_cancel_sales_return',
      'rpc_adjust_customer_debt'
    )
    AND has_function_privilege('authenticated', proc.oid, 'EXECUTE')
    AND format('%I(%s)', proc.proname, pg_get_function_identity_arguments(proc.oid)) NOT IN (
      'rpc_record_customer_payment(p_customer_id text, p_amount numeric, p_notes text, p_payment_method text, p_idempotency_key text)',
      'rpc_cancel_customer_payment(p_cashbook_id text)',
      'rpc_record_sales_return(p_input jsonb)',
      'rpc_cancel_sales_return(p_return_id text, p_reason text)',
      'rpc_adjust_customer_debt(p_customer_id text, p_new_debt numeric, p_description text)'
    )
), 'only reviewed signatures may execute';

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM p0_test_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'P0 security tests failed:\n%', failed;
  END IF;
END $$;

TABLE p0_test_results;
ROLLBACK;
