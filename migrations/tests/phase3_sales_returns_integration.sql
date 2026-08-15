-- Run only on an isolated Supabase staging database after migrations 0001..0008.
-- All fixtures and mutations are rolled back.
BEGIN;

CREATE TEMP TABLE phase3_test_results(
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);
GRANT ALL ON TABLE pg_temp.phase3_test_results TO authenticated;

INSERT INTO auth.users(instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'p3-accounting@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'p3-sale@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id, auth_user_id, username, display_name, role, is_active)
VALUES
  ('p3-accounting', '50000000-0000-4000-8000-000000000001', 'p3-accounting@test.invalid', 'P3 Accounting', 'accounting', true),
  ('p3-sale', '50000000-0000-4000-8000-000000000002', 'p3-sale@test.invalid', 'P3 Sale', 'sale', true)
ON CONFLICT DO NOTHING;

UPDATE public.profiles
SET username = fixture.username, display_name = fixture.display_name,
    role = fixture.role, is_active = true
FROM (VALUES
  ('50000000-0000-4000-8000-000000000001'::uuid, 'p3-accounting@test.invalid', 'P3 Accounting', 'accounting'),
  ('50000000-0000-4000-8000-000000000002'::uuid, 'p3-sale@test.invalid', 'P3 Sale', 'sale')
) AS fixture(auth_user_id, username, display_name, role)
WHERE public.profiles.auth_user_id = fixture.auth_user_id;

INSERT INTO public.customers(
  id, code, name, managed_by, debt, total_transaction, total_return,
  net_revenue, status, deleted_at
) VALUES
  ('p3-customer-partial', 'P3-PARTIAL', 'P3 Partial Customer', 'p3-sale@test.invalid', 50000, 180000, 0, 180000, 'active', NULL),
  ('p3-customer-full', 'P3-FULL', 'P3 Full Customer', 'p3-sale@test.invalid', 180000, 180000, 0, 180000, 'active', NULL)
ON CONFLICT (id) DO UPDATE SET debt = EXCLUDED.debt,
  total_transaction = EXCLUDED.total_transaction, total_return = 0,
  net_revenue = EXCLUDED.net_revenue, status = 'active', deleted_at = NULL;

INSERT INTO public.orders(
  id, customer_id, customer_name, items, subtotal, total_payable, total_amount,
  debt_amount, paid_amount, returned_amount, net_revenue, status, salesperson_id,
  created_by, order_date, created_at
) VALUES
  ('P3-ORDER-PARTIAL', 'p3-customer-partial', 'P3 Partial Customer', '[]'::jsonb,
    200000, 180000, 180000, 180000, 0, 0, 180000, 'settled', 'p3-sale@test.invalid',
    '50000000-0000-4000-8000-000000000001', now(), now()),
  ('P3-ORDER-FULL', 'p3-customer-full', 'P3 Full Customer', '[]'::jsonb,
    200000, 180000, 180000, 180000, 0, 0, 180000, 'settled', 'p3-sale@test.invalid',
    '50000000-0000-4000-8000-000000000001', now(), now())
ON CONFLICT (id) DO UPDATE SET status = 'settled', returned_amount = 0,
  net_revenue = 180000, cancelled_at = NULL;

INSERT INTO public.order_items(
  id, order_id, product_id, variant_id, variant_code_snapshot,
  product_name_snapshot, packaging_name_snapshot, specification_snapshot,
  unit_snapshot, quantity, unit_price, final_unit_price, line_total,
  returned_quantity, returned_amount, net_amount
) VALUES
  ('P3-PARTIAL-I1', 'P3-ORDER-PARTIAL', 'p3-product-1', 'p3-variant-1', 'P3-SKU-1', 'P3 Product 1', 'Thùng', 'Thùng 20kg', 'Thùng', 1, 100000, 100000, 100000, 0, 0, 100000),
  ('P3-PARTIAL-I2', 'P3-ORDER-PARTIAL', 'p3-product-2', 'p3-variant-2', 'P3-SKU-2', 'P3 Product 2', 'Lon', 'Lon 5kg', 'Lon', 1, 100000, 100000, 100000, 0, 0, 100000),
  ('P3-FULL-I1', 'P3-ORDER-FULL', 'p3-product-1', 'p3-variant-1', 'P3-SKU-1', 'P3 Product 1', 'Thùng', 'Thùng 20kg', 'Thùng', 1, 100000, 100000, 100000, 0, 0, 100000),
  ('P3-FULL-I2', 'P3-ORDER-FULL', 'p3-product-2', 'p3-variant-2', 'P3-SKU-2', 'P3 Product 2', 'Lon', 'Lon 5kg', 'Lon', 1, 100000, 100000, 100000, 0, 0, 100000)
ON CONFLICT (id) DO UPDATE SET returned_quantity = 0, returned_amount = 0,
  net_amount = EXCLUDED.net_amount;

