-- Run only on an isolated Supabase staging database after migration 0056.
-- All identities, organizations and membership changes are rolled back.
BEGIN;

CREATE TEMP TABLE saas_test_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);
GRANT ALL ON TABLE pg_temp.saas_test_results TO authenticated;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000000', '56000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'saas-a@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '56000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'saas-b@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, slug, name, status)
VALUES
  ('56000000-0000-4000-8000-000000000011', 'saas-test-a', 'SaaS Test A', 'active'),
  ('56000000-0000-4000-8000-000000000012', 'saas-test-b', 'SaaS Test B', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES
  ('56000000-0000-4000-8000-000000000011', '56000000-0000-4000-8000-000000000001',
    'owner', 'active', true, now()),
  ('56000000-0000-4000-8000-000000000012', '56000000-0000-4000-8000-000000000002',
    'owner', 'active', true, now())
ON CONFLICT (organization_id, auth_user_id) DO UPDATE
SET role = EXCLUDED.role, status = 'active', is_default = true;

CREATE FUNCTION pg_temp.saas_cross_tenant_switch_rejected(p_target uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  PERFORM public.rpc_set_default_organization(p_target);
  RETURN false;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN true;
END;
$$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '56000000-0000-4000-8000-000000000001', true);

INSERT INTO saas_test_results
SELECT 'tenant_a_reads_only_its_organization',
  count(*) = 1 AND bool_and(id = '56000000-0000-4000-8000-000000000011'::uuid),
  'organization RLS'
FROM public.organizations
WHERE id IN (
  '56000000-0000-4000-8000-000000000011'::uuid,
  '56000000-0000-4000-8000-000000000012'::uuid
);

INSERT INTO saas_test_results
SELECT 'tenant_a_reads_only_its_membership',
  count(*) = 1
    AND bool_and(auth_user_id = '56000000-0000-4000-8000-000000000001'::uuid),
  'membership RLS'
FROM public.organization_memberships
WHERE organization_id IN (
  '56000000-0000-4000-8000-000000000011'::uuid,
  '56000000-0000-4000-8000-000000000012'::uuid
);

INSERT INTO saas_test_results VALUES (
  'tenant_a_cannot_select_tenant_b',
  pg_temp.saas_cross_tenant_switch_rejected('56000000-0000-4000-8000-000000000012'),
  'rpc membership guard'
);

INSERT INTO saas_test_results
SELECT 'tenant_a_context_uses_membership_default',
  rpc_context->>'activeOrganizationId' = '56000000-0000-4000-8000-000000000011'
    AND jsonb_array_length(rpc_context->'organizations') = 1,
  rpc_context::text
FROM (SELECT public.rpc_my_saas_context() AS rpc_context) context;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '56000000-0000-4000-8000-000000000002', true);

INSERT INTO saas_test_results
SELECT 'tenant_b_reads_only_its_organization',
  count(*) = 1 AND bool_and(id = '56000000-0000-4000-8000-000000000012'::uuid),
  'organization RLS'
FROM public.organizations
WHERE id IN (
  '56000000-0000-4000-8000-000000000011'::uuid,
  '56000000-0000-4000-8000-000000000012'::uuid
);

INSERT INTO saas_test_results VALUES (
  'authenticated_cannot_mutate_subscription_directly',
  NOT has_table_privilege('authenticated', 'public.organization_subscriptions', 'INSERT')
    AND NOT has_table_privilege('authenticated', 'public.organization_subscriptions', 'UPDATE')
    AND NOT has_table_privilege('authenticated', 'public.organization_subscriptions', 'DELETE'),
  'billing state is server-owned'
);

RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM saas_test_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'SaaS control-plane tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE saas_test_results;
ROLLBACK;
