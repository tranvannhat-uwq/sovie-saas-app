-- Run only on isolated Supabase staging after migration 0064.
BEGIN;

CREATE TEMP TABLE member_results (
  test_name text PRIMARY KEY, passed boolean NOT NULL, details text
);
GRANT ALL ON TABLE pg_temp.member_results TO authenticated;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000', identity.id,
  'authenticated', 'authenticated', identity.email, '', '{}'::jsonb, '{}'::jsonb, now(), now()
FROM (VALUES
  ('64000000-0000-4000-8000-000000000001'::uuid, 'member-owner@test.invalid'),
  ('64000000-0000-4000-8000-000000000002'::uuid, 'member-a@test.invalid'),
  ('64000000-0000-4000-8000-000000000003'::uuid, 'member-b@test.invalid'),
  ('64000000-0000-4000-8000-000000000004'::uuid, 'member-c@test.invalid'),
  ('64000000-0000-4000-8000-000000000005'::uuid, 'member-d@test.invalid'),
  ('64000000-0000-4000-8000-000000000006'::uuid, 'member-e@test.invalid'),
  ('64000000-0000-4000-8000-000000000007'::uuid, 'member-f@test.invalid')
) identity(id, email);

INSERT INTO public.organizations (id, slug, name, status, created_by)
VALUES (
  '64000000-0000-4000-8000-100000000001', 'member-management-test',
  'Member Management Test', 'trialing', '64000000-0000-4000-8000-000000000001'
);
INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES (
  '64000000-0000-4000-8000-100000000001',
  '64000000-0000-4000-8000-000000000001', 'owner', 'active', true, now()
);
INSERT INTO public.organization_subscriptions (
  organization_id, plan_id, status, current_period_start, current_period_end
) VALUES (
  '64000000-0000-4000-8000-100000000001', 'starter', 'trialing', now(), now() + interval '14 days'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '64000000-0000-4000-8000-000000000001', true);

INSERT INTO member_results
SELECT 'directory_is_scoped_to_active_workspace', count(*) = 1,
  format('rows=%s', count(*))
FROM public.rpc_my_organization_members();

SELECT public.rpc_add_organization_member(
  '64000000-0000-4000-8000-000000000002', 'sale'
);
INSERT INTO member_results
SELECT 'owner_can_add_active_member', role = 'sale' AND status = 'active',
  format('role=%s status=%s', role, status)
FROM public.rpc_my_organization_members()
WHERE auth_user_id = '64000000-0000-4000-8000-000000000002';

SELECT public.rpc_update_organization_member(
  '64000000-0000-4000-8000-000000000002', 'accounting', 'active', 'Member A Updated', 'ABS_NORTH'
);
INSERT INTO member_results
SELECT 'role_and_profile_are_updated_atomically',
  role = 'accounting' AND display_name = 'Member A Updated',
  format('role=%s display=%s', role, display_name)
FROM public.rpc_my_organization_members()
WHERE auth_user_id = '64000000-0000-4000-8000-000000000002';

SELECT public.rpc_update_organization_member(
  '64000000-0000-4000-8000-000000000002', 'accounting', 'suspended', NULL, NULL
);
INSERT INTO member_results
SELECT 'suspension_is_workspace_local', status = 'suspended' AND NOT is_default,
  format('status=%s default=%s', status, is_default)
FROM public.rpc_my_organization_members()
WHERE auth_user_id = '64000000-0000-4000-8000-000000000002';

SELECT public.rpc_add_organization_member(id, 'sale')
FROM (VALUES
  ('64000000-0000-4000-8000-000000000003'::uuid),
  ('64000000-0000-4000-8000-000000000004'::uuid),
  ('64000000-0000-4000-8000-000000000005'::uuid),
  ('64000000-0000-4000-8000-000000000006'::uuid)
) users(id);

DO $$
BEGIN
  BEGIN
    PERFORM public.rpc_add_organization_member(
      '64000000-0000-4000-8000-000000000007', 'sale'
    );
    INSERT INTO member_results VALUES ('starter_quota_blocks_sixth_active_member', false, 'unexpected success');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO member_results VALUES (
      'starter_quota_blocks_sixth_active_member',
      SQLERRM LIKE 'Workspace member limit reached%', SQLERRM
    );
  END;
END;
$$;

DO $$
BEGIN
  BEGIN
    PERFORM public.rpc_update_organization_member(
      '64000000-0000-4000-8000-000000000001', 'admin', 'active', NULL, NULL
    );
    INSERT INTO member_results VALUES ('owner_is_immutable', false, 'unexpected success');
  EXCEPTION WHEN OTHERS THEN
    INSERT INTO member_results VALUES ('owner_is_immutable', SQLERRM LIKE 'Workspace owner cannot%', SQLERRM);
  END;
END;
$$;

RESET ROLE;
DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM member_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Workspace member tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE member_results;
ROLLBACK;