INSERT INTO public.commission_transactions(
  id, employee_id, order_id, transaction_type, calculation_basis,
  basis_amount, commission_rate, commission_amount, status
) VALUES
  ('P3-COMM-PARTIAL', 'p3-sale@test.invalid', 'P3-ORDER-PARTIAL', 'order_commission', 'revenue', 180000, 10, 18000, 'pending'),
  ('P3-COMM-FULL', 'p3-sale@test.invalid', 'P3-ORDER-FULL', 'order_commission', 'revenue', 180000, 10, 18000, 'pending')
ON CONFLICT (id) DO UPDATE SET basis_amount = 180000, commission_amount = 18000;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000001', true);

CREATE TEMP TABLE p3_partial_first AS
SELECT public.rpc_record_sales_return(jsonb_build_object(
  'orderId', 'P3-ORDER-PARTIAL',
  'reason', 'P3 canonical partial return',
  'paymentMethod', 'bank',
  'idempotencyKey', 'P3-RETURN-KEY-0001',
  'totalRefund', 1,
  'items', jsonb_build_array(jsonb_build_object(
    'saleItemId', 'P3-PARTIAL-I1', 'quantity', 1,
    'refundPrice', 1, 'subtotal', 1
  ))
)) AS result;

INSERT INTO phase3_test_results
SELECT 'backend_calculates_refund_and_splits_debt_from_cash',
  (result->>'total_refund')::numeric = 90000
  AND (result->>'debt_reduction')::numeric = 50000
  AND (result->>'cash_refund')::numeric = 40000
  AND (result->>'new_debt')::numeric = 0
  AND result->>'order_status' = 'partially_returned'
  AND EXISTS (SELECT 1 FROM public.cashbook_transactions
    WHERE id = result->>'refund_cashbook_id' AND value = 40000
      AND payment_method = 'bank' AND transaction_type = 'sales_return_refund'
      AND created_by = '50000000-0000-4000-8000-000000000001')
  AND EXISTS (SELECT 1 FROM public.customer_debt_transactions
    WHERE id = result->>'debt_ledger_id' AND debt_change = -50000
      AND created_by = '50000000-0000-4000-8000-000000000001'),
  result::text
FROM p3_partial_first;

INSERT INTO phase3_test_results
SELECT 'return_updates_order_item_revenue_and_commission',
  EXISTS (SELECT 1 FROM public.order_items
    WHERE id = 'P3-PARTIAL-I1' AND returned_quantity = 1 AND returned_amount = 90000)
  AND EXISTS (SELECT 1 FROM public.orders
    WHERE id = 'P3-ORDER-PARTIAL' AND returned_amount = 90000
      AND net_revenue = 90000 AND status = 'partially_returned')
  AND EXISTS (SELECT 1 FROM public.customers
    WHERE id = 'p3-customer-partial' AND total_return = 90000 AND net_revenue = 90000)
  AND EXISTS (SELECT 1 FROM public.commission_transactions
    WHERE sales_return_id = result->>'return_id'
      AND transaction_type = 'sales_return_reversal' AND commission_amount = -9000),
  result::text
FROM p3_partial_first;

CREATE TEMP TABLE p3_partial_retry AS
SELECT public.rpc_record_sales_return(jsonb_build_object(
  'orderId', 'P3-ORDER-PARTIAL', 'reason', 'P3 canonical partial return',
  'paymentMethod', 'bank', 'idempotencyKey', 'P3-RETURN-KEY-0001',
  'items', jsonb_build_array(jsonb_build_object('saleItemId', 'P3-PARTIAL-I1', 'quantity', 1))
)) AS result;
INSERT INTO phase3_test_results
SELECT 'same_return_request_is_idempotent',
  (retry.result->>'already_recorded')::boolean
  AND retry.result->>'return_id' = first.result->>'return_id'
  AND (SELECT count(*) FROM public.sales_returns WHERE id = first.result->>'return_id') = 1,
  retry.result::text
FROM p3_partial_retry retry CROSS JOIN p3_partial_first first;

CREATE FUNCTION pg_temp.p3_conflicting_retry_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_record_sales_return(jsonb_build_object(
    'orderId', 'P3-ORDER-PARTIAL', 'reason', 'changed payload',
    'paymentMethod', 'bank', 'idempotencyKey', 'P3-RETURN-KEY-0001',
    'items', jsonb_build_array(jsonb_build_object('saleItemId', 'P3-PARTIAL-I2', 'quantity', 1))));
  RETURN false;
EXCEPTION WHEN unique_violation THEN RETURN true;
END $$;
CREATE FUNCTION pg_temp.p3_excess_quantity_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_record_sales_return(jsonb_build_object(
    'orderId', 'P3-ORDER-PARTIAL', 'reason', 'quantity overflow',
    'paymentMethod', 'cash', 'idempotencyKey', 'P3-RETURN-KEY-0002',
    'items', jsonb_build_array(jsonb_build_object('saleItemId', 'P3-PARTIAL-I1', 'quantity', 1))));
  RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM LIKE '%exceeds remaining sold quantity%';
END $$;
INSERT INTO phase3_test_results VALUES
  ('same_key_changed_payload_is_rejected', pg_temp.p3_conflicting_retry_rejected(), '23505 expected'),
  ('quantity_already_returned_is_rejected', pg_temp.p3_excess_quantity_rejected(), 'quantity guard');

