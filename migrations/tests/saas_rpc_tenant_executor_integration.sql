-- Run only on isolated Supabase staging after migration 0060.
BEGIN;

CREATE TEMP TABLE rpc_tenant_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);
GRANT ALL ON TABLE pg_temp.rpc_tenant_results TO authenticated;

INSERT INTO rpc_tenant_results
SELECT 'rpc_executor_cannot_login_or_bypass_rls',
  NOT rolcanlogin AND NOT rolbypassrls,
  format('canlogin=%s, bypassrls=%s', rolcanlogin, rolbypassrls)
FROM pg_roles WHERE rolname = 'saas_rpc_executor';

INSERT INTO rpc_tenant_results
SELECT 'all_business_tables_have_rpc_tenant_policy',
  count(*) = 35,
  format('policies=%s', count(*))
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname = 'saas_rpc_executor_tenant_scope'
  AND roles = ARRAY['saas_rpc_executor']::name[];

INSERT INTO rpc_tenant_results
SELECT 'all_callable_business_definers_use_rpc_executor',
  count(*) = 39
    AND bool_and(pg_get_userbyid(p.proowner) = 'saas_rpc_executor'),
  format('callable_functions=%s, executor_owned=%s', count(*),
    count(*) FILTER (WHERE pg_get_userbyid(p.proowner) = 'saas_rpc_executor'))
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.prosecdef
  AND has_function_privilege('authenticated', p.oid, 'EXECUTE')
  AND pg_get_functiondef(p.oid) ~* '\m(companies|brands|products|product_groups|pricelists|price_list_items|customers|orders|order_items|draft_orders|customer_debt_transactions|cashbook_transactions|payments|supplier_debt_transactions|suppliers|purchases|purchase_items|purchase_payments|sales_returns|sales_return_items|commission_transactions|payroll_periods|payroll_adjustments|payroll_entries|audit_logs|activity_logs)\M';

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000000', '60000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'rpc-tenant-a@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '60000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'rpc-tenant-b@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

UPDATE public.profiles SET role = 'admin', is_active = true
WHERE auth_user_id IN (
  '60000000-0000-4000-8000-000000000001'::uuid,
  '60000000-0000-4000-8000-000000000002'::uuid
);

INSERT INTO public.organizations (id, slug, name, status) VALUES
  ('60000000-0000-4000-8000-000000000011', 'rpc-tenant-a', 'RPC Tenant A', 'active'),
  ('60000000-0000-4000-8000-000000000012', 'rpc-tenant-b', 'RPC Tenant B', 'active');
INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES
  ('60000000-0000-4000-8000-000000000011', '60000000-0000-4000-8000-000000000001', 'owner', 'active', true, now()),
  ('60000000-0000-4000-8000-000000000012', '60000000-0000-4000-8000-000000000002', 'owner', 'active', true, now());

INSERT INTO public.activity_logs (
  id, organization_id, operation_key, actor_id, actor_name, action,
  module, target_type, target_id
) VALUES
  ('rpc-activity-a', '60000000-0000-4000-8000-000000000011', 'rpc-op-a',
    '60000000-0000-4000-8000-000000000001', 'RPC A', 'create',
    'test', 'test', 'tenant-a-visible'),
  ('rpc-activity-b', '60000000-0000-4000-8000-000000000012', 'rpc-op-b',
    '60000000-0000-4000-8000-000000000002', 'RPC B', 'create',
    'test', 'test', 'tenant-b-hidden');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '60000000-0000-4000-8000-000000000001', true);

INSERT INTO rpc_tenant_results
SELECT 'membership_role_is_database_authority',
  public.current_profile_role() = 'admin',
  format('mapped_role=%s', public.current_profile_role());

INSERT INTO rpc_tenant_results
SELECT 'activity_rpc_cannot_read_other_tenant',
  (payload->>'total')::integer = 1
    AND payload->'rows'->0->>'target_id' = 'tenant-a-visible',
  format('payload=%s', payload)
FROM (SELECT public.rpc_get_activity_logs('{"limit":10}'::jsonb) AS payload) result;

RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM rpc_tenant_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'SaaS RPC tenant-executor tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE rpc_tenant_results;
ROLLBACK;
