-- Run only on isolated Supabase staging after migration 0069.
BEGIN;

CREATE TEMP TABLE quota_results (
  test_name text PRIMARY KEY, passed boolean NOT NULL, details text
);
GRANT ALL ON TABLE pg_temp.quota_results TO authenticated, saas_rpc_executor;

INSERT INTO public.saas_plans (id, name, description, limits, is_public, is_active)
VALUES ('quota-test', 'Quota Test', 'Integration-only two-order plan',
  '{"users":5,"monthly_orders":2}'::jsonb, false, true);

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000', identity.id,
  'authenticated', 'authenticated', identity.email, '', '{}'::jsonb, '{}'::jsonb, now(), now()
FROM (VALUES
  ('69000000-0000-4000-8000-000000000001'::uuid, 'quota-owner-a@test.invalid'),
  ('69000000-0000-4000-8000-000000000002'::uuid, 'quota-owner-b@test.invalid')
) identity(id, email);

INSERT INTO public.organizations (id, slug, name, status, created_by) VALUES
  ('69000000-0000-4000-8000-100000000001', 'quota-test-a', 'Quota Test A', 'active', '69000000-0000-4000-8000-000000000001'),
  ('69000000-0000-4000-8000-100000000002', 'quota-test-b', 'Quota Test B', 'active', '69000000-0000-4000-8000-000000000002');
INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES
  ('69000000-0000-4000-8000-100000000001', '69000000-0000-4000-8000-000000000001', 'owner', 'active', true, now()),
  ('69000000-0000-4000-8000-100000000002', '69000000-0000-4000-8000-000000000002', 'owner', 'active', true, now());
INSERT INTO public.organization_subscriptions (
  organization_id, plan_id, status, current_period_start, current_period_end
) VALUES
  ('69000000-0000-4000-8000-100000000001', 'quota-test', 'active', now(), now() + interval '30 days'),
  ('69000000-0000-4000-8000-100000000002', 'quota-test', 'active', now(), now() + interval '30 days');

SET LOCAL ROLE saas_rpc_executor;
SELECT set_config('request.jwt.claim.sub', '69000000-0000-4000-8000-000000000001', true);
INSERT INTO public.orders (
  organization_id, id, customer_name, status, created_by, confirmed_at, created_at
) VALUES
  ('69000000-0000-4000-8000-100000000001', 'quota-order-a1', 'Quota Customer', 'settled', '69000000-0000-4000-8000-000000000001', now(), now()),
  ('69000000-0000-4000-8000-100000000001', 'quota-order-a2', 'Quota Customer', 'settled', '69000000-0000-4000-8000-000000000001', now(), now());

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '69000000-0000-4000-8000-000000000001', true);
INSERT INTO quota_results
SELECT 'usage_reports_current_tenant_limit',
  payload->'orders'->>'used' = '2' AND payload->'orders'->>'limit' = '2', payload::text
FROM (SELECT public.rpc_my_plan_usage() payload) usage;
INSERT INTO quota_results
SELECT 'browser_cannot_bypass_order_rpc',
  NOT has_table_privilege('authenticated', 'public.orders', 'INSERT'), NULL;

RESET ROLE;
SET LOCAL ROLE saas_rpc_executor;
SELECT set_config('request.jwt.claim.sub', '69000000-0000-4000-8000-000000000001', true);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.orders (
      organization_id, id, customer_name, status, created_by, confirmed_at, created_at
    ) VALUES (
      '69000000-0000-4000-8000-100000000001', 'quota-order-a3',
      'Quota Customer', 'settled', '69000000-0000-4000-8000-000000000001', now(), now()
    );
    INSERT INTO quota_results VALUES ('third_order_is_blocked', false, 'third order unexpectedly succeeded');
  EXCEPTION WHEN raise_exception THEN
    INSERT INTO quota_results VALUES (
      'third_order_is_blocked', SQLERRM = 'Monthly order limit reached (2 orders)', SQLERRM
    );
  END;
END;
$$;

INSERT INTO public.orders (
  organization_id, id, customer_name, status, created_by, confirmed_at, created_at
) VALUES (
  '69000000-0000-4000-8000-100000000001', 'quota-cancelled-does-not-count',
  'Quota Customer', 'cancelled', '69000000-0000-4000-8000-000000000001', now(), now()
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '69000000-0000-4000-8000-000000000001', true);
INSERT INTO quota_results
SELECT 'cancelled_order_does_not_consume_quota',
  payload->'orders'->>'used' = '2', payload::text
FROM (SELECT public.rpc_my_plan_usage() payload) usage;

RESET ROLE;
SET LOCAL ROLE saas_rpc_executor;
SELECT set_config('request.jwt.claim.sub', '69000000-0000-4000-8000-000000000002', true);
INSERT INTO public.orders (
  organization_id, id, customer_name, status, created_by, confirmed_at, created_at
) VALUES (
  '69000000-0000-4000-8000-100000000002', 'quota-order-b1',
  'Other Tenant Customer', 'settled', '69000000-0000-4000-8000-000000000002', now(), now()
);

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '69000000-0000-4000-8000-000000000002', true);
INSERT INTO quota_results
SELECT 'quota_is_independent_per_tenant',
  payload->'orders'->>'used' = '1' AND payload->'orders'->>'limit' = '2', payload::text
FROM (SELECT public.rpc_my_plan_usage() payload) usage;

RESET ROLE;
DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM quota_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Monthly order quota tests failed:\n%', failed;
  END IF;
END;
$$;
TABLE quota_results;
ROLLBACK;
