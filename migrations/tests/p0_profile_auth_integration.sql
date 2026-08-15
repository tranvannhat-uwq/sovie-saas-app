-- Run only after 0001..0005 on an isolated Supabase staging database.
-- Fixtures and the temporary policy change are rolled back.
BEGIN;

CREATE TEMP TABLE p0_profile_test_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);
GRANT ALL ON TABLE pg_temp.p0_profile_test_results TO authenticated;

INSERT INTO auth.users(
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000011', 'authenticated', 'authenticated', 'p0-profile-admin@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000012', 'authenticated', 'authenticated', 'p0-profile-locked@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '00000000-0000-0000-0000-000000000013', 'authenticated', 'authenticated', 'p0-profile-missing@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

UPDATE public.profiles SET role = 'admin', is_active = true
WHERE auth_user_id = '00000000-0000-0000-0000-000000000011';
UPDATE public.profiles SET role = 'sale', is_active = false
WHERE auth_user_id = '00000000-0000-0000-0000-000000000012';
DELETE FROM public.profiles
WHERE auth_user_id = '00000000-0000-0000-0000-000000000013';
INSERT INTO public.profiles(id, auth_user_id, username, display_name, role, is_active)
VALUES ('p0-unlinked-legacy', NULL, 'p0-unlinked-legacy', 'P0 Unlinked', 'admin', true)
ON CONFLICT (id) DO NOTHING;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
INSERT INTO p0_profile_test_results
SELECT 'valid_admin_reads_exactly_one_own_profile', count(*) = 1, 'self-read RLS'
FROM public.profiles
WHERE auth_user_id = '00000000-0000-0000-0000-000000000011';
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
INSERT INTO p0_profile_test_results
SELECT 'locked_profile_is_visible_for_explicit_lock_message',
       count(*) = 1 AND bool_and(is_active = false),
       'self-read must not filter inactive profile'
FROM public.profiles
WHERE auth_user_id = '00000000-0000-0000-0000-000000000012';
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
INSERT INTO p0_profile_test_results
SELECT 'auth_user_without_profile_reports_missing',
       COALESCE((public.rpc_my_profile_link_status()->>'profile_exists')::boolean, true) = false,
       'link-status probe';
RESET ROLE;

INSERT INTO p0_profile_test_results VALUES (
  'unlinked_legacy_profile_never_matches_auth_user',
  (SELECT auth_user_id IS NULL FROM public.profiles WHERE id = 'p0-unlinked-legacy'),
  'no email/username auto-link during login'
);

DO $$
BEGIN
  BEGIN
    INSERT INTO public.profiles(id, auth_user_id, username, display_name, role, is_active)
    VALUES (
      'p0-duplicate-auth-link', '00000000-0000-0000-0000-000000000011',
      'p0-duplicate-auth-link', 'P0 Duplicate', 'sale', true
    );
    INSERT INTO p0_profile_test_results VALUES
      ('duplicate_auth_user_id_is_rejected', false, 'insert unexpectedly succeeded');
  EXCEPTION WHEN unique_violation THEN
    INSERT INTO p0_profile_test_results VALUES
      ('duplicate_auth_user_id_is_rejected', true, 'unique constraint');
  END;

  BEGIN
    INSERT INTO public.profiles(id, username, display_name, role, is_active)
    VALUES ('p0-invalid-role', 'p0-invalid-role', 'P0 Invalid', 'owner', true);
    INSERT INTO p0_profile_test_results VALUES
      ('invalid_role_is_rejected', false, 'insert unexpectedly succeeded');
  EXCEPTION WHEN check_violation THEN
    INSERT INTO p0_profile_test_results VALUES
      ('invalid_role_is_rejected', true, 'role check constraint');
  END;
END $$;

-- Prove the frontend can distinguish an RLS regression from a missing link:
-- direct SELECT becomes empty, while the caller-scoped boolean probe stays true.
DROP POLICY profiles_select ON public.profiles;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
INSERT INTO p0_profile_test_results
SELECT 'rls_denial_is_distinguishable_from_missing_profile',
       direct_rows = 0 AND link_exists = true,
       'direct RLS row count plus caller-scoped link probe'
FROM (
  SELECT
    (SELECT count(*) FROM public.profiles
      WHERE auth_user_id = '00000000-0000-0000-0000-000000000011') AS direct_rows,
    (public.rpc_my_profile_link_status()->>'profile_exists')::boolean AS link_exists
) result;
RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM p0_profile_test_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'P0 profile/Auth tests failed:\n%', failed;
  END IF;
END $$;

TABLE p0_profile_test_results;
ROLLBACK;
