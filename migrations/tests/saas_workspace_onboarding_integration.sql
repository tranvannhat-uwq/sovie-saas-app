-- Run only on isolated Supabase staging after migration 0063.
BEGIN;

CREATE TEMP TABLE onboarding_results (
  test_name text PRIMARY KEY, passed boolean NOT NULL, details text
);
CREATE TEMP TABLE onboarding_created (payload jsonb NOT NULL);
GRANT ALL ON TABLE pg_temp.onboarding_results, pg_temp.onboarding_created TO authenticated;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '63000000-0000-4000-8000-000000000001',
  'authenticated', 'authenticated', 'onboarding@test.invalid', '',
  '{}'::jsonb, '{}'::jsonb, now(), now()
);
UPDATE public.profiles SET role = 'sale', is_active = true
WHERE auth_user_id = '63000000-0000-4000-8000-000000000001'::uuid;

INSERT INTO onboarding_results
SELECT 'new_profile_starts_without_membership', count(*) = 0,
  format('memberships=%s', count(*))
FROM public.organization_memberships
WHERE auth_user_id = '63000000-0000-4000-8000-000000000001'::uuid;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '63000000-0000-4000-8000-000000000001', true);

INSERT INTO onboarding_results
SELECT 'reserved_slug_is_rejected_by_validator',
  payload->>'available' = 'false' AND payload->>'reserved' = 'true',
  format('payload=%s', payload)
FROM (SELECT public.rpc_validate_organization_slug('admin') payload) value;

INSERT INTO onboarding_results
SELECT 'fresh_slug_is_available',
  payload->>'available' = 'true' AND payload->>'validFormat' = 'true',
  format('payload=%s', payload)
FROM (SELECT public.rpc_validate_organization_slug('onboarding-test-a') payload) value;

INSERT INTO onboarding_created
SELECT public.rpc_create_organization(
  'Onboarding Test A', 'onboarding-test-a', 'services', 'consulting'
);

INSERT INTO onboarding_results
SELECT 'first_workspace_is_created_without_prior_membership',
  payload->>'role' = 'owner'
    AND payload->>'businessType' = 'services'
    AND payload->>'industryKey' = 'consulting',
  format('payload=%s', payload)
FROM onboarding_created;

INSERT INTO onboarding_results
SELECT 'workspace_initialization_is_complete',
  (SELECT count(*) FROM public.organization_memberships membership
    WHERE membership.organization_id = (payload->>'id')::uuid
      AND membership.auth_user_id = auth.uid()
      AND membership.role = 'owner' AND membership.is_default) = 1
  AND (SELECT count(*) FROM public.organization_subscriptions subscription
    WHERE subscription.organization_id = (payload->>'id')::uuid
      AND subscription.plan_id = 'starter' AND subscription.status = 'trialing') = 1
  AND (SELECT count(*) FROM public.organization_branches branch
    WHERE branch.organization_id = (payload->>'id')::uuid AND branch.is_default) = 1
  AND (SELECT count(*) FROM public.organization_warehouses warehouse
    WHERE warehouse.organization_id = (payload->>'id')::uuid AND warehouse.is_default) = 1
  AND (SELECT count(*) FROM public.catalog_units unit
    WHERE unit.organization_id = (payload->>'id')::uuid) = 10,
  'owner, trial, branch, warehouse and 10 units expected'
FROM onboarding_created;

INSERT INTO onboarding_results
SELECT 'created_workspace_becomes_active',
  public.current_organization_id() = (payload->>'id')::uuid,
  format('active=%s, created=%s', public.current_organization_id(), payload->>'id')
FROM onboarding_created;

INSERT INTO onboarding_results
SELECT 'duplicate_slug_becomes_unavailable',
  payload->>'available' = 'false' AND payload->>'reserved' = 'false',
  format('payload=%s', payload)
FROM (SELECT public.rpc_validate_organization_slug('onboarding-test-a') payload) value;

INSERT INTO onboarding_created
SELECT public.rpc_create_organization(
  'Onboarding Test B', 'onboarding-test-b', 'retail', 'general'
);

INSERT INTO onboarding_results
SELECT 'workspace_switch_changes_only_default_membership',
  public.rpc_set_default_organization(
    (SELECT (payload->>'id')::uuid FROM onboarding_created ORDER BY ctid LIMIT 1)
  ) = (SELECT (payload->>'id')::uuid FROM onboarding_created ORDER BY ctid LIMIT 1)
  AND (SELECT count(*) FROM public.organization_memberships membership
    WHERE membership.auth_user_id = auth.uid() AND membership.is_default) = 1,
  'exactly one active default membership expected';

RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM onboarding_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Workspace onboarding tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE onboarding_results;
ROLLBACK;
