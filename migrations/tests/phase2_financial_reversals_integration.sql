-- Run only on an isolated Supabase staging database after migrations 0001..0007.
-- Every fixture and mutation is rolled back.
BEGIN;

CREATE TEMP TABLE phase2_test_results(
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);
GRANT ALL ON TABLE pg_temp.phase2_test_results TO authenticated;

INSERT INTO auth.users(instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000', '40000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'p2-accounting@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '40000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'p2-sale@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '40000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'p2-admin@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id, auth_user_id, username, display_name, role, is_active)
VALUES
  ('p2-accounting', '40000000-0000-4000-8000-000000000001', 'p2-accounting@test.invalid', 'P2 Accounting', 'accounting', true),
  ('p2-sale', '40000000-0000-4000-8000-000000000002', 'p2-sale@test.invalid', 'P2 Sale', 'sale', true),
  ('p2-admin', '40000000-0000-4000-8000-000000000003', 'p2-admin@test.invalid', 'P2 Admin', 'admin', true)
ON CONFLICT DO NOTHING;

UPDATE public.profiles
SET username = fixture.username, display_name = fixture.display_name,
    role = fixture.role, is_active = true
FROM (VALUES
  ('40000000-0000-4000-8000-000000000001'::uuid, 'p2-accounting@test.invalid', 'P2 Accounting', 'accounting'),
  ('40000000-0000-4000-8000-000000000002'::uuid, 'p2-sale@test.invalid', 'P2 Sale', 'sale'),
  ('40000000-0000-4000-8000-000000000003'::uuid, 'p2-admin@test.invalid', 'P2 Admin', 'admin')
) AS fixture(auth_user_id, username, display_name, role)
WHERE public.profiles.auth_user_id = fixture.auth_user_id;

INSERT INTO public.customers(id, code, name, managed_by, debt, total_transaction, net_revenue, status, deleted_at)
VALUES
  ('p2-customer-payment', 'P2-PAY', 'P2 Payment Customer', 'p2-sale@test.invalid', 500000, 500000, 500000, 'active', NULL),
  ('p2-customer-order', 'P2-ORDER', 'P2 Order Customer', 'p2-sale@test.invalid', 200000, 200000, 200000, 'active', NULL)
ON CONFLICT (id) DO UPDATE SET debt = EXCLUDED.debt,
  total_transaction = EXCLUDED.total_transaction, net_revenue = EXCLUDED.net_revenue,
  status = 'active', deleted_at = NULL;

INSERT INTO public.orders(
  id, customer_id, customer_name, items, total_payable, total_amount, debt_amount,
  paid_amount, net_revenue, status, created_by, order_date, created_at
) VALUES (
  'P2-ORDER-CANCEL', 'p2-customer-order', 'P2 Order Customer', '[]'::jsonb,
  200000, 200000, 200000, 0, 200000, 'settled',
  '40000000-0000-4000-8000-000000000001', now(), now()
) ON CONFLICT (id) DO UPDATE SET status = 'settled', cancelled_at = NULL,
  cancellation_reason = NULL, cancelled_by = NULL;

INSERT INTO public.customer_debt_transactions(
  id, customer_id, transaction_type, amount, debt_change, balance_before,
  balance_after, order_id, description, created_by, transaction_date
) VALUES (
  'P2-ORDER-CHARGE', 'p2-customer-order', 'order', 200000, 200000, 0, 200000,
  'P2-ORDER-CANCEL', 'P2 order fixture', '40000000-0000-4000-8000-000000000001', now() - interval '1 day'
) ON CONFLICT (id) DO NOTHING;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000001', true);

CREATE TEMP TABLE p2_payment_first AS
SELECT public.rpc_record_customer_payment(
  'p2-customer-payment', 100000, 'P2 collection', 'bank', 'P2-PAYMENT-KEY-0001'
) AS result;

INSERT INTO phase2_test_results
SELECT 'payment_is_atomic_and_actor_is_auth_uid',
  (result->>'new_debt')::numeric = 400000
  AND EXISTS (SELECT 1 FROM public.cashbook_transactions
    WHERE id = result->>'cashbook_id' AND value = 100000
      AND payment_method = 'bank' AND created_by = '40000000-0000-4000-8000-000000000001')
  AND EXISTS (SELECT 1 FROM public.payments
    WHERE cashbook_transaction_id = result->>'cashbook_id' AND status = 'completed')
  AND EXISTS (SELECT 1 FROM public.customer_debt_transactions
    WHERE cashbook_transaction_id = result->>'cashbook_id'
      AND transaction_type = 'payment' AND debt_change = -100000),
  result::text
FROM p2_payment_first;

CREATE TEMP TABLE p2_payment_retry AS
SELECT public.rpc_record_customer_payment(
  'p2-customer-payment', 100000, 'P2 collection', 'bank', 'P2-PAYMENT-KEY-0001'
) AS result;
INSERT INTO phase2_test_results
SELECT 'payment_retry_is_idempotent',
  (retry.result->>'already_recorded')::boolean
  AND retry.result->>'cashbook_id' = first.result->>'cashbook_id'
  AND (SELECT count(*) FROM public.customer_debt_transactions
    WHERE cashbook_transaction_id = first.result->>'cashbook_id' AND transaction_type = 'payment') = 1,
  retry.result::text
FROM p2_payment_retry retry CROSS JOIN p2_payment_first first;

CREATE FUNCTION pg_temp.p2_payment_conflict_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_record_customer_payment(
    'p2-customer-payment', 90000, 'changed', 'bank', 'P2-PAYMENT-KEY-0001');
  RETURN false;
EXCEPTION WHEN unique_violation THEN RETURN true;
END $$;

CREATE FUNCTION pg_temp.p2_overpayment_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_record_customer_payment(
    'p2-customer-payment', 900000, 'too much', 'cash', 'P2-PAYMENT-KEY-0002');
  RETURN false;
EXCEPTION WHEN OTHERS THEN RETURN SQLERRM LIKE '%exceeds outstanding debt%';
END $$;

INSERT INTO phase2_test_results VALUES
  ('payment_same_key_different_payload_rejected', pg_temp.p2_payment_conflict_rejected(), '23505 expected'),
  ('overpayment_rejected', pg_temp.p2_overpayment_rejected(), 'overpayment must fail');

CREATE TEMP TABLE p2_payment_cancel AS
SELECT public.rpc_cancel_customer_payment((SELECT result->>'cashbook_id' FROM p2_payment_first)) AS result;
INSERT INTO phase2_test_results
SELECT 'payment_cancel_appends_reversal',
  (result->>'new_debt')::numeric = 500000
  AND EXISTS (SELECT 1 FROM public.customer_debt_transactions reversal
    JOIN public.customer_debt_transactions original ON original.id = reversal.reversal_of_id
    WHERE original.cashbook_transaction_id = result->>'cashbook_id'
      AND reversal.transaction_type = 'payment_cancel' AND reversal.debt_change = 100000)
  AND EXISTS (SELECT 1 FROM public.cashbook_transactions
    WHERE id = result->>'cashbook_id' AND status = 'cancelled')
  AND EXISTS (SELECT 1 FROM public.payments
    WHERE cashbook_transaction_id = result->>'cashbook_id' AND status = 'cancelled'),
  result::text
FROM p2_payment_cancel;

SELECT public.rpc_cancel_customer_payment((SELECT result->>'cashbook_id' FROM p2_payment_first));
INSERT INTO phase2_test_results
SELECT 'payment_cancel_retry_does_not_duplicate_reversal', count(*) = 1, 'one reversal row'
FROM public.customer_debt_transactions
WHERE reversal_of_id = (SELECT id FROM public.customer_debt_transactions
  WHERE cashbook_transaction_id = (SELECT result->>'cashbook_id' FROM p2_payment_first)
    AND transaction_type = 'payment');

CREATE TEMP TABLE p2_cash_first AS
SELECT public.rpc_create_cashbook_transaction(jsonb_build_object(
  'idempotencyKey', 'P2-CASHBOOK-KEY-0001', 'externalReference', 'TCM000001',
  'type', 'chi', 'value', 75000, 'method', 'wallet', 'category', 'Chi phí khác',
  'partner', 'P2 Partner', 'accounting', true, 'note', 'P2 manual cashbook',
  'transactionDate', '2026-01-15T08:00:00Z'
)) AS result;
CREATE TEMP TABLE p2_cash_retry AS
SELECT public.rpc_create_cashbook_transaction(jsonb_build_object(
  'idempotencyKey', 'P2-CASHBOOK-KEY-0001', 'externalReference', 'TCM000001',
  'type', 'chi', 'value', 75000, 'method', 'wallet', 'category', 'Chi phí khác',
  'partner', 'P2 Partner', 'accounting', true, 'note', 'P2 manual cashbook',
  'transactionDate', '2026-01-15T08:00:00Z'
)) AS result;
INSERT INTO phase2_test_results
SELECT 'manual_cashbook_is_idempotent_and_server_stamped',
  first.result->>'cashbook_id' = retry.result->>'cashbook_id'
  AND (retry.result->>'already_recorded')::boolean
  AND EXISTS (SELECT 1 FROM public.cashbook_transactions
    WHERE id = first.result->>'cashbook_id' AND created_by = '40000000-0000-4000-8000-000000000001'),
  retry.result::text
FROM p2_cash_first first CROSS JOIN p2_cash_retry retry;

CREATE TEMP TABLE p2_cash_cancel AS
SELECT public.rpc_cancel_cashbook_transaction(
  (SELECT result->>'cashbook_id' FROM p2_cash_first), 'P2 cancel test'
) AS result;
INSERT INTO phase2_test_results
SELECT 'manual_cashbook_cancel_records_reversal',
  EXISTS (SELECT 1 FROM public.cashbook_transactions original
    WHERE original.id = result->>'cashbook_id' AND original.status = 'cancelled')
  AND EXISTS (SELECT 1 FROM public.cashbook_transactions reversal
    WHERE reversal.reversal_of_id = result->>'cashbook_id'
      AND reversal.status = 'cancelled' AND reversal.type = 'thu'),
  result::text
FROM p2_cash_cancel;

SELECT public.rpc_set_cashbook_starting_balances(1000, 2000, 3000);
INSERT INTO phase2_test_results
SELECT 'starting_balances_use_reviewed_rpc', cash = 1000 AND bank = 2000 AND wallet = 3000,
  'starting balance values' FROM public.starting_balances WHERE id = 'current_balances';

CREATE TEMP TABLE p2_order_cancel AS
SELECT public.rpc_cancel_order('P2-ORDER-CANCEL', 'P2 cancellation test') AS result;
INSERT INTO phase2_test_results
SELECT 'order_cancel_reverses_debt_revenue_and_status',
  result->>'status' = 'cancelled'
  AND (result->>'new_debt')::numeric = 0
  AND EXISTS (SELECT 1 FROM public.customer_debt_transactions
    WHERE reversal_of_id = 'P2-ORDER-CHARGE' AND debt_change = -200000)
  AND EXISTS (SELECT 1 FROM public.customers
    WHERE id = 'p2-customer-order' AND debt = 0 AND total_transaction = 0 AND net_revenue = 0)
  AND EXISTS (SELECT 1 FROM public.orders
    WHERE id = 'P2-ORDER-CANCEL' AND status = 'cancelled'
      AND cancelled_by = '40000000-0000-4000-8000-000000000001'),
  result::text
FROM p2_order_cancel;

CREATE FUNCTION pg_temp.p2_direct_ledger_update_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE public.customer_debt_transactions SET amount = 1 WHERE id = 'P2-ORDER-CHARGE';
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;
CREATE FUNCTION pg_temp.p2_direct_debt_update_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE public.customers SET debt = 1 WHERE id = 'p2-customer-payment';
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;
CREATE FUNCTION pg_temp.p2_direct_revenue_update_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  UPDATE public.customers SET total_transaction = 1 WHERE id = 'p2-customer-payment';
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;
INSERT INTO phase2_test_results VALUES
  ('ledger_direct_update_rejected', pg_temp.p2_direct_ledger_update_rejected(), '42501 expected'),
  ('customer_debt_direct_update_rejected', pg_temp.p2_direct_debt_update_rejected(), '42501 expected'),
  ('customer_revenue_direct_update_rejected', pg_temp.p2_direct_revenue_update_rejected(), '42501 expected'),
  ('financial_tables_have_no_direct_write_grants',
    NOT has_table_privilege('authenticated', 'public.customer_debt_transactions', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.customer_debt_transactions', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.cashbook_transactions', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.payments', 'DELETE')
    AND NOT has_table_privilege('authenticated', 'public.orders', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.order_items', 'UPDATE'), 'catalog grants');
INSERT INTO phase2_test_results VALUES
  ('anon_cannot_execute_phase2_finance_rpcs',
    NOT has_function_privilege('anon', 'public.rpc_record_customer_payment(text,numeric,text,text,text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_cancel_customer_payment(text)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_create_cashbook_transaction(jsonb)', 'EXECUTE')
    AND NOT has_function_privilege('anon', 'public.rpc_cancel_order(text,text)', 'EXECUTE'), 'catalog grants');

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000002', true);
CREATE FUNCTION pg_temp.p2_sale_finance_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_record_customer_payment(
    'p2-customer-payment', 1, 'sale forbidden', 'cash', 'P2-SALE-KEY-0001');
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;
CREATE FUNCTION pg_temp.p2_sale_cashbook_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_create_cashbook_transaction(jsonb_build_object(
    'idempotencyKey', 'P2-SALE-CASH-0001', 'type', 'thu', 'value', 1,
    'method', 'cash', 'category', 'forbidden', 'partner', 'forbidden'));
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;
CREATE FUNCTION pg_temp.p2_sale_adjustment_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_adjust_customer_debt('p2-customer-payment', 1, 'sale forbidden');
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;
INSERT INTO phase2_test_results VALUES
  ('sale_cannot_record_payment', pg_temp.p2_sale_finance_rejected(), '42501 expected'),
  ('sale_cannot_create_cashbook_entry', pg_temp.p2_sale_cashbook_rejected(), '42501 expected'),
  ('sale_cannot_adjust_customer_debt', pg_temp.p2_sale_adjustment_rejected(), '42501 expected');
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000003', true);
CREATE TEMP TABLE p2_admin_result AS
SELECT public.rpc_set_cashbook_starting_balances(4000, 5000, 6000) AS result;
INSERT INTO phase2_test_results
SELECT 'admin_can_use_reviewed_finance_rpc',
  (result->>'performed_by') = '40000000-0000-4000-8000-000000000003'
  AND (result->>'wallet')::numeric = 6000, result::text
FROM p2_admin_result;
RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM phase2_test_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Phase 2 integration tests failed:\n%', failed;
  END IF;
END $$;

TABLE phase2_test_results;
ROLLBACK;
