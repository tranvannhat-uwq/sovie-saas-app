-- STAGING ONLY. Run after inviting tvnhat10083@gmail.com in Supabase Auth.
-- The new platform owner must remain outside every customer organization.
BEGIN;

DO $$
DECLARE
  new_owner_id uuid;
  old_owner_id uuid := '3b8bc3a2-fabf-477b-8276-6097183cc7d8'::uuid;
BEGIN
  SELECT id INTO new_owner_id
  FROM auth.users
  WHERE lower(email) = 'tvnhat10083@gmail.com';

  IF new_owner_id IS NULL THEN
    RAISE EXCEPTION 'Invite tvnhat10083@gmail.com in Supabase Auth before transferring platform ownership';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = old_owner_id AND lower(email) = 'tranvnhat86@gmail.com'
  ) THEN
    RAISE EXCEPTION 'Expected staging tenant owner was not found; no role was changed';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.organization_memberships
    WHERE auth_user_id = new_owner_id
  ) THEN
    RAISE EXCEPTION 'New platform owner already belongs to a customer organization; no role was changed';
  END IF;

  INSERT INTO public.platform_staff(auth_user_id, role, is_active, created_by)
  VALUES (new_owner_id, 'platform_owner', true, old_owner_id)
  ON CONFLICT (auth_user_id) DO UPDATE SET
    role = EXCLUDED.role,
    is_active = true,
    updated_at = now();

  DELETE FROM public.platform_staff
  WHERE auth_user_id = old_owner_id;

  IF NOT EXISTS (
    SELECT 1 FROM public.platform_staff
    WHERE auth_user_id = new_owner_id
      AND role = 'platform_owner'
      AND is_active
  ) OR EXISTS (
    SELECT 1 FROM public.platform_staff
    WHERE auth_user_id = old_owner_id AND is_active
  ) THEN
    RAISE EXCEPTION 'Platform ownership verification failed; transaction rolled back';
  END IF;
END;
$$;

COMMIT;

SELECT
  auth_user.email,
  staff.role AS platform_role,
  staff.is_active,
  (SELECT count(*) FROM public.organization_memberships membership
   WHERE membership.auth_user_id = staff.auth_user_id) AS organization_memberships
FROM public.platform_staff staff
JOIN auth.users auth_user ON auth_user.id = staff.auth_user_id
WHERE lower(auth_user.email) IN ('tvnhat10083@gmail.com', 'tranvnhat86@gmail.com')
ORDER BY auth_user.email;
