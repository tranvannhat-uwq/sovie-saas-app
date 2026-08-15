BEGIN;

-- Installations that ran the first revision of 0015 have a local variable
-- named customer_id. PostgreSQL cannot decide whether the unqualified
-- customer_id in `sale.customer_id = customer_id` is that variable or a table
-- column. New 0015 installs use v_customer_id; this migration safely patches
-- the already-deployed legacy definition without changing financial formulas.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_import_customer_financial_baselines(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0016 stopped: customer baseline RPC is missing; apply 0015 first';
  END IF;

  IF current_definition LIKE '%v_customer_id text;%'
     AND current_definition LIKE '%sale.customer_id = v_customer_id%' THEN
    RETURN;
  END IF;

  IF current_definition NOT LIKE '%customer_id text;%'
     OR current_definition NOT LIKE '%sale.customer_id = customer_id%' THEN
    RAISE EXCEPTION 'Migration 0016 stopped: unrecognized customer baseline RPC definition';
  END IF;

  IF current_definition NOT LIKE '%#variable_conflict use_variable%' THEN
    IF (length(current_definition) - length(replace(current_definition, 'DECLARE', '')))
         / length('DECLARE') <> 1 THEN
      RAISE EXCEPTION 'Migration 0016 stopped: expected exactly one DECLARE in customer baseline RPC';
    END IF;
    patched_definition := replace(
      current_definition,
      'DECLARE',
      E'#variable_conflict use_variable\nDECLARE'
    );
    EXECUTE patched_definition;
  END IF;
END
$migration$;

ALTER FUNCTION public.rpc_import_customer_financial_baselines(jsonb) SECURITY DEFINER;
ALTER FUNCTION public.rpc_import_customer_financial_baselines(jsonb) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.rpc_import_customer_financial_baselines(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_import_customer_financial_baselines(jsonb) TO authenticated;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'rpc_import_customer_financial_baselines'
      AND pg_get_function_identity_arguments(procedure.oid) = 'p_rows jsonb'
      AND procedure.prosecdef
      AND (
        (procedure.prosrc LIKE '%v_customer_id text;%'
          AND procedure.prosrc LIKE '%sale.customer_id = v_customer_id%')
        OR procedure.prosrc LIKE '%#variable_conflict use_variable%'
      )
  ) THEN
    RAISE EXCEPTION 'Migration 0016 stopped: secured customer baseline RPC fix was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0016', 'Resolve customer baseline RPC customer_id variable conflict')
ON CONFLICT (version) DO NOTHING;

COMMIT;
