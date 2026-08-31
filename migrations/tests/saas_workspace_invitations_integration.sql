-- Run only on isolated Supabase staging after migration 0066.
BEGIN;

CREATE TEMP TABLE invitation_results (
  test_name text PRIMARY KEY, passed boolean NOT NULL, details text
);
GRANT ALL ON TABLE pg_temp.invitation_results TO authenticated;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT '00000000-0000-0000-0000-000000000000', identity.id,
  'authenticated', 'authenticated', identity.email, '', '{}'::jsonb, '{}'::jsonb, now(), now()
FROM (VALUES
  ('66000000-0000-4000-8000-000000000001'::uuid, 'invite-owner@test.invalid'),
  ('66000000-0000-4000-8000-000000000002'::uuid, 'invite-member@test.invalid'),
  ('66000000-0000-4000-8000-000000000003'::uuid, 'next-owner@test.invalid')
) identity(id, email);

INSERT INTO public.organizations (id, slug, name, status, created_by)
VALUES (
  '66000000-0000-4000-8000-100000000001', 'invitation-test',
  'Invitation Test', 'trialing', '66000000-0000-4000-8000-000000000001'
);
INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES (
  '66000000-0000-4000-8000-100000000001',
  '66000000-0000-4000-8000-000000000001', 'owner', 'active', true, now()
);
INSERT INTO public.organization_subscriptions (
  organization_id, plan_id, status, current_period_start, current_period_end
) VALUES (
  '66000000-0000-4000-8000-100000000001', 'starter', 'trialing', now(), now() + interval '14 days'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '66000000-0000-4000-8000-000000000001', true);

SELECT public.rpc_invite_organization_member(
  '66000000-0000-4000-8000-000000000002', 'accounting'
);
INSERT INTO invitation_results
SELECT 'owner_creates_pending_invitation', status = 'invited' AND role = 'accounting' AND joined_at IS NULL,
  format('status=%s role=%s', status, role)
FROM public.rpc_my_organization_members()
WHERE auth_user_id = '66000000-0000-4000-8000-000000000002';

SELECT set_config('request.jwt.claim.sub', '66000000-0000-4000-8000-000000000002', true);
INSERT INTO invitation_results
SELECT 'invited_user_has_no_active_workspace_before_acceptance',
  public.current_organization_id() IS NULL,
  format('active=%s', public.current_organization_id());

CREATE TEMP TABLE acceptance_payload AS
SELECT public.rpc_accept_my_organization_invitations() payload;
INSERT INTO invitation_results
SELECT 'login_accepts_invitation_and_selects_default',
  payload->>'acceptedCount' = '1'
    AND payload->>'defaultOrganizationId' = '66000000-0000-4000-8000-100000000001',
  format('payload=%s', payload)
FROM acceptance_payload;

INSERT INTO invitation_results
SELECT 'accepted_member_becomes_active', status = 'active' AND is_default AND joined_at IS NOT NULL,
  format('status=%s default=%s', status, is_default)
FROM public.rpc_my_organization_members()
WHERE auth_user_id = '66000000-0000-4000-8000-000000000002';

SELECT set_config('request.jwt.claim.sub', '66000000-0000-4000-8000-000000000001', true);
SELECT public.rpc_add_organization_member(
  '66000000-0000-4000-8000-000000000003', 'admin'
);
SELECT public.rpc_transfer_organization_ownership(
  '66000000-0000-4000-8000-000000000003'
);

INSERT INTO invitation_results
SELECT 'ownership_transfer_is_atomic_and_unique',
  count(*) FILTER (WHERE role = 'owner' AND status = 'active') = 1
    AND bool_or(auth_user_id = '66000000-0000-4000-8000-000000000003' AND role = 'owner')
    AND bool_or(auth_user_id = '66000000-0000-4000-8000-000000000001' AND role = 'admin'),
  format('members=%s', jsonb_agg(jsonb_build_object('auth', auth_user_id, 'role', role)))
FROM public.rpc_my_organization_members();

RESET ROLE;
DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM invitation_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Workspace invitation tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE invitation_results;
ROLLBACK;