CREATE TEMP TABLE p3_full_return AS
SELECT public.rpc_record_sales_return(jsonb_build_object(
  'orderId', 'P3-ORDER-FULL', 'reason', 'P3 full return',
  'paymentMethod', 'cash', 'idempotencyKey', 'P3-RETURN-KEY-FULL',
  'items', jsonb_build_array(
    jsonb_build_object('saleItemId', 'P3-FULL-I1', 'quantity', 1),
    jsonb_build_object('saleItemId', 'P3-FULL-I2', 'quantity', 1)
  )
)) AS result;
INSERT INTO phase3_test_results
SELECT 'full_return_uses_exact_order_total_and_status',
  (result->>'total_refund')::numeric = 180000
  AND result->>'order_status' = 'returned'
  AND (result->>'cash_refund')::numeric = 0
  AND EXISTS (SELECT 1 FROM public.commission_transactions
    WHERE sales_return_id = result->>'return_id' AND commission_amount = -18000),
  result::text
FROM p3_full_return;

CREATE TEMP TABLE p3_cancel AS
SELECT public.rpc_cancel_sales_return(
  (SELECT result->>'return_id' FROM p3_partial_first), 'P3 cancellation test'
) AS result;
INSERT INTO phase3_test_results
SELECT 'cancel_return_reverses_debt_cash_revenue_items_and_commission',
  result->>'status' = 'cancelled'
  AND result->>'order_status' = 'settled'
  AND (result->>'new_debt')::numeric = 50000
  AND (result->>'new_total_return')::numeric = 0
  AND (result->>'new_net_revenue')::numeric = 180000
  AND EXISTS (SELECT 1 FROM public.customer_debt_transactions
    WHERE reversal_of_id = (SELECT first.result->>'debt_ledger_id' FROM p3_partial_first first)
      AND debt_change = 50000)
  AND EXISTS (SELECT 1 FROM public.cashbook_transactions original
    WHERE original.id = (SELECT first.result->>'refund_cashbook_id' FROM p3_partial_first first)
      AND original.status = 'cancelled')
  AND EXISTS (SELECT 1 FROM public.cashbook_transactions reversal
    WHERE reversal.reversal_of_id = (SELECT first.result->>'refund_cashbook_id' FROM p3_partial_first first))
  AND EXISTS (SELECT 1 FROM public.order_items
    WHERE id = 'P3-PARTIAL-I1' AND returned_quantity = 0 AND returned_amount = 0)
  AND EXISTS (SELECT 1 FROM public.commission_transactions
    WHERE sales_return_id = (SELECT first.result->>'return_id' FROM p3_partial_first first)
      AND transaction_type = 'sales_return_cancel_reversal' AND commission_amount = 9000),
  result::text
FROM p3_cancel;

CREATE TEMP TABLE p3_cancel_retry AS
SELECT public.rpc_cancel_sales_return(
  (SELECT result->>'return_id' FROM p3_partial_first), 'P3 cancellation retry'
) AS result;
INSERT INTO phase3_test_results
SELECT 'cancel_return_retry_is_idempotent',
  (result->>'already_cancelled')::boolean
  AND (SELECT count(*) FROM public.customer_debt_transactions
    WHERE reversal_of_id = (SELECT first.result->>'debt_ledger_id' FROM p3_partial_first first)) = 1,
  result::text
FROM p3_cancel_retry;

CREATE FUNCTION pg_temp.p3_direct_return_write_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE public.sales_returns SET status = 'cancelled'
  WHERE id = (SELECT result->>'return_id' FROM p3_full_return);
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;
INSERT INTO phase3_test_results VALUES
  ('return_tables_have_no_direct_write_grants',
    NOT has_table_privilege('authenticated', 'public.sales_returns', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.sales_returns', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.sales_return_items', 'DELETE'), 'catalog grants'),
  ('direct_return_update_is_rejected', pg_temp.p3_direct_return_write_rejected(), '42501 expected'),
  ('anon_cannot_execute_phase3_rpcs',
    NOT has_function_privilege('anon', 'public.rpc_record_sales_return(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_cancel_sales_return(text,text)', 'EXECUTE'), 'catalog grants');

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '50000000-0000-4000-8000-000000000002', true);
CREATE FUNCTION pg_temp.p3_sale_return_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_record_sales_return(jsonb_build_object(
    'orderId', 'P3-ORDER-FULL', 'reason', 'sale forbidden',
    'paymentMethod', 'cash', 'idempotencyKey', 'P3-SALE-RETURN-KEY',
    'items', jsonb_build_array(jsonb_build_object('saleItemId', 'P3-FULL-I1', 'quantity', 1))));
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;
INSERT INTO phase3_test_results VALUES
  ('sale_cannot_record_return', pg_temp.p3_sale_return_rejected(), '42501 expected');
RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM phase3_test_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Phase 3 integration tests failed:\n%', failed;
  END IF;
END $$;

TABLE phase3_test_results;
ROLLBACK;
