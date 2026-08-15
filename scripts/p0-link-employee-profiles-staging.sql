-- MANUAL STAGING-ONLY link for existing employee Auth users and legacy profiles.
-- Run in Supabase SQL Editor as the database owner after reviewing the preview.
-- This script NEVER creates users, changes passwords, changes roles, activates
-- profiles, or links an admin profile. It only links unique exact email matches
-- for existing accounting/sale profiles.

BEGIN;

CREATE TEMP TABLE p0_employee_link_input (
  environment_confirmation text NOT NULL,
  link_confirmation text NOT NULL
) ON COMMIT DROP;

INSERT INTO p0_employee_link_input VALUES (
  'STAGING_ONLY',
  'LINK_UNIQUE_NON_ADMIN_EMAIL_MATCHES' -- Apply the reviewed unique employee links.
);

CREATE TEMP TABLE p0_employee_link_candidates ON COMMIT DROP AS
SELECT
  auth_user.id AS auth_user_id,
  lower(btrim(auth_user.email)) AS auth_email,
  profile.id AS profile_id,
  profile.username,
  profile.display_name,
  profile.role,
  profile.is_active
FROM auth.users auth_user
JOIN public.profiles profile
  ON lower(btrim(profile.username)) = lower(btrim(auth_user.email))
WHERE auth_user.email IS NOT NULL
  AND profile.auth_user_id IS NULL
  AND profile.role IN ('accounting', 'sale')
  AND (
    SELECT count(*) FROM auth.users same_auth
    WHERE lower(btrim(same_auth.email)) = lower(btrim(auth_user.email))
  ) = 1
  AND (
    SELECT count(*) FROM public.profiles same_profile
    WHERE lower(btrim(same_profile.username)) = lower(btrim(profile.username))
  ) = 1
  AND NOT EXISTS (
    SELECT 1 FROM public.profiles linked_profile
    WHERE linked_profile.auth_user_id = auth_user.id
  );

-- First result set is the complete preview. No password or secret is shown.
SELECT
  auth_email,
  profile_id,
  username,
  display_name,
  role,
  is_active,
  'READY_TO_LINK' AS link_status
FROM p0_employee_link_candidates
ORDER BY role, auth_email;

DO $link$
DECLARE
  requested_environment text;
  requested_confirmation text;
  candidate_count integer;
  changed_count integer;
BEGIN
  SELECT btrim(environment_confirmation), btrim(link_confirmation)
  INTO STRICT requested_environment, requested_confirmation
  FROM p0_employee_link_input;

  IF requested_environment <> 'STAGING_ONLY' THEN
    RAISE EXCEPTION 'Employee linking refused: environment must equal STAGING_ONLY';
  END IF;

  IF requested_confirmation = 'PREVIEW_ONLY' THEN
    RAISE NOTICE 'Preview only: no profile was changed';
    RETURN;
  END IF;

  IF requested_confirmation <> 'LINK_UNIQUE_NON_ADMIN_EMAIL_MATCHES' THEN
    RAISE EXCEPTION 'Employee linking refused: invalid explicit confirmation';
  END IF;

  IF EXISTS (
    SELECT 1 FROM p0_employee_link_candidates WHERE role = 'admin'
  ) THEN
    RAISE EXCEPTION 'Employee linking refused: admin candidate detected';
  END IF;

  SELECT count(*) INTO candidate_count FROM p0_employee_link_candidates;

  UPDATE public.profiles profile
  SET auth_user_id = candidate.auth_user_id,
      updated_at = now()
  FROM p0_employee_link_candidates candidate
  WHERE profile.id = candidate.profile_id
    AND profile.auth_user_id IS NULL
    AND profile.role IN ('accounting', 'sale');
  GET DIAGNOSTICS changed_count = ROW_COUNT;

  IF changed_count <> candidate_count THEN
    RAISE EXCEPTION
      'Employee linking rolled back: expected % updates but changed %',
      candidate_count,
      changed_count;
  END IF;

  INSERT INTO public.audit_logs (
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  )
  SELECT
    'profiles',
    'BOOTSTRAP_EMPLOYEE_AUTH_LINK',
    candidate.profile_id,
    jsonb_build_object(
      'auth_user_id', NULL,
      'role', candidate.role,
      'is_active', candidate.is_active
    ),
    jsonb_build_object(
      'auth_user_id', candidate.auth_user_id,
      'role', candidate.role,
      'is_active', candidate.is_active,
      'matched_by', 'unique_exact_normalized_email'
    ),
    'staging-employee-link:' || current_user,
    now()
  FROM p0_employee_link_candidates candidate;

  RAISE NOTICE 'Employee profile links updated: %', changed_count;
END
$link$;

SELECT
  candidate.auth_email,
  candidate.profile_id,
  profile.auth_user_id,
  profile.role,
  profile.is_active,
  CASE
    WHEN profile.auth_user_id = candidate.auth_user_id THEN 'LINKED'
    ELSE 'PREVIEW_NOT_APPLIED'
  END AS result
FROM p0_employee_link_candidates candidate
JOIN public.profiles profile ON profile.id = candidate.profile_id
ORDER BY profile.role, candidate.auth_email;

COMMIT;
