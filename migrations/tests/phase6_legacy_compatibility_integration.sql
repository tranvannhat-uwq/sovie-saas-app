-- Run only on an isolated Supabase staging database after migrations 0001..0013.
-- All fixtures and mutations are rolled back.
BEGIN;

CREATE TEMP TABLE phase6_test_results(
  test_name text PRIMARY KEY, passed boolean NOT NULL, details text
);
GRANT ALL ON TABLE pg_temp.phase6_test_results TO authenticated;

INSERT INTO auth.users(instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-000000000000',
  '70000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'p13-accounting@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id, auth_user_id, username, display_name, role, is_active)
VALUES ('p13-accounting', '70000000-0000-4000-8000-000000000001',
  'p13-accounting@test.invalid', 'P13 Accounting', 'accounting', true)
ON CONFLICT DO NOTHING;
UPDATE public.profiles SET role = 'accounting', is_active = true
WHERE auth_user_id = '70000000-0000-4000-8000-000000000001';

INSERT INTO public.customers(id, code, name, debt, total_transaction, total_return, net_revenue, status)
VALUES
  ('p13-c-debt', 'P13-C-DEBT', 'Legacy debt receipt', 100000, 0, 0, 0, 'active'),
  ('p13-c-sale', 'P13-C-SALE', 'Legacy sale receipt', 300000, 300000, 0, 300000, 'active'),
  ('p13-c-unpaid', 'P13-C-UNPAID', 'Legacy unpaid order', 200000, 200000, 0, 200000, 'active'),
  ('p13-c-partial', 'P13-C-PART', 'Legacy partial order', 100000, 200000, 0, 200000, 'active'),
  ('p13-c-paid', 'P13-C-PAID', 'Legacy paid order', 0, 200000, 0, 200000, 'active')
ON CONFLICT (id) DO UPDATE SET debt = EXCLUDED.debt,
  total_transaction = EXCLUDED.total_transaction, total_return = EXCLUDED.total_return,
  net_revenue = EXCLUDED.net_revenue, status = 'active';

INSERT INTO public.suppliers(id, code, name, debt, opening_debt, total_purchase, total_paid, is_active)
VALUES ('p13-supplier', 'P13-NCC', 'Legacy supplier', 100000, 0, 150000, 50000, true)
ON CONFLICT (id) DO UPDATE SET debt = 100000, total_purchase = 150000, total_paid = 50000;

INSERT INTO public.cashbook_transactions(
  id, date, transaction_date, type, transaction_type, direction, category, partner,
  customer_id, supplier_id, value, method, payment_method, accounting,
  status, creator, created_by, note, starred
) VALUES
  ('P13-OLD-DEBT', now(), now(), 'thu', NULL, 'in', 'Thu nợ khách hàng', 'Legacy debt receipt',
    'p13-c-debt', NULL, 50000, 'cash', 'cash', true, 'completed', 'Legacy', 'legacy', 'Thu nợ', false),
  ('P13-OLD-SALE', now(), now(), 'thu', NULL, 'in', 'Thu nợ khách hàng', 'Legacy sale receipt',
    'p13-c-sale', NULL, 70000, 'cash', 'cash', true, 'completed', 'Legacy', 'legacy', 'Thu tiền hàng - TTM000001', false),
  ('P13-OLD-SUPPLIER', now(), now(), 'chi', NULL, 'out', 'Chi khác', 'Legacy supplier',
    NULL, 'p13-supplier', 50000, 'bank', 'bank', true, 'completed', 'Legacy', 'legacy', 'Trả nhà cung cấp', false),
  ('P13-OLD-OTHER', now(), now(), 'chi', NULL, 'out', 'Chi khác', 'Khác',
    NULL, NULL, 10000, 'cash', 'cash', true, 'completed', 'Legacy', 'legacy', 'Chi văn phòng', false)
ON CONFLICT (id) DO UPDATE SET status = 'completed', cancelled_at = NULL,
  cancelled_by = NULL, cancellation_reason = NULL, reversal_of_id = NULL;

INSERT INTO public.orders(
  id, customer_id, customer_name, salesperson_id, customer_manager_id,
  company_id, revenue_brand_id, notes, items, total_market, total_discount,
  subtotal, discount_value, discount_type, discount_amount,
  other_fee_value, other_fee_type, other_fee_amount,
  shipping_fee_value, shipping_fee_amount, total_payable, total_amount,
  paid_amount, debt_amount, returned_amount, net_revenue, status, order_date,
  confirmed_at, pricelist_id, created_by, created_at, updated_at, pricing_version
)
SELECT fixture.id, fixture.customer_id, fixture.customer_name,
  '70000000-0000-4000-8000-000000000001', NULL, 'ABS_NORTH', NULL,
  'Phase 6 legacy fixture', '[]'::jsonb, 200000, 0,
  200000, 0, 'amount', 0, 0, 'amount', 0, 0, 0, 200000, 200000,
  fixture.paid_amount, fixture.debt_amount, 0, 200000, 'settled', now(), now(),
  'retail', '70000000-0000-4000-8000-000000000001', now(), now(), 'p1-v1'
FROM (VALUES
  ('P13-ORDER-UNPAID', 'p13-c-unpaid', 'Legacy unpaid order', 0::numeric, 200000::numeric),
  ('P13-ORDER-PARTIAL', 'p13-c-partial', 'Legacy partial order', 100000::numeric, 100000::numeric),
  ('P13-ORDER-PAID', 'p13-c-paid', 'Legacy paid order', 200000::numeric, 0::numeric)
) AS fixture(id, customer_id, customer_name, paid_amount, debt_amount)
ON CONFLICT (id) DO UPDATE SET status = 'settled', cancelled_at = NULL,
  cancelled_by = NULL, cancellation_reason = NULL;

