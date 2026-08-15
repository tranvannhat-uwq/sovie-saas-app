BEGIN;

-- A trailing dot is an explicit operational marker for a 5% color surcharge.
-- Patch the authoritative confirmation RPC so the surcharge is derived from
-- colorCode instead of trusting browser-supplied prices or percentages.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_confirm_order(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0022 stopped: rpc_confirm_order(jsonb) is missing';
  END IF;

  IF current_definition LIKE '%color_markup_percent numeric;%' THEN
    RETURN;
  END IF;

  patched_definition := replace(
    current_definition,
    'unit_price numeric;',
    E'color_markup_percent numeric;\n  unit_price numeric;'
  );
  IF patched_definition = current_definition THEN
    RAISE EXCEPTION 'Migration 0022 stopped: unit price declaration anchor was not found';
  END IF;

  current_definition := patched_definition;
  patched_definition := replace(
    current_definition,
    'unit_price := round(resolved_price.price);',
    E'color_markup_percent := CASE\n'
      || E'      WHEN right(btrim(COALESCE(item->>''colorCode'', '''')), 1) = ''.'' THEN 5\n'
      || E'      ELSE 0\n'
      || E'    END;\n'
      || E'    unit_price := round(resolved_price.price * (1 + color_markup_percent / 100));'
  );
  IF patched_definition = current_definition THEN
    RAISE EXCEPTION 'Migration 0022 stopped: authoritative unit price anchor was not found';
  END IF;

  current_definition := patched_definition;
  patched_definition := replace(
    current_definition,
    '''colorPercent'', COALESCE((item->>''colorPercent'')::numeric, 0),',
    '''colorPercent'', CASE WHEN color_markup_percent > 0 THEN color_markup_percent ELSE COALESCE((item->>''colorPercent'')::numeric, 0) END,'
  );
  IF patched_definition = current_definition THEN
    RAISE EXCEPTION 'Migration 0022 stopped: color percent snapshot anchor was not found';
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
      AND procedure.prosrc LIKE '%color_markup_percent numeric;%'
      AND procedure.prosrc LIKE '%right(btrim(COALESCE(item->>''colorCode'', '''')), 1) = ''.''%'
      AND procedure.prosrc LIKE '%resolved_price.price * (1 + color_markup_percent / 100)%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0022 stopped: secured dot color surcharge patch was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0022', 'Apply an authoritative five-percent surcharge to color codes ending in a dot')
ON CONFLICT (version) DO NOTHING;

COMMIT;
