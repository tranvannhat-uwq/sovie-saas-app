-- Run only on isolated Supabase staging after migration 0070.
BEGIN;

CREATE TEMP TABLE domain_results (
  test_name text PRIMARY KEY, passed boolean NOT NULL, details text
);
GRANT ALL ON TABLE pg_temp.domain_results TO authenticated, service_role;

INSERT INTO public.saas_plans (id, name, description, limits, is_public, is_active)
VALUES ('domain-test', 'Domain Test', 'Integration-only custom-domain plan',
  '{"users":5,"monthly_orders":500,"custom_domains":1}'::jsonb, false, true);

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000', identity.id,
  'authenticated', 'authenticated', identity.email, '', '{}'::jsonb, '{}'::jsonb, now(), now()
FROM (VALUES
  ('70000000-0000-4000-8000-000000000001'::uuid, 'domain-owner-starter@test.invalid'),
  ('70000000-0000-4000-8000-000000000002'::uuid, 'domain-owner-business@test.invalid')
) identity(id, email);

INSERT INTO public.organizations (id, slug, name, status, created_by) VALUES
  ('70000000-0000-4000-8000-100000000001', 'domain-starter', 'Domain Starter', 'active', '70000000-0000-4000-8000-000000000001'),
  ('70000000-0000-4000-8000-100000000002', 'domain-business', 'Domain Business', 'active', '70000000-0000-4000-8000-000000000002');
INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES
  ('70000000-0000-4000-8000-100000000001', '70000000-0000-4000-8000-000000000001', 'owner', 'active', true, now()),
  ('70000000-0000-4000-8000-100000000002', '70000000-0000-4000-8000-000000000002', 'owner', 'active', true, now());
INSERT INTO public.organization_subscriptions (
  organization_id, plan_id, status, current_period_start, current_period_end
) VALUES
  ('70000000-0000-4000-8000-100000000001', 'starter', 'active', now(), now() + interval '30 days'),
  ('70000000-0000-4000-8000-100000000002', 'domain-test', 'active', now(), now() + interval '30 days');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.rpc_request_custom_domain('starter.example.test');
    INSERT INTO domain_results VALUES ('starter_plan_cannot_request_custom_domain', false, 'request unexpectedly succeeded');
  EXCEPTION WHEN raise_exception THEN
    INSERT INTO domain_results VALUES (
      'starter_plan_cannot_request_custom_domain', SQLERRM = 'Custom domain limit reached (0 domains)', SQLERRM
    );
  END;
END;
$$;

SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000002', true);
CREATE TEMP TABLE requested_domain AS
SELECT public.rpc_request_custom_domain('shop.example.test') payload;
GRANT SELECT ON TABLE pg_temp.requested_domain TO service_role;
INSERT INTO domain_results
SELECT 'eligible_owner_receives_dns_verification_record',
  payload->>'status' = 'pending'
    AND payload->'verification'->>'type' = 'TXT'
    AND length(payload->'verification'->>'value') >= 32,
  payload::text
FROM requested_domain;

DO $$
BEGIN
  BEGIN
    PERFORM public.rpc_request_custom_domain('second.example.test');
    INSERT INTO domain_results VALUES ('custom_domain_quota_is_enforced', false, 'second request unexpectedly succeeded');
  EXCEPTION WHEN raise_exception THEN
    INSERT INTO domain_results VALUES (
      'custom_domain_quota_is_enforced', SQLERRM = 'Custom domain limit reached (1 domains)', SQLERRM
    );
  END;
END;
$$;

RESET ROLE;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE verified_domain AS
SELECT public.rpc_apply_domain_verification(
  'domain-test-verified', (SELECT (payload->>'domainId')::uuid FROM requested_domain),
  true, true, 'system', 'dns-and-ssl-evidence'
) payload;
INSERT INTO domain_results
SELECT 'service_verification_requires_dns_and_ssl',
  payload->>'status' = 'active' AND payload->>'sslStatus' = 'active', payload::text
FROM verified_domain;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000002', true);

-- A different tenant must not receive the TXT verification secret.
SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000001', true);
DO $$
BEGIN
  BEGIN
    PERFORM public.rpc_my_custom_domain_verification(
      (SELECT (payload->>'domainId')::uuid FROM requested_domain)
    );
    INSERT INTO domain_results VALUES ('verification_secret_is_tenant_private', false, 'other tenant read unexpectedly succeeded');
  EXCEPTION WHEN SQLSTATE 'P0002' THEN
    INSERT INTO domain_results VALUES ('verification_secret_is_tenant_private', true, SQLERRM);
  END;
END;
$$;

SELECT set_config('request.jwt.claim.sub', '70000000-0000-4000-8000-000000000002', true);
SELECT public.rpc_set_primary_custom_domain(
  (SELECT (payload->>'domainId')::uuid FROM requested_domain)
);
INSERT INTO domain_results
SELECT 'verified_domain_becomes_the_only_primary',
  count(*) FILTER (WHERE is_primary) = 1
    AND bool_or(hostname = 'shop.example.test' AND is_primary),
  format('domains=%s', jsonb_agg(jsonb_build_object('hostname', hostname, 'primary', is_primary)))
FROM public.organization_domains
WHERE organization_id = '70000000-0000-4000-8000-100000000002';

SELECT public.rpc_disable_custom_domain(
  (SELECT (payload->>'domainId')::uuid FROM requested_domain)
);
INSERT INTO domain_results
SELECT 'disabling_primary_restores_sovie_subdomain',
  count(*) FILTER (WHERE is_primary) = 1
    AND bool_or(domain_type = 'sovie_subdomain' AND is_primary),
  format('domains=%s', jsonb_agg(jsonb_build_object('hostname', hostname, 'status', status, 'primary', is_primary)))
FROM public.organization_domains
WHERE organization_id = '70000000-0000-4000-8000-100000000002';

RESET ROLE;
DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM domain_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Custom domain tests failed:\n%', failed;
  END IF;
END;
$$;
TABLE domain_results;
ROLLBACK;
