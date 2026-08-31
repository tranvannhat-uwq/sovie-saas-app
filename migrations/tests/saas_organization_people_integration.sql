-- Run only on isolated Supabase staging after migration 0067.
BEGIN;

CREATE TEMP TABLE people_results (
  test_name text PRIMARY KEY, passed boolean NOT NULL, details text
);
GRANT ALL ON TABLE pg_temp.people_results TO authenticated;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000', identity.id,
  'authenticated', 'authenticated', identity.email, '', '{}'::jsonb, '{}'::jsonb, now(), now()
FROM (VALUES
  ('67000000-0000-4000-8000-000000000001'::uuid, 'people-owner-a@test.invalid'),
  ('67000000-0000-4000-8000-000000000002'::uuid, 'people-owner-b@test.invalid'),
  ('67000000-0000-4000-8000-000000000003'::uuid, 'people-sale-a@test.invalid')
) identity(id, email);

INSERT INTO public.organizations (id, slug, name, status, created_by) VALUES
  ('67000000-0000-4000-8000-100000000001', 'people-test-a', 'People Test A', 'trialing', '67000000-0000-4000-8000-000000000001'),
  ('67000000-0000-4000-8000-100000000002', 'people-test-b', 'People Test B', 'trialing', '67000000-0000-4000-8000-000000000002');
INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES
  ('67000000-0000-4000-8000-100000000001', '67000000-0000-4000-8000-000000000001', 'owner', 'active', true, now()),
  ('67000000-0000-4000-8000-100000000001', '67000000-0000-4000-8000-000000000003', 'sale', 'active', true, now()),
  ('67000000-0000-4000-8000-100000000002', '67000000-0000-4000-8000-000000000002', 'owner', 'active', true, now());

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000001', true);

CREATE TEMP TABLE created_person AS
SELECT public.rpc_upsert_organization_person(
  NULL, 'CTV-001', 'Cộng tác viên A', '0901000001', 'Cộng tác viên bán hàng',
  NULL, 'contractor', 'active'
) payload;

INSERT INTO people_results
SELECT 'owner_creates_person_without_auth_or_user_quota',
  payload->>'personId' LIKE 'person_%'
    AND payload->>'employmentType' = 'contractor'
    AND (SELECT count(*) FROM public.organization_memberships
         WHERE organization_id = '67000000-0000-4000-8000-100000000001') = 2,
  payload::text
FROM created_person;

INSERT INTO people_results
SELECT 'directory_is_scoped_to_active_workspace', count(*) = 1,
  format('rows=%s', count(*))
FROM public.rpc_my_organization_people();

SELECT set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000003', true);
INSERT INTO people_results
SELECT 'sale_can_read_business_directory', count(*) = 1,
  format('rows=%s', count(*))
FROM public.rpc_my_organization_people();

DO $$
BEGIN
  BEGIN
    PERFORM public.rpc_upsert_organization_person(
      NULL, 'SALE-CANNOT-WRITE', 'Denied Person', NULL, NULL, NULL, 'employee', 'active'
    );
    INSERT INTO people_results VALUES ('sale_cannot_mutate_directory', false, 'write unexpectedly succeeded');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO people_results VALUES ('sale_cannot_mutate_directory', true, SQLERRM);
  END;
END;
$$;

SELECT set_config('request.jwt.claim.sub', '67000000-0000-4000-8000-000000000002', true);
INSERT INTO people_results
SELECT 'other_workspace_cannot_see_person', count(*) = 0,
  format('rows=%s', count(*))
FROM public.rpc_my_organization_people();

RESET ROLE;
DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM people_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Organization people tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE people_results;
ROLLBACK;