INSERT INTO public.customer_debt_transactions(id, customer_id, transaction_type,
  amount, debt_change, balance_before, balance_after, order_id, description, created_by, transaction_date)
VALUES
  ('P13-CHARGE-U', 'p13-c-unpaid', 'order', 200000, 200000, 0, 200000, 'P13-ORDER-UNPAID', 'fixture', 'legacy', now()),
  ('P13-CHARGE-P', 'p13-c-partial', 'order', 200000, 200000, 0, 200000, 'P13-ORDER-PARTIAL', 'fixture', 'legacy', now()),
  ('P13-CHARGE-F', 'p13-c-paid', 'order', 200000, 200000, 0, 200000, 'P13-ORDER-PAID', 'fixture', 'legacy', now())
ON CONFLICT (id) DO NOTHING;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', true);

CREATE TEMP TABLE p13_debt_cancel AS
SELECT public.rpc_cancel_cashbook_entry('P13-OLD-DEBT', 'Test old debt receipt') result;
INSERT INTO phase6_test_results SELECT 'old_customer_debt_receipt_reverses_debt',
  (SELECT debt = 150000 FROM public.customers WHERE id = 'p13-c-debt')
  AND result->>'cancellation_route' = 'customer_debt_receipt', result::text FROM p13_debt_cancel;

CREATE TEMP TABLE p13_sale_cancel AS
SELECT public.rpc_cancel_cashbook_entry('P13-OLD-SALE', 'Test old sale receipt') result;
INSERT INTO phase6_test_results SELECT 'old_sale_receipt_does_not_change_debt',
  (SELECT debt = 300000 FROM public.customers WHERE id = 'p13-c-sale')
  AND result->>'cancellation_route' = 'sale_receipt', result::text FROM p13_sale_cancel;

CREATE TEMP TABLE p13_supplier_cancel AS
SELECT public.rpc_cancel_cashbook_entry('P13-OLD-SUPPLIER', 'Test old supplier payment') result;
INSERT INTO phase6_test_results SELECT 'old_supplier_payment_reverses_supplier_debt',
  (SELECT debt = 150000 FROM public.suppliers WHERE id = 'p13-supplier')
  AND result->>'cancellation_route' = 'supplier_payment', result::text FROM p13_supplier_cancel;

CREATE TEMP TABLE p13_other_cancel AS
SELECT public.rpc_cancel_cashbook_entry('P13-OLD-OTHER', 'Test old other expense') result;
INSERT INTO phase6_test_results SELECT 'old_other_expense_only_reverses_cashbook',
  (SELECT debt = 150000 FROM public.suppliers WHERE id = 'p13-supplier')
  AND (SELECT debt = 150000 FROM public.customers WHERE id = 'p13-c-debt')
  AND result->>'cancellation_route' = 'other_payment', result::text FROM p13_other_cancel;

UPDATE public.customers SET name = 'Edited profile only', address = 'New address'
WHERE id = 'p13-c-debt';
INSERT INTO phase6_test_results VALUES ('profile_edit_preserves_financial_balance',
  (SELECT name = 'Edited profile only' AND debt = 150000 FROM public.customers WHERE id = 'p13-c-debt'),
  'profile whitelist columns updated');

CREATE TEMP TABLE p13_order_unpaid AS SELECT public.rpc_cancel_order('P13-ORDER-UNPAID', 'Test unpaid') result;
CREATE TEMP TABLE p13_order_partial AS SELECT public.rpc_cancel_order('P13-ORDER-PARTIAL', 'Test partial') result;
CREATE TEMP TABLE p13_order_paid AS SELECT public.rpc_cancel_order('P13-ORDER-PAID', 'Test fully paid') result;
INSERT INTO phase6_test_results SELECT 'old_unpaid_order_cancels_to_zero',
  (SELECT debt = 0 FROM public.customers WHERE id = 'p13-c-unpaid'), result::text FROM p13_order_unpaid;
INSERT INTO phase6_test_results SELECT 'old_partial_order_creates_customer_credit',
  (SELECT debt = -100000 FROM public.customers WHERE id = 'p13-c-partial')
  AND (result->>'customer_credit')::numeric = 100000, result::text FROM p13_order_partial;
INSERT INTO phase6_test_results SELECT 'old_paid_order_preserves_payment_as_credit',
  (SELECT debt = -200000 FROM public.customers WHERE id = 'p13-c-paid')
  AND (result->>'payments_preserved')::boolean, result::text FROM p13_order_paid;

CREATE TEMP TABLE p13_order_retry AS SELECT public.rpc_cancel_order('P13-ORDER-PAID', 'Test retry') result;
INSERT INTO phase6_test_results SELECT 'second_order_cancellation_is_idempotent',
  (result->>'already_cancelled')::boolean
  AND (SELECT count(*) = 1 FROM public.customer_debt_transactions
    WHERE id = 'DTX-P13-ORDER-VOID-P13-ORDER-PAID'), result::text FROM p13_order_retry;

DO $$
DECLARE failures jsonb;
BEGIN
  SELECT jsonb_agg(to_jsonb(r)) INTO failures FROM phase6_test_results r WHERE NOT passed;
  IF failures IS NOT NULL THEN RAISE EXCEPTION 'Phase 6 integration failures: %', failures; END IF;
END $$;

TABLE phase6_test_results;
ROLLBACK;
