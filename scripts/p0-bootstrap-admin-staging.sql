-- Manual staging-only bootstrap.
-- Required psql variables:
--   -v environment_confirmation=STAGING_ONLY
--   -v admin_email=...
--   -v legacy_profile_key=...       (exact profile id or username)
--   -v grant_admin_confirmation=NO  (link only)
-- or:
--   -v grant_admin_confirmation=I_UNDERSTAND_GRANT_ADMIN
\set ON_ERROR_STOP on

BEGIN;

SELECT set_config('p0.environment_confirmation', :'environment_confirmation', true);
SELECT set_config('p0.admin_email', :'admin_email', true);
SELECT set_config('p0.legacy_profile_key', :'legacy_profile_key', true);
SELECT set_config('p0.grant_admin_confirmation', :'grant_admin_confirmation', true);

CREATE TEMP TABLE p0_bootstrap_result (
  auth_user_id uuid NOT NULL,
  profile_id text NOT NULL,
  rows_updated integer NOT NULL,
  admin_granted boolean NOT NULL,
  already_linked boolean NOT NULL
) ON COMMIT DROP;

DO $bootstrap$
DECLARE
  requested_email text := lower(btrim(current_setting('p0.admin_email')));
  requested_profile text := btrim(current_setting('p0.legacy_profile_key'));
  confirmation text := current_setting('p0.grant_admin_confirmation');
  auth_count integer;
  profile_count integer;
  changed_count integer := 0;
  target_auth auth.users%ROWTYPE;
  target_profile public.profiles%ROWTYPE;
  grant_admin boolean;
  already_linked boolean;
BEGIN
  IF current_setting('p0.environment_confirmation') <> 'STAGING_ONLY' THEN
    RAISE EXCEPTION 'Bootstrap refused: environment_confirmation must equal STAGING_ONLY';
  END IF;
  IF requested_email = '' OR requested_profile = '' THEN
    RAISE EXCEPTION 'admin_email and legacy_profile_key are required';
  END IF;
  IF confirmation NOT IN ('NO', 'I_UNDERSTAND_GRANT_ADMIN') THEN
    RAISE EXCEPTION 'grant_admin_confirmation must be NO or I_UNDERSTAND_GRANT_ADMIN';
  END IF;
  grant_admin := confirmation = 'I_UNDERSTAND_GRANT_ADMIN';

  SELECT count(*) INTO auth_count
  FROM auth.users WHERE lower(btrim(email)) = requested_email;
  IF auth_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one existing Auth user for the supplied email; found %', auth_count;
  END IF;
  SELECT * INTO STRICT target_auth
  FROM auth.users WHERE lower(btrim(email)) = requested_email;

  SELECT count(*) INTO profile_count
  FROM public.profiles
  WHERE id = requested_profile OR lower(btrim(username)) = lower(requested_profile);
  IF profile_count <> 1 THEN
    RAISE EXCEPTION 'Expected exactly one legacy profile for the supplied key; found %', profile_count;
  END IF;
  SELECT * INTO STRICT target_profile
  FROM public.profiles
  WHERE id = requested_profile OR lower(btrim(username)) = lower(requested_profile);

  IF target_profile.auth_user_id IS NOT NULL
     AND target_profile.auth_user_id <> target_auth.id THEN
    RAISE EXCEPTION 'Target profile is already linked to a different Auth user';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.profiles other_profile
    WHERE other_profile.auth_user_id = target_auth.id
      AND other_profile.id <> target_profile.id
  ) THEN
    RAISE EXCEPTION 'Auth user is already linked to a different profile';
  END IF;

  already_linked := COALESCE(target_profile.auth_user_id = target_auth.id, false);
  UPDATE public.profiles
  SET auth_user_id = target_auth.id,
      role = CASE WHEN grant_admin THEN 'admin' ELSE role END,
      is_active = CASE WHEN grant_admin THEN true ELSE is_active END,
      updated_at = now()
  WHERE id = target_profile.id
    AND (
      auth_user_id IS DISTINCT FROM target_auth.id
      OR (grant_admin AND role <> 'admin')
      OR (grant_admin AND is_active IS DISTINCT FROM true)
    );
  GET DIAGNOSTICS changed_count = ROW_COUNT;
  IF changed_count NOT IN (0, 1) THEN
    RAISE EXCEPTION 'Bootstrap changed an unexpected number of profiles: %', changed_count;
  END IF;

  IF changed_count = 1 THEN
    INSERT INTO public.audit_logs(
      table_name, action, record_id, old_data, new_data, performed_by, created_at
    ) VALUES (
      'profiles', 'BOOTSTRAP_AUTH_LINK', target_profile.id,
      jsonb_build_object(
        'auth_user_id', target_profile.auth_user_id,
        'role', target_profile.role,
        'is_active', target_profile.is_active
      ),
      jsonb_build_object(
        'auth_user_id', target_auth.id,
        'role', CASE WHEN grant_admin THEN 'admin' ELSE target_profile.role END,
        'is_active', CASE WHEN grant_admin THEN true ELSE target_profile.is_active END,
        'admin_granted_by_explicit_confirmation', grant_admin
      ),
      'staging-bootstrap:' || current_user,
      now()
    );
  END IF;

  INSERT INTO p0_bootstrap_result
  VALUES (target_auth.id, target_profile.id, changed_count, grant_admin, already_linked);
END
$bootstrap$;

TABLE p0_bootstrap_result;

COMMIT;
