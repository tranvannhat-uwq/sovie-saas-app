-- Run only on an isolated Supabase staging database after migration 0106.
BEGIN;

CREATE TEMP TABLE login_domain_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);
GRANT ALL ON TABLE pg_temp.login_domain_results TO authenticated;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000000', '10600000-0000-4000-8000-000000000001',
   'authenticated', 'authenticated', 'login-domain-a@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10600000-0000-4000-8000-000000000002',
   'authenticated', 'authenticated', 'login-domain-b@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10600000-0000-4000-8000-000000000003',
   'authenticated', 'authenticated', 'login-domain-new@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '10600000-0000-4000-8000-000000000004',
   'authenticated', 'authenticated', 'login-domain-platform@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, slug, name, status) VALUES
  ('10600000-0000-4000-8000-100000000001', 'login-domain-a', 'Login Domain A', 'active'),
  ('10600000-0000-4000-8000-100000000002', 'login-domain-b', 'Login Domain B', 'active'),
  ('10600000-0000-4000-8000-100000000003', 'login-domain-old', 'Login Domain Previous', 'active')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES
  ('10600000-0000-4000-8000-100000000001', '10600000-0000-4000-8000-000000000001', 'owner', 'active', false, now()),
  ('10600000-0000-4000-8000-100000000003', '10600000-0000-4000-8000-000000000001', 'admin', 'active', true, now()),
  ('10600000-0000-4000-8000-100000000002', '10600000-0000-4000-8000-000000000002', 'owner', 'active', true, now())
ON CONFLICT (organization_id, auth_user_id) DO UPDATE
SET role = EXCLUDED.role, status = 'active', is_default = EXCLUDED.is_default;

INSERT INTO public.organization_domains (
  organization_id, hostname, domain_type, status, is_primary, ssl_status
) VALUES
  ('10600000-0000-4000-8000-100000000001', 'tenant-a-login-test.sovie.vn', 'sovie_subdomain', 'active', false, 'active'),
  ('10600000-0000-4000-8000-100000000002', 'tenant-b-login-test.sovie.vn', 'sovie_subdomain', 'active', false, 'active'),
  ('10600000-0000-4000-8000-100000000001', 'pending-login-test.example.test', 'custom', 'pending', false, 'pending'),
  ('10600000-0000-4000-8000-100000000001', 'ssl-pending-login-test.example.test', 'custom', 'active', false, 'pending')
ON CONFLICT ((lower(hostname))) DO UPDATE
SET status = EXCLUDED.status, ssl_status = EXCLUDED.ssl_status;

INSERT INTO public.platform_staff (auth_user_id, role, is_active)
VALUES ('10600000-0000-4000-8000-000000000004', 'platform_owner', true)
ON CONFLICT (auth_user_id) DO UPDATE SET is_active = true;

CREATE FUNCTION pg_temp.bind_login_domain(p_hostname text)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER AS $$
  SELECT public.rpc_bind_login_to_workspace_domain(p_hostname)
$$;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10600000-0000-4000-8000-000000000001', true);
SELECT set_config('request.headers', '{"origin":"https://tenant-a-login-test.sovie.vn"}', true);

DO $$
DECLARE result jsonb;
BEGIN
  result := pg_temp.bind_login_domain('TENANT-A-LOGIN-TEST.SOVIE.VN.');
  INSERT INTO login_domain_results VALUES (
    'tenant_member_binds_exact_matching_domain',
    result->>'allowed' = 'true'
      AND result->>'organizationId' = '10600000-0000-4000-8000-100000000001',
    result::text
  );

  result := pg_temp.bind_login_domain('tenant-b-login-test.sovie.vn');
  INSERT INTO login_domain_results VALUES (
    'tenant_member_cannot_login_to_another_workspace',
    result->>'allowed' = 'false', result::text
  );

  result := pg_temp.bind_login_domain('pending-login-test.example.test');
  INSERT INTO login_domain_results VALUES (
    'pending_domain_is_not_a_login_domain',
    result->>'allowed' = 'false', result::text
  );

  result := pg_temp.bind_login_domain('ssl-pending-login-test.example.test');
  INSERT INTO login_domain_results VALUES (
    'domain_without_active_ssl_is_not_a_login_domain',
    result->>'allowed' = 'false', result::text
  );

  result := pg_temp.bind_login_domain('unregistered-login-test.example.test');
  INSERT INTO login_domain_results VALUES (
    'tenant_member_cannot_login_from_an_unregistered_domain',
    result->>'allowed' = 'false', result::text
  );

  result := pg_temp.bind_login_domain('tenant-b-login-test.sovie.vn');
  INSERT INTO login_domain_results VALUES (
    'origin_cannot_be_overridden_by_a_different_hostname_parameter',
    result->>'allowed' = 'false', result::text
  );
END;
$$;

INSERT INTO login_domain_results
SELECT 'tenant_a_default_changes_to_the_domain_workspace',
  EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE auth_user_id = '10600000-0000-4000-8000-000000000001'
      AND organization_id = '10600000-0000-4000-8000-100000000001'
      AND is_default
  ),
  'hostname selects the exact active workspace'
FROM (SELECT 1) seed;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10600000-0000-4000-8000-000000000003', true);
SELECT set_config('request.headers', '{"origin":"https://sovie.vn"}', true);
INSERT INTO login_domain_results
SELECT 'new_user_without_workspace_can_continue_onboarding',
  result->>'allowed' = 'true' AND result->'organizationId' = 'null'
    AND result->>'platformOnly' = 'false',
  result::text
FROM (SELECT public.rpc_bind_login_to_workspace_domain('sovie.vn') result) binding;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10600000-0000-4000-8000-000000000004', true);
SELECT set_config('request.headers', '{"origin":"https://sovie.vn"}', true);
INSERT INTO login_domain_results
SELECT 'platform_staff_keeps_platform_only_login',
  result->>'allowed' = 'true' AND result->>'platformOnly' = 'true',
  result::text
FROM (SELECT public.rpc_bind_login_to_workspace_domain('sovie.vn') result) binding;

RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM login_domain_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Workspace login domain tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE login_domain_results;
ROLLBACK;
