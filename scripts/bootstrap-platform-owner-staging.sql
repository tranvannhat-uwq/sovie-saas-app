-- STAGING ONLY. Explicitly grants the SoVie platform owner role to the
-- existing test Auth account. Never infer this role from email or tenant role.
BEGIN;

DO $$
BEGIN
  IF current_database() IS NULL THEN
    RAISE EXCEPTION 'Database context required';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM auth.users
    WHERE id = '3b8bc3a2-fabf-477b-8276-6097183cc7d8'::uuid
      AND lower(email) = 'tranvnhat86@gmail.com'
  ) THEN
    RAISE EXCEPTION 'Expected staging Auth user was not found; platform role not granted';
  END IF;
END;
$$;

INSERT INTO public.platform_staff(auth_user_id, role, is_active, created_by)
VALUES (
  '3b8bc3a2-fabf-477b-8276-6097183cc7d8'::uuid,
  'platform_owner', true,
  '3b8bc3a2-fabf-477b-8276-6097183cc7d8'::uuid
)
ON CONFLICT (auth_user_id) DO UPDATE SET
  role = EXCLUDED.role,
  is_active = true,
  updated_at = now();

COMMIT;
