-- Run only on isolated Supabase staging after migration 0061.
BEGIN;

CREATE TEMP TABLE capability_results (
  test_name text PRIMARY KEY, passed boolean NOT NULL, details text
);
GRANT ALL ON TABLE pg_temp.capability_results TO authenticated;

INSERT INTO capability_results
SELECT 'all_existing_organizations_are_initialized',
  (SELECT count(*) FROM public.organization_settings) =
    (SELECT count(*) FROM public.organizations),
  format('organizations=%s, settings=%s',
    (SELECT count(*) FROM public.organizations),
    (SELECT count(*) FROM public.organization_settings));

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000000', '61000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'capability-a@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '61000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'capability-b@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now());
UPDATE public.profiles SET role = 'admin', is_active = true
WHERE auth_user_id IN ('61000000-0000-4000-8000-000000000001'::uuid,
  '61000000-0000-4000-8000-000000000002'::uuid);

INSERT INTO public.organizations (id, slug, name, status) VALUES
  ('61000000-0000-4000-8000-000000000011', 'capability-a', 'Capability A', 'active'),
  ('61000000-0000-4000-8000-000000000012', 'capability-b', 'Capability B', 'active');
INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES
  ('61000000-0000-4000-8000-000000000011', '61000000-0000-4000-8000-000000000001', 'owner', 'active', true, now()),
  ('61000000-0000-4000-8000-000000000012', '61000000-0000-4000-8000-000000000002', 'owner', 'active', true, now());
INSERT INTO public.organization_subscriptions (organization_id, plan_id, status)
VALUES
  ('61000000-0000-4000-8000-000000000011', 'starter', 'active'),
  ('61000000-0000-4000-8000-000000000012', 'starter', 'active');

INSERT INTO capability_results
SELECT 'new_organization_gets_complete_defaults',
  (SELECT count(*) FROM public.organization_modules WHERE organization_id = '61000000-0000-4000-8000-000000000011') = 10
  AND (SELECT count(*) FROM public.organization_branches WHERE organization_id = '61000000-0000-4000-8000-000000000011' AND is_default) = 1
  AND (SELECT count(*) FROM public.organization_warehouses WHERE organization_id = '61000000-0000-4000-8000-000000000011' AND is_default) = 1,
  '10 modules, one default branch and one default warehouse expected';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '61000000-0000-4000-8000-000000000001', true);

INSERT INTO capability_results
SELECT 'direct_capability_reads_are_tenant_scoped',
  count(*) = 1 AND bool_and(hostname = 'capability-a.sovie.vn'),
  format('visible_domains=%s', count(*))
FROM public.organization_domains;

INSERT INTO capability_results
SELECT 'capability_rpc_returns_only_active_tenant',
  payload->>'organizationId' = '61000000-0000-4000-8000-000000000011'
    AND jsonb_array_length(payload->'branches') = 1
    AND jsonb_array_length(payload->'warehouses') = 1
    AND payload->'modules'->'sales'->>'enabled' = 'true'
    AND payload->'modules'->'manufacturing'->>'enabled' = 'false'
    AND NOT (payload->'domains'->0 ? 'verification_token')
    AND payload->'planLimits'->>'branches' = '1',
  format('payload=%s', payload)
FROM (SELECT public.rpc_my_business_capabilities() AS payload) result;

RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM capability_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Business capability tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE capability_results;
ROLLBACK;
