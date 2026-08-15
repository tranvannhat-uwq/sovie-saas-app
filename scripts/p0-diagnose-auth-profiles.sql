-- Supabase SQL Editor-compatible, read-only staging diagnostic.
-- This file contains PostgreSQL SQL only (no psql commands such as \pset or \echo).
-- Prerequisite: public.profiles must already exist (run migrations 0001 -> 0005 first).

BEGIN TRANSACTION READ ONLY;

-- 1. Auth users and linked profiles
SELECT
  auth_user.id AS auth_user_id,
  auth_user.email,
  profile.id AS profile_id,
  profile.username,
  profile.role,
  profile.is_active,
  profile.created_at AS profile_created_at,
  profile.updated_at AS profile_updated_at
FROM auth.users auth_user
LEFT JOIN public.profiles profile ON profile.auth_user_id = auth_user.id
ORDER BY lower(auth_user.email), auth_user.id;

-- 2. Profiles without auth_user_id
SELECT id AS profile_id, username, role, is_active, created_at, updated_at
FROM public.profiles
WHERE auth_user_id IS NULL
ORDER BY lower(username), id;

-- 3. Auth users without a linked profile
SELECT auth_user.id AS auth_user_id, auth_user.email, auth_user.created_at
FROM auth.users auth_user
LEFT JOIN public.profiles profile ON profile.auth_user_id = auth_user.id
WHERE profile.id IS NULL
ORDER BY lower(auth_user.email), auth_user.id;

-- 4. Duplicate auth_user_id values
SELECT auth_user_id, count(*) AS profile_count, array_agg(id ORDER BY id) AS profile_ids
FROM public.profiles
WHERE auth_user_id IS NOT NULL
GROUP BY auth_user_id
HAVING count(*) > 1;

-- 5. Duplicate profile usernames (case-insensitive)
SELECT lower(btrim(username)) AS normalized_username,
       count(*) AS profile_count,
       array_agg(id ORDER BY id) AS profile_ids
FROM public.profiles
GROUP BY lower(btrim(username))
HAVING count(*) > 1;

-- 6. Duplicate Auth emails (case-insensitive)
SELECT lower(btrim(email)) AS normalized_email,
       count(*) AS auth_user_count,
       array_agg(id ORDER BY id) AS auth_user_ids
FROM auth.users
WHERE email IS NOT NULL
GROUP BY lower(btrim(email))
HAVING count(*) > 1;

-- 7. Profile usernames matching more than one Auth email
SELECT lower(btrim(profile.username)) AS normalized_identity,
       count(DISTINCT auth_user.id) AS auth_user_count,
       array_agg(DISTINCT auth_user.id) AS auth_user_ids,
       array_agg(DISTINCT profile.id) AS profile_ids
FROM public.profiles profile
JOIN auth.users auth_user
  ON lower(btrim(auth_user.email)) = lower(btrim(profile.username))
GROUP BY lower(btrim(profile.username))
HAVING count(DISTINCT auth_user.id) > 1 OR count(DISTINCT profile.id) > 1;

-- 8. Invalid roles
SELECT id AS profile_id, auth_user_id, username, role, is_active
FROM public.profiles
WHERE role IS NULL OR role NOT IN ('admin', 'accounting', 'sale')
ORDER BY id;

-- 9. Profile constraints and SELECT policies
SELECT constraint_record.conname,
       constraint_record.contype,
       pg_get_constraintdef(constraint_record.oid) AS definition,
       constraint_record.convalidated
FROM pg_constraint constraint_record
WHERE constraint_record.conrelid = 'public.profiles'::regclass
ORDER BY constraint_record.conname;

SELECT policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public' AND tablename = 'profiles'
ORDER BY policyname;

-- 10. Login linkage summary.
-- Kept as the final result set because Supabase SQL Editor normally displays
-- only the last SELECT result after running a multi-statement script.
SELECT
  'auth_user'::text AS record_type,
  auth_user.id AS auth_user_id,
  auth_user.email,
  profile.id AS profile_id,
  profile.username,
  profile.role,
  profile.is_active,
  CASE
    WHEN profile.id IS NULL THEN 'AUTH_USER_WITHOUT_PROFILE'
    WHEN profile.is_active IS NOT TRUE THEN 'PROFILE_LOCKED'
    WHEN profile.role IS NULL OR profile.role NOT IN ('admin', 'accounting', 'sale')
      THEN 'INVALID_ROLE'
    ELSE 'READY_TO_LOGIN'
  END AS login_status
FROM auth.users auth_user
LEFT JOIN public.profiles profile ON profile.auth_user_id = auth_user.id

UNION ALL

SELECT
  'unlinked_profile'::text AS record_type,
  NULL::uuid AS auth_user_id,
  NULL::text AS email,
  profile.id AS profile_id,
  profile.username,
  profile.role,
  profile.is_active,
  'PROFILE_WITHOUT_AUTH_USER'::text AS login_status
FROM public.profiles profile
WHERE profile.auth_user_id IS NULL
ORDER BY record_type, email NULLS LAST, username NULLS LAST;

ROLLBACK;
