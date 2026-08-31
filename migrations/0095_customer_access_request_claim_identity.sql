BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0094') THEN
    RAISE EXCEPTION 'Migration 0095 requires migration 0094';
  END IF;
END;
$prerequisite$;

-- Migration 0060 intentionally owns this helper with the non-login,
-- NOBYPASSRLS executor. Supabase's managed auth schema is not available to
-- that role, so resolve the same authenticated identity from the JWT request
-- claim instead of resolving identity through the protected Auth helper.
CREATE OR REPLACE FUNCTION public.can_access_customer(p_customer_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.is_admin_or_accounting()
    OR EXISTS (
      SELECT 1 FROM public.customers customer
      WHERE customer.id = p_customer_id
        AND (
          customer.managed_by = NULLIF(current_setting('request.jwt.claim.sub', true), '')
          OR lower(customer.managed_by) = lower(public.current_profile_username())
          OR split_part(lower(customer.managed_by), '@', 1) =
             split_part(lower(public.current_profile_username()), '@', 1)
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.customer_assignments assignment
      WHERE assignment.customer_id = p_customer_id
        AND assignment.is_active = true
        AND (assignment.assigned_to IS NULL OR assignment.assigned_to >= now())
        AND (
          assignment.employee_id = NULLIF(current_setting('request.jwt.claim.sub', true), '')
          OR lower(assignment.employee_id) = lower(public.current_profile_username())
          OR split_part(lower(assignment.employee_id), '@', 1) =
             split_part(lower(public.current_profile_username()), '@', 1)
        )
    )
$$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0095', 'Resolve Sale customer access from the authenticated request claim')
ON CONFLICT (version) DO NOTHING;

COMMIT;
