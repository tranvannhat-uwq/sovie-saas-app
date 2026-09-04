BEGIN;

-- A platform owner can grant or extend a paid term for up to ten years.
-- Reuse the existing definitions so this migration changes only the limit and
-- keeps every authorization and tenant-isolation check intact.
DO $$
DECLARE
  provision_definition text;
  lifecycle_definition text;
BEGIN
  SELECT pg_get_functiondef(
    'public.rpc_platform_provision_customer(uuid,text,text,text,integer,text,text)'::regprocedure
  ) INTO provision_definition;
  IF provision_definition IS NULL THEN
    RAISE EXCEPTION 'rpc_platform_provision_customer is required before extending the term limit';
  END IF;

  provision_definition := replace(provision_definition, 'p_trial_days > 60', 'p_trial_days > 3650');
  provision_definition := replace(provision_definition, 'Trial period must contain 1 to 60 days', 'Trial period must contain 1 to 3650 days');
  EXECUTE provision_definition;

  SELECT pg_get_functiondef(
    'public.rpc_platform_manage_customer(uuid,text,text,integer,text,text)'::regprocedure
  ) INTO lifecycle_definition;
  IF lifecycle_definition IS NULL THEN
    RAISE EXCEPTION 'rpc_platform_manage_customer is required before extending the term limit';
  END IF;

  lifecycle_definition := replace(lifecycle_definition, 'p_trial_days > 60', 'p_trial_days > 3650');
  lifecycle_definition := replace(lifecycle_definition, 'Trial extension must contain 1 to 60 days', 'Trial extension must contain 1 to 3650 days');
  EXECUTE lifecycle_definition;
END;
$$;

COMMIT;
