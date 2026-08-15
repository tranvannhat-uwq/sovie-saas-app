BEGIN;

-- rpc_confirm_order from 0006 uses local variables with names that also exist
-- as order columns (for example idempotency_key). PostgreSQL must explicitly
-- prefer the PL/pgSQL variables when those identifiers are otherwise
-- ambiguous. The function body and monetary formulas remain unchanged.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_confirm_order(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0011 stopped: rpc_confirm_order(jsonb) is missing';
  END IF;

  IF current_definition NOT LIKE '%#variable_conflict use_variable%' THEN
    IF (length(current_definition) - length(replace(current_definition, 'DECLARE', '')))
         / length('DECLARE') <> 1 THEN
      RAISE EXCEPTION 'Migration 0011 stopped: expected exactly one DECLARE in rpc_confirm_order';
    END IF;
    patched_definition := replace(
      current_definition,
      'DECLARE',
      E'#variable_conflict use_variable\nDECLARE'
    );
    IF patched_definition = current_definition THEN
      RAISE EXCEPTION 'Migration 0011 stopped: rpc_confirm_order declaration was not recognized';
    END IF;
    EXECUTE patched_definition;
  END IF;
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
      AND procedure.prosrc LIKE '%#variable_conflict use_variable%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0011 stopped: secured rpc_confirm_order patch was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0011', 'Resolve rpc_confirm_order variable and column name conflicts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
