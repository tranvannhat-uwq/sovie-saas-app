BEGIN;

-- The browser and database clocks can differ by a few seconds. Compare the
-- selected Vietnam business day (the actual rule) and clamp a same-day future
-- timestamp to the database clock instead of rejecting today's order.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_confirm_order(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0042 stopped: rpc_confirm_order(jsonb) is missing';
  END IF;

  IF current_definition LIKE '%business_date AT TIME ZONE ''Asia/Bangkok''%' THEN
    RETURN;
  END IF;

  patched_definition := replace(
    current_definition,
    E'IF business_date > now() THEN\n      RAISE EXCEPTION ''Order date cannot be in the future'';\n    END IF;',
    E'IF (business_date AT TIME ZONE ''Asia/Bangkok'')::date\n         > (now() AT TIME ZONE ''Asia/Bangkok'')::date THEN\n      RAISE EXCEPTION ''Order date cannot be in the future'';\n    END IF;\n    IF business_date > now() THEN\n      business_date := now();\n    END IF;'
  );

  IF patched_definition = current_definition
     OR patched_definition NOT LIKE '%business_date AT TIME ZONE ''Asia/Bangkok''%'
     OR patched_definition NOT LIKE '%business_date := now();%' THEN
    RAISE EXCEPTION 'Migration 0042 stopped: business-date validation anchor was not patched';
  END IF;

  EXECUTE patched_definition;
END
$migration$;

ALTER FUNCTION public.rpc_confirm_order(jsonb) SECURITY DEFINER;
ALTER FUNCTION public.rpc_confirm_order(jsonb) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.rpc_confirm_order(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO authenticated;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'rpc_confirm_order'
      AND pg_get_function_identity_arguments(procedure.oid) = 'p_order jsonb'
      AND procedure.prosrc LIKE '%business_date AT TIME ZONE ''Asia/Bangkok''%'
      AND procedure.prosrc LIKE '%business_date := now();%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0042 stopped: business-date clock-skew patch was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0042', 'Validate order business day in Vietnam and tolerate same-day clock skew')
ON CONFLICT(version) DO NOTHING;

COMMIT;
