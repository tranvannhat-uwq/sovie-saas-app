-- MANUAL STAGING-ONLY bootstrap for Supabase SQL Editor.
-- Do not run on production. Back up/restore a staging project first.
-- Edit only the four values in p0_bootstrap_input below.
-- This script never creates an Auth user or a profile and never matches by guesswork.

BEGIN;

CREATE TEMP TABLE p0_bootstrap_input (
  environment_confirmation text NOT NULL,
  admin_email text NOT NULL,
  legacy_profile_key text NOT NULL,
  grant_admin_confirmation text NOT NULL
) ON COMMIT DROP;

INSERT INTO p0_bootstrap_input (
  environment_confirmation,
  admin_email,
  legacy_profile_key,
  grant_admin_confirmation
) VALUES (
  'STAGING_ONLY',
  'REPLACE_WITH_EXISTING_AUTH_EMAIL',
  'REPLACE_WITH_EXACT_PROFILE_ID_OR_USERNAME',
  'NO' -- Use I_UNDERSTAND_GRANT_ADMIN only after explicit authorization.
);

CREATE TEMP TABLE p0_bootstrap_result (
  auth_user_id uuid NOT NULL,
  profile_id text NOT NULL,
  rows_updated integer NOT NULL,
  admin_granted boolean NOT NULL,
  already_linked boolean NOT NULL,
  resulting_role text NOT NULL,
  resulting_is_active boolean NOT NULL
) ON COMMIT DROP;

DO $bootstrap$
DECLARE
  requested_environment text;
  requested_email text;
  requested_profile text;
  confirmation text;
  auth_count integer;
  profile_count integer;
  changed_count integer := 0;
  target_auth auth.users%ROWTYPE;
  target_profile public.profiles%ROWTYPE;
  final_profile public.profiles%ROWTYPE;
  grant_admin boolean;
  already_linked boolean;
BEGIN
  SELECT
    btrim(environment_confirmation),
    lower(btrim(admin_email)),
    btrim(legacy_profile_key),
    btrim(grant_admin_confirmation)
  INTO STRICT
    requested_environment,
    requested_email,
    requested_profile,
    confirmation
  FROM p0_bootstrap_input;

  IF requested_environment <> 'STAGING_ONLY' THEN
    RAISE EXCEPTION 'Bootstrap refused: environment_confirmation must equal STAGING_ONLY';
  END IF;
  IF requested_email IN ('', 'replace_with_existing_auth_email')
     OR requested_profile IN ('', 'REPLACE_WITH_EXACT_PROFILE_ID_OR_USERNAME') THEN
    RAISE EXCEPTION 'Bootstrap refused: replace the email and profile placeholders first';
  END IF;
  IF confirmation NOT IN ('NO', 'I_UNDERSTAND_GRANT_ADMIN') THEN
    RAISE EXCEPTION 'grant_admin_confirmation must be NO or I_UNDERSTAND_GRANT_ADMIN';
  END IF;
  grant_admin := confirmation = 'I_UNDERSTAND_GRANT_ADMIN';

  SELECT count(*) INTO auth_count
  FROM auth.users
  WHERE lower(btrim(email)) = requested_email;
  IF auth_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one existing Auth user for the supplied email; found %',
      auth_count;
  END IF;
  SELECT * INTO STRICT target_auth
  FROM auth.users
  WHERE lower(btrim(email)) = requested_email;

  SELECT count(*) INTO profile_count
  FROM public.profiles
  WHERE id = requested_profile
     OR lower(btrim(username)) = lower(requested_profile);
  IF profile_count <> 1 THEN
    RAISE EXCEPTION
      'Expected exactly one legacy profile for the supplied key; found %',
      profile_count;
  END IF;
  SELECT * INTO STRICT target_profile
  FROM public.profiles
  WHERE id = requested_profile
     OR lower(btrim(username)) = lower(requested_profile);

  IF target_profile.auth_user_id IS NOT NULL
     AND target_profile.auth_user_id <> target_auth.id THEN
    RAISE EXCEPTION 'Target profile is already linked to a different Auth user';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.profiles other_profile
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

  SELECT * INTO STRICT final_profile
  FROM public.profiles
  WHERE id = target_profile.id;

  IF changed_count = 1 THEN
    INSERT INTO public.audit_logs (
      table_name, action, record_id, old_data, new_data, performed_by, created_at
    ) VALUES (
      'profiles',
      'BOOTSTRAP_AUTH_LINK',
      target_profile.id,
      jsonb_build_object(
        'auth_user_id', target_profile.auth_user_id,
        'role', target_profile.role,
        'is_active', target_profile.is_active
      ),
      jsonb_build_object(
        'auth_user_id', final_profile.auth_user_id,
        'role', final_profile.role,
        'is_active', final_profile.is_active,
        'admin_granted_by_explicit_confirmation', grant_admin
      ),
      'staging-sql-editor-bootstrap:' || current_user,
      now()
    );
  END IF;

  INSERT INTO p0_bootstrap_result VALUES (
    target_auth.id,
    target_profile.id,
    changed_count,
    grant_admin,
    already_linked,
    final_profile.role,
    final_profile.is_active
  );
END
$bootstrap$;

SELECT * FROM p0_bootstrap_result;

COMMIT;
