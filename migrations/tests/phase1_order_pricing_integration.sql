-- Run only on an isolated Supabase staging database after migrations 0001..0006.
-- All fixtures and business mutations are rolled back.
BEGIN;

CREATE TEMP TABLE phase1_test_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);
GRANT ALL ON TABLE pg_temp.phase1_test_results TO authenticated;

INSERT INTO auth.users(instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'p1-admin@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'p1-sale@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.profiles(id, auth_user_id, username, display_name, role, is_active)
VALUES
  ('p1-admin', '10000000-0000-4000-8000-000000000001', 'p1-admin@test.invalid', 'P1 Admin', 'admin', true),
  ('p1-sale', '10000000-0000-4000-8000-000000000002', 'p1-sale@test.invalid', 'P1 Sale', 'sale', true)
ON CONFLICT DO NOTHING;

UPDATE public.profiles
SET username = fixture.username, display_name = fixture.display_name,
    role = fixture.role, is_active = true
FROM (VALUES
  ('10000000-0000-4000-8000-000000000001'::uuid, 'p1-admin@test.invalid', 'P1 Admin', 'admin'),
  ('10000000-0000-4000-8000-000000000002'::uuid, 'p1-sale@test.invalid', 'P1 Sale', 'sale')
) AS fixture(auth_user_id, username, display_name, role)
WHERE public.profiles.auth_user_id = fixture.auth_user_id;

INSERT INTO public.product_groups(id, base_code, product_name, brand_name)
VALUES ('p1-group', 'CT-D1', 'Son lot chong kiem noi that', 'P1')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.products(id, code, name, brand, product_group_id, base_code, variant_code,
  packaging_name, weight_or_volume, unit_name, is_active)
VALUES
  ('p1-sku-active', 'CT-D1-LON', 'Son lot chong kiem noi that - Lon', 'P1', 'p1-group', 'CT-D1', 'CT-D1-LON', 'Lon', 6.3, 'kg', true),
  ('p1-sku-inactive', 'CT-D1-OLD', 'SKU inactive', 'P1', 'p1-group', 'CT-D1', 'CT-D1-OLD', 'Lon', 6.3, 'kg', false)
ON CONFLICT (id) DO UPDATE SET is_active = EXCLUDED.is_active;

INSERT INTO public.customers(id, code, name, managed_by, debt, status, deleted_at)
VALUES ('p1-customer', 'P1-CUST', 'P1 Customer', 'p1-sale@test.invalid', 0, 'active', NULL)
ON CONFLICT (id) DO UPDATE SET managed_by = EXCLUDED.managed_by, debt = 0, status = 'active', deleted_at = NULL;

INSERT INTO public.pricelists(id, name, type, price_list_type, customer_id,
  is_active, is_available_for_sales, display_order)
VALUES
  ('p1-general', 'P1 General', 'general', 'general', NULL, true, true, 1),
  ('p1-private', 'P1 Dealer Private', 'dealer_private', 'dealer_private', 'p1-customer', true, false, 1)
ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type, price_list_type = EXCLUDED.price_list_type,
  customer_id = EXCLUDED.customer_id, is_active = true,
  is_available_for_sales = EXCLUDED.is_available_for_sales;

INSERT INTO public.price_list_items(id, price_list_id, product_id, variant_id, price)
VALUES
  ('p1-general-active', 'p1-general', 'p1-sku-active', 'p1-sku-active', 100000),
  ('p1-private-active', 'p1-private', 'p1-sku-active', 'p1-sku-active', 80000),
  ('p1-general-inactive', 'p1-general', 'p1-sku-inactive', 'p1-sku-inactive', 50000)
ON CONFLICT (id) DO UPDATE SET price = EXCLUDED.price;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000001', true);

CREATE TEMP TABLE phase1_first_response AS
SELECT public.rpc_confirm_order(jsonb_build_object(
  'idempotencyKey', '20000000-0000-4000-8000-000000000001',
  'customerId', 'p1-customer', 'pricelistId', 'p1-general',
  'totalPayable', 1, 'amountDue', 1,
  'discountType', 'amount', 'discountValue', 10000,
  'shippingFeeValue', 5000,
  'items', jsonb_build_array(jsonb_build_object(
    'variantId', 'p1-sku-active', 'quantity', 2,
    'unitPrice', 1, 'finalUnitPrice', 1,
    'discountType', 'percent', 'discountValue', 10
  ))
)) AS result;

INSERT INTO phase1_test_results
SELECT 'database_recalculates_tampered_prices_and_totals',
  (result->'order'->>'totalMarket')::numeric = 160000
  AND (result->'order'->>'subtotal')::numeric = 144000
  AND (result->'order'->>'totalPayable')::numeric = 134000
  AND (result->'order'->>'totalAmount')::numeric = 139000
  AND (result->'order'->>'amountDue')::numeric = 139000
  AND (result->'order'->'items'->0->>'unitPrice')::numeric = 80000
  AND result->'order'->>'pricelistId' = 'p1-private',
  result::text
FROM phase1_first_response;

INSERT INTO phase1_test_results
SELECT 'rpc_stamps_auth_uid', EXISTS (
  SELECT 1 FROM public.audit_logs
  WHERE table_name = 'orders'
    AND record_id = (SELECT result->>'order_id' FROM phase1_first_response)
    AND performed_by = '10000000-0000-4000-8000-000000000001'
), 'audit actor must equal auth.uid()';

CREATE TEMP TABLE phase1_retry_response AS
SELECT public.rpc_confirm_order(jsonb_build_object(
  'idempotencyKey', '20000000-0000-4000-8000-000000000001',
  'customerId', 'p1-customer', 'pricelistId', 'p1-general',
  'discountType', 'amount', 'discountValue', 10000, 'shippingFeeValue', 5000,
  'items', jsonb_build_array(jsonb_build_object(
    'variantId', 'p1-sku-active', 'quantity', 2,
    'discountType', 'percent', 'discountValue', 10
  ))
)) AS result;

INSERT INTO phase1_test_results
SELECT 'same_idempotency_payload_returns_original_order',
  retry.result->>'order_id' = first.result->>'order_id'
    AND (retry.result->>'already_finalized')::boolean
    AND (SELECT count(*) FROM public.orders WHERE idempotency_key = '20000000-0000-4000-8000-000000000001') = 1,
  retry.result::text
FROM phase1_retry_response retry CROSS JOIN phase1_first_response first;

CREATE FUNCTION pg_temp.p1_conflicting_retry_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_confirm_order(jsonb_build_object(
    'idempotencyKey', '20000000-0000-4000-8000-000000000001',
    'customerId', 'p1-customer', 'pricelistId', 'p1-general',
    'items', jsonb_build_array(jsonb_build_object('variantId', 'p1-sku-active', 'quantity', 3))
  ));
  RETURN false;
EXCEPTION WHEN unique_violation THEN RETURN true;
END $$;

CREATE FUNCTION pg_temp.p1_inactive_sku_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_confirm_order(jsonb_build_object(
    'idempotencyKey', '20000000-0000-4000-8000-000000000002',
    'customerId', 'p1-customer', 'pricelistId', 'p1-general',
    'items', jsonb_build_array(jsonb_build_object('variantId', 'p1-sku-inactive', 'quantity', 1))
  ));
  RETURN false;
EXCEPTION WHEN no_data_found THEN RETURN true;
END $$;

INSERT INTO phase1_test_results VALUES
  ('same_key_different_payload_is_rejected', pg_temp.p1_conflicting_retry_rejected(), '23505 expected'),
  ('inactive_sku_is_rejected', pg_temp.p1_inactive_sku_rejected(), 'no active SKU expected'),
  ('authenticated_cannot_physically_delete_final_orders',
    NOT has_table_privilege('authenticated', 'public.orders', 'DELETE'), 'table grant check');

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);

CREATE FUNCTION pg_temp.p1_private_list_rejected()
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_confirm_order(jsonb_build_object(
    'idempotencyKey', '20000000-0000-4000-8000-000000000003',
    'customerId', 'p1-customer', 'pricelistId', 'p1-private',
    'items', jsonb_build_array(jsonb_build_object('variantId', 'p1-sku-active', 'quantity', 1))
  ));
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN RETURN true;
END $$;

INSERT INTO phase1_test_results VALUES
  ('sale_cannot_force_private_price_list', pg_temp.p1_private_list_rejected(), '42501 expected');

RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM phase1_test_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Phase 1 integration tests failed:\n%', failed;
  END IF;
END $$;

TABLE phase1_test_results;
ROLLBACK;
