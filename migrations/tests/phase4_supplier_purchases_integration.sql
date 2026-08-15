-- Run only on an isolated Supabase staging database after migrations 0001..0009.
-- All fixtures and mutations are rolled back.
BEGIN;

CREATE TEMP TABLE phase4_test_results(
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);
GRANT ALL ON TABLE pg_temp.phase4_test_results TO authenticated, anon;

INSERT INTO auth.users(instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000', '60000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'p4-accounting@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '60000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'p4-sale@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id, auth_user_id, username, display_name, role, is_active)
VALUES
  ('p4-accounting', '60000000-0000-4000-8000-000000000001', 'p4-accounting@test.invalid', 'P4 Accounting', 'accounting', true),
  ('p4-sale', '60000000-0000-4000-8000-000000000002', 'p4-sale@test.invalid', 'P4 Sale', 'sale', true)
ON CONFLICT DO NOTHING;

-- Some staging schemas create a profile automatically from auth.users. Make
-- the fixture deterministic whether that trigger exists or not.
UPDATE public.profiles
SET username = fixture.username,
    display_name = fixture.display_name,
    role = fixture.role,
    is_active = true
FROM (VALUES
  ('60000000-0000-4000-8000-000000000001'::uuid, 'p4-accounting@test.invalid', 'P4 Accounting', 'accounting'),
  ('60000000-0000-4000-8000-000000000002'::uuid, 'p4-sale@test.invalid', 'P4 Sale', 'sale')
) AS fixture(auth_user_id, username, display_name, role)
WHERE public.profiles.auth_user_id = fixture.auth_user_id;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000001', true);

CREATE TEMP TABLE p4_supplier AS
SELECT public.rpc_save_supplier(jsonb_build_object(
  'code', 'P4-NCC-001', 'name', 'P4 Supplier', 'openingDebt', 50000,
  'phone', '000', 'address', 'Staging', 'notes', 'Phase 4 fixture'
)) AS result;

CREATE TEMP TABLE p4_purchase_first AS
SELECT public.rpc_create_purchase(jsonb_build_object(
  'supplierId', (SELECT result->'supplier'->>'id' FROM p4_supplier),
  'invoiceNumber', 'P4-INV-001', 'purchaseDate', now(),
  'paidAmount', 100000, 'paymentMethod', 'bank',
  'notes', 'P4 canonical purchase', 'idempotencyKey', 'P4-PURCHASE-KEY-0001',
  'totalAmount', 1, 'balanceDue', 1,
  'items', jsonb_build_array(
    jsonb_build_object('code', 'DV-01', 'name', 'Dịch vụ 1', 'unit', 'lần',
      'quantity', 2, 'unitPrice', 100000, 'lineTotal', 1),
    jsonb_build_object('code', 'HH-01', 'name', 'Hàng hóa 1', 'unit', 'cái',
      'quantity', 1, 'unitPrice', 50000, 'lineTotal', 1)
  )
)) AS result;

INSERT INTO phase4_test_results
SELECT 'backend_calculates_purchase_total',
  (result->'purchase'->>'totalAmount')::numeric = 250000
  AND (result->'purchase'->>'paidAmount')::numeric = 100000
  AND (result->'purchase'->>'balanceDue')::numeric = 150000
  AND (result->'supplier'->>'debt')::numeric = 200000
  AND jsonb_array_length(result->'purchase'->'items') = 2,
  result::text
FROM p4_purchase_first;

INSERT INTO phase4_test_results
SELECT 'purchase_writes_ledger_cashbook_and_actor',
  EXISTS (SELECT 1 FROM public.supplier_debt_transactions
    WHERE purchase_id = result->'purchase'->>'id' AND transaction_type = 'purchase'
      AND amount_change = 250000 AND created_by = '60000000-0000-4000-8000-000000000001')
  AND EXISTS (SELECT 1 FROM public.supplier_debt_transactions
    WHERE purchase_id = result->'purchase'->>'id' AND transaction_type = 'supplier_payment'
      AND amount_change = -100000 AND created_by = '60000000-0000-4000-8000-000000000001')
  AND EXISTS (SELECT 1 FROM public.cashbook_transactions
    WHERE purchase_id = result->'purchase'->>'id' AND transaction_type = 'supplier_payment'
      AND value = 100000 AND payment_method = 'bank'
      AND created_by = '60000000-0000-4000-8000-000000000001'),
  result::text
FROM p4_purchase_first;

CREATE TEMP TABLE p4_purchase_retry AS
SELECT public.rpc_create_purchase(jsonb_build_object(
  'supplierId', (SELECT result->'supplier'->>'id' FROM p4_supplier),
  'invoiceNumber', 'P4-INV-001', 'purchaseDate',
    (SELECT result->'purchase'->>'purchaseDate' FROM p4_purchase_first),
  'paidAmount', 100000, 'paymentMethod', 'bank',
  'notes', 'P4 canonical purchase', 'idempotencyKey', 'P4-PURCHASE-KEY-0001',
  'items', jsonb_build_array(
    jsonb_build_object('code', 'DV-01', 'name', 'Dịch vụ 1', 'unit', 'lần', 'quantity', 2, 'unitPrice', 100000),
    jsonb_build_object('code', 'HH-01', 'name', 'Hàng hóa 1', 'unit', 'cái', 'quantity', 1, 'unitPrice', 50000)
  )
)) AS result;
INSERT INTO phase4_test_results
SELECT 'same_purchase_request_is_idempotent',
  (retry.result->>'already_recorded')::boolean
  AND retry.result->'purchase'->>'id' = original.result->'purchase'->>'id'
  AND (SELECT count(*) FROM public.purchases WHERE id = original.result->'purchase'->>'id') = 1,
  retry.result::text
FROM p4_purchase_retry retry CROSS JOIN p4_purchase_first original;

CREATE FUNCTION pg_temp.p4_conflicting_retry_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_create_purchase(jsonb_build_object(
    'supplierId', (SELECT result->'supplier'->>'id' FROM p4_supplier),
    'paidAmount', 0, 'paymentMethod', 'cash', 'idempotencyKey', 'P4-PURCHASE-KEY-0001',
    'items', jsonb_build_array(jsonb_build_object('code', 'X', 'name', 'Changed', 'quantity', 1, 'unitPrice', 1))));
  RETURN false;
EXCEPTION WHEN unique_violation THEN RETURN true;
END $$;
INSERT INTO phase4_test_results VALUES
  ('same_key_changed_payload_is_rejected', pg_temp.p4_conflicting_retry_rejected(), '23505 expected');

CREATE TEMP TABLE p4_extra_payment AS
SELECT public.rpc_record_supplier_payment(jsonb_build_object(
  'supplierId', (SELECT result->'supplier'->>'id' FROM p4_supplier),
  'purchaseId', (SELECT result->'purchase'->>'id' FROM p4_purchase_first),
  'amount', 50000, 'paymentMethod', 'cash', 'notes', 'P4 extra payment',
  'idempotencyKey', 'P4-SUPPLIER-PAYMENT-0001'
)) AS result;
INSERT INTO phase4_test_results
SELECT 'supplier_payment_updates_debt_and_cashbook',
  (result->'purchase'->>'paidAmount')::numeric = 150000
  AND (result->'purchase'->>'balanceDue')::numeric = 100000
  AND (result->'supplier'->>'debt')::numeric = 150000
  AND EXISTS (SELECT 1 FROM public.cashbook_transactions
    WHERE id = result->>'cashbook_transaction_id' AND value = 50000
      AND transaction_type = 'supplier_payment' AND payment_method = 'cash'),
  result::text
FROM p4_extra_payment;

CREATE TEMP TABLE p4_cancel_payment AS
SELECT public.rpc_cancel_supplier_payment(
  (SELECT result->>'payment_id' FROM p4_extra_payment), 'P4 cancel payment test'
) AS result;
INSERT INTO phase4_test_results
SELECT 'cancel_supplier_payment_appends_reversals',
  (result->'purchase'->>'paidAmount')::numeric = 100000
  AND (result->'purchase'->>'balanceDue')::numeric = 150000
  AND (result->'supplier'->>'debt')::numeric = 200000
  AND EXISTS (SELECT 1 FROM public.supplier_debt_transactions
    WHERE payment_id = result->>'payment_id' AND transaction_type = 'supplier_payment_reversal'
      AND amount_change = 50000 AND reversal_of_id IS NOT NULL)
  AND EXISTS (SELECT 1 FROM public.cashbook_transactions
    WHERE purchase_payment_id = result->>'payment_id'
      AND transaction_type = 'supplier_payment_reversal' AND reversal_of_id IS NOT NULL),
  result::text
FROM p4_cancel_payment;

CREATE TEMP TABLE p4_cancel_purchase AS
SELECT public.rpc_cancel_purchase(
  (SELECT result->'purchase'->>'id' FROM p4_purchase_first), 'P4 cancel purchase test'
) AS result;

-- audit_logs is intentionally hidden from ordinary authenticated reads. The
-- business action above still runs as Accounting; reset only for the internal
-- assertion that verifies its audit actor.
RESET ROLE;
INSERT INTO phase4_test_results
SELECT 'cancel_purchase_reverses_debt_and_payments',
  result->'purchase'->>'status' = 'cancelled'
  AND (result->'supplier'->>'debt')::numeric = 50000
  AND NOT EXISTS (SELECT 1 FROM public.purchase_payments
    WHERE purchase_id = result->'purchase'->>'id' AND status = 'completed')
  AND EXISTS (SELECT 1 FROM public.supplier_debt_transactions
    WHERE purchase_id = result->'purchase'->>'id'
      AND transaction_type = 'purchase_reversal' AND amount_change = -250000)
  AND EXISTS (SELECT 1 FROM public.audit_logs
    WHERE table_name = 'purchases' AND action = 'CANCEL'
      AND record_id = result->'purchase'->>'id'
      AND performed_by = '60000000-0000-4000-8000-000000000001'),
  result::text
FROM p4_cancel_purchase;

SET LOCAL ROLE authenticated;
CREATE FUNCTION pg_temp.p4_sale_denied()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_create_purchase(jsonb_build_object(
    'supplierId', (SELECT result->'supplier'->>'id' FROM p4_supplier),
    'idempotencyKey', 'P4-SALE-DENIED-0001',
    'items', jsonb_build_array(jsonb_build_object('code', 'X', 'name', 'X', 'quantity', 1, 'unitPrice', 1))));
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;
SELECT set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000002', true);
INSERT INTO phase4_test_results VALUES ('sale_cannot_create_purchase', pg_temp.p4_sale_denied(), '42501 expected');

RESET ROLE;
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claim.sub', '', true);
CREATE FUNCTION pg_temp.p4_anon_denied()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_create_purchase('{}'::jsonb);
  RETURN false;
EXCEPTION WHEN insufficient_privilege OR undefined_function THEN RETURN true;
END $$;
INSERT INTO phase4_test_results VALUES ('anon_cannot_create_purchase', pg_temp.p4_anon_denied(), 'EXECUTE denied');

RESET ROLE;
INSERT INTO phase4_test_results VALUES (
  'direct_financial_writes_are_revoked',
  NOT has_table_privilege('authenticated', 'public.purchases', 'INSERT')
  AND NOT has_table_privilege('authenticated', 'public.purchase_items', 'UPDATE')
  AND NOT has_table_privilege('authenticated', 'public.purchase_payments', 'DELETE')
  AND NOT has_table_privilege('authenticated', 'public.supplier_debt_transactions', 'INSERT'),
  'authenticated must be read-only'
);

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n') INTO failed
  FROM phase4_test_results WHERE NOT passed;
  IF failed IS NOT NULL THEN RAISE EXCEPTION 'Phase 4 integration failures:%', E'\n' || failed; END IF;
END $$;

TABLE phase4_test_results;
ROLLBACK;
