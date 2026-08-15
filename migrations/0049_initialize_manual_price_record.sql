BEGIN;

-- Migration 0048 deliberately skips the database price-list lookup for a
-- privileged, confirmed manual-price order. A PL/pgSQL record must still be
-- initialized before any of its fields can appear in the canonical item CASE
-- expressions, even when the manual branch selects the other CASE value.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
  old_guard text := 'IF NOT manual_pricing THEN';
  new_guard text := E'IF manual_pricing THEN\n'
    || E'      SELECT NULL::numeric AS price,\n'
    || E'             NULL::text AS source_list_id,\n'
    || E'             NULL::text AS source_list_name,\n'
    || E'             NULL::text AS source_type\n'
    || E'      INTO resolved_price;\n'
    || E'    ELSE';
BEGIN
  SELECT pg_get_functiondef('public.rpc_confirm_order(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0049 stopped: rpc_confirm_order(jsonb) is missing';
  END IF;

  IF current_definition LIKE '%NULL::numeric AS price%INTO resolved_price;%' THEN
    RETURN;
  END IF;

  IF (length(current_definition) - length(replace(current_definition, old_guard, '')))
       / length(old_guard) <> 1 THEN
    RAISE EXCEPTION 'Migration 0049 stopped: expected one manual SKU resolver guard';
  END IF;

  patched_definition := replace(current_definition, old_guard, new_guard);
  IF patched_definition = current_definition
     OR patched_definition NOT LIKE '%IF manual_pricing THEN%NULL::numeric AS price%INTO resolved_price;%ELSE%p40_resolve_sku_price_for_customer%' THEN
    RAISE EXCEPTION 'Migration 0049 stopped: manual price record initialization was not assembled';
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
      AND procedure.prosrc LIKE '%NULL::numeric AS price%'
      AND procedure.prosrc LIKE '%NULL::text AS source_list_id%'
      AND procedure.prosrc LIKE '%INTO resolved_price;%'
      AND procedure.prosrc LIKE '%manual_override%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0049 stopped: initialized manual price record was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0049', 'Initialize the canonical source record for confirmed manual prices')
ON CONFLICT (version) DO NOTHING;

COMMIT;
