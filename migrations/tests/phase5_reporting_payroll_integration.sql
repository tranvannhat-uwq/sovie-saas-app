-- Isolated staging/local test. Every fixture and mutation is rolled back.
BEGIN;

CREATE TEMP TABLE phase5_test_results(test_name text PRIMARY KEY, passed boolean NOT NULL, details text);
GRANT ALL ON TABLE pg_temp.phase5_test_results TO authenticated, anon;

INSERT INTO auth.users(instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000', '70000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'p5-admin@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '70000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'p5-sale@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id, auth_user_id, username, display_name, role, position, base_salary, is_active)
VALUES
  ('p5-admin', '70000000-0000-4000-8000-000000000001', 'p5-admin@test.invalid', 'P5 Admin', 'admin', 'admin', 10000000, true),
  ('p5-sale', '70000000-0000-4000-8000-000000000002', 'p5-sale@test.invalid', 'P5 Sale', 'sale', 'sale', 5000000, true)
ON CONFLICT DO NOTHING;
UPDATE public.profiles SET role = fixture.role, position = fixture.role, base_salary = fixture.base_salary,
  username = fixture.username, display_name = fixture.display_name, is_active = true
FROM (VALUES
  ('70000000-0000-4000-8000-000000000001'::uuid, 'p5-admin@test.invalid', 'P5 Admin', 'admin', 10000000::numeric),
  ('70000000-0000-4000-8000-000000000002'::uuid, 'p5-sale@test.invalid', 'P5 Sale', 'sale', 5000000::numeric)
) fixture(auth_user_id, username, display_name, role, base_salary)
WHERE public.profiles.auth_user_id = fixture.auth_user_id;

INSERT INTO public.product_groups(id, base_code, product_name, brand_name)
VALUES ('p5-group', 'P5-SP', 'P5 Product', 'P5 Brand') ON CONFLICT DO NOTHING;
INSERT INTO public.products(id, code, name, brand, product_group_id, base_code, variant_code, packaging_name, unit_name, is_active)
VALUES ('p5-sku', 'P5-SKU', 'P5 Product - SKU', 'P5 Brand', 'p5-group', 'P5-SP', 'P5-SKU', 'Thùng', 'thùng', true)
ON CONFLICT (id) DO UPDATE SET is_active = true;
INSERT INTO public.customers(id, code, name, managed_by, debt, status, deleted_at)
VALUES ('p5-customer', 'P5-CUST', 'P5 Customer', 'p5-sale', 0, 'active', NULL)
ON CONFLICT (id) DO UPDATE SET managed_by = 'p5-sale', debt = 0, status = 'active', deleted_at = NULL;
INSERT INTO public.pricelists(id, name, type, price_list_type, is_active, is_available_for_sales, display_order)
VALUES ('p5-general', 'P5 General', 'general', 'general', true, true, 1)
ON CONFLICT (id) DO UPDATE SET is_active = true, is_available_for_sales = true;
INSERT INTO public.price_list_items(id, price_list_id, product_id, variant_id, price)
VALUES ('p5-price', 'p5-general', 'p5-sku', 'p5-sku', 100000)
ON CONFLICT (id) DO UPDATE SET price = 100000;
INSERT INTO public.commission_rules(id, name, position, calculation_basis, commission_rate, effective_from, is_active, priority)
VALUES ('p5-rule', 'P5 five percent', 'sale', 'revenue', 5, now() - interval '1 day', true, 1)
ON CONFLICT (id) DO UPDATE SET commission_rate = 5, effective_from = now() - interval '1 day', is_active = true;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000002', true);
CREATE TEMP TABLE p5_order_response AS
SELECT public.rpc_confirm_order(jsonb_build_object(
  'idempotencyKey', '70000000-0000-4000-8000-000000000099',
  'customerId', 'p5-customer', 'pricelistId', 'p5-general',
  'items', jsonb_build_array(jsonb_build_object('variantId', 'p5-sku', 'quantity', 1,
    'discountType', 'amount', 'discountValue', 0))
)) result;

INSERT INTO phase5_test_results
SELECT 'order_creates_rule_snapshot_commission', EXISTS (
  SELECT 1 FROM public.commission_transactions tx
  WHERE tx.order_id = response.result->>'order_id'
    AND tx.employee_id = (SELECT id FROM public.profiles WHERE auth_user_id = '70000000-0000-4000-8000-000000000002')
    AND tx.transaction_type = 'order_commission' AND tx.commission_amount = 5000
    AND tx.rule_snapshot->>'id' = 'p5-rule'
), response.result::text FROM p5_order_response response;

CREATE TEMP TABLE p5_sale_dashboard AS SELECT public.rpc_get_phase5_dashboard(jsonb_build_object(
  'start', now() - interval '1 day', 'end', now() + interval '1 day')) result;
INSERT INTO phase5_test_results
SELECT 'sale_dashboard_is_server_scoped', (result->'summary'->>'gross_sales')::numeric = 100000
  AND (result->'summary'->>'order_count')::integer = 1, result::text FROM p5_sale_dashboard;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', true);
SELECT public.rpc_save_payroll_adjustment(jsonb_build_object('period', to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM'),
  'employee_id', (SELECT id FROM public.profiles WHERE auth_user_id = '70000000-0000-4000-8000-000000000002'),
  'adjustment_type', 'kpi_bonus', 'amount', 1000, 'notes', 'P5 KPI test'));
SELECT public.rpc_save_payroll_adjustment(jsonb_build_object('period', to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM'),
  'employee_id', (SELECT id FROM public.profiles WHERE auth_user_id = '70000000-0000-4000-8000-000000000002'),
  'adjustment_type', 'deduction', 'amount', 500, 'notes', 'P5 deduction test'));
CREATE TEMP TABLE p5_locked AS SELECT public.rpc_set_payroll_period_lock(
  to_char(now() AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM'), true, NULL) result;
INSERT INTO phase5_test_results
SELECT 'payroll_lock_snapshots_server_calculation', (result->>'isLocked')::boolean
  AND EXISTS (SELECT 1 FROM public.payroll_entries entry
    WHERE entry.employee_id = (SELECT id FROM public.profiles WHERE auth_user_id = '70000000-0000-4000-8000-000000000002')
    AND entry.net_salary = 5005500), result::text FROM p5_locked;

SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000002', true);
DO $test$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_set_payroll_period_lock(to_char(now(), 'YYYY-MM'), false, 'sale must fail');
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  INSERT INTO phase5_test_results VALUES ('non_admin_cannot_unlock', denied, 'admin-only unlock');
END
$test$;

RESET ROLE;
SET LOCAL ROLE anon;
DO $test$
DECLARE denied boolean := false;
BEGIN
  BEGIN
    PERFORM public.rpc_get_phase5_dashboard('{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN denied := true;
  END;
  INSERT INTO phase5_test_results VALUES ('anon_cannot_call_phase5_rpc', denied, 'execute revoked');
END
$test$;

RESET ROLE;
DO $assert$
DECLARE failures jsonb;
BEGIN
  SELECT jsonb_agg(to_jsonb(result)) INTO failures FROM phase5_test_results result WHERE NOT passed;
  IF failures IS NOT NULL THEN RAISE EXCEPTION 'Phase 5 integration failures: %', failures; END IF;
END
$assert$;
TABLE phase5_test_results;
ROLLBACK;
