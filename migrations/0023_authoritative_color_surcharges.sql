BEGIN;

-- Keep the existing invoice color rules authoritative when an order is first
-- confirmed or amended. The browser may preview these values, but the database
-- derives them again from colorCode before calculating any monetary fields.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
  old_rule text := E'color_markup_percent := CASE\n'
    || E'      WHEN right(btrim(COALESCE(item->>''colorCode'', '''')), 1) = ''.'' THEN 5\n'
    || E'      ELSE 0\n'
    || E'    END;';
  new_rule text := E'color_markup_percent := CASE\n'
    || E'      WHEN right(btrim(COALESCE(item->>''colorCode'', '''')), 1) = ''.'' THEN 5\n'
    || E'      WHEN upper(right(btrim(COALESCE(item->>''colorCode'', '''')), 1)) = ''T'' THEN 15\n'
    || E'      WHEN upper(right(btrim(COALESCE(item->>''colorCode'', '''')), 1)) = ''D'' THEN 20\n'
    || E'      WHEN upper(right(btrim(COALESCE(item->>''colorCode'', '''')), 1)) = ''A'' THEN 25\n'
    || E'      ELSE 0\n'
    || E'    END;';
BEGIN
  SELECT pg_get_functiondef('public.rpc_confirm_order(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0023 stopped: rpc_confirm_order(jsonb) is missing';
  END IF;

  IF current_definition LIKE '%THEN 15%THEN 20%THEN 25%'
     AND current_definition LIKE '%''colorPercent'', color_markup_percent%' THEN
    RETURN;
  END IF;

  -- Support installations where 0022 has not been deployed yet. In that case
  -- add the server-side percentage variable before installing the full rule.
  IF current_definition NOT LIKE '%color_markup_percent numeric;%' THEN
    patched_definition := replace(
      current_definition,
      'unit_price numeric;',
      E'color_markup_percent numeric;\n  unit_price numeric;'
    );
    IF patched_definition = current_definition THEN
      RAISE EXCEPTION 'Migration 0023 stopped: unit price declaration anchor was not found';
    END IF;
    current_definition := patched_definition;
  END IF;

  IF current_definition LIKE '%' || old_rule || '%' THEN
    -- Upgrade the dot-only rule installed by 0022.
    patched_definition := replace(current_definition, old_rule, new_rule);
    current_definition := patched_definition;
  ELSIF current_definition NOT LIKE '%color_markup_percent := CASE%' THEN
    -- Install the complete rule directly on databases still using the original
    -- authoritative price calculation from migration 0006.
    patched_definition := replace(
      current_definition,
      'unit_price := round(resolved_price.price);',
      new_rule || E'\n    unit_price := round(resolved_price.price * (1 + color_markup_percent / 100));'
    );
    IF patched_definition = current_definition THEN
      RAISE EXCEPTION 'Migration 0023 stopped: authoritative unit price anchor was not found';
    END IF;
    current_definition := patched_definition;
  END IF;

  IF current_definition LIKE '%''colorPercent'', CASE WHEN color_markup_percent > 0%' THEN
    patched_definition := replace(
      current_definition,
      '''colorPercent'', CASE WHEN color_markup_percent > 0 THEN color_markup_percent ELSE COALESCE((item->>''colorPercent'')::numeric, 0) END,',
      '''colorPercent'', color_markup_percent,'
    );
    current_definition := patched_definition;
  ELSIF current_definition LIKE '%''colorPercent'', COALESCE((item->>''colorPercent'')::numeric, 0),%' THEN
    patched_definition := replace(
      current_definition,
      '''colorPercent'', COALESCE((item->>''colorPercent'')::numeric, 0),',
      '''colorPercent'', color_markup_percent,'
    );
    current_definition := patched_definition;
  END IF;

  IF current_definition NOT LIKE '%THEN 15%THEN 20%THEN 25%'
     OR current_definition NOT LIKE '%''colorPercent'', color_markup_percent%'
     OR current_definition NOT LIKE '%resolved_price.price * (1 + color_markup_percent / 100)%' THEN
    RAISE EXCEPTION 'Migration 0023 stopped: complete color pricing rule was not assembled';
  END IF;

  EXECUTE current_definition;
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
      AND procedure.prosrc LIKE '%THEN 5%'
      AND procedure.prosrc LIKE '%THEN 15%'
      AND procedure.prosrc LIKE '%THEN 20%'
      AND procedure.prosrc LIKE '%THEN 25%'
      AND procedure.prosrc LIKE '%''colorPercent'', color_markup_percent%'
      AND procedure.prosrc LIKE '%resolved_price.price * (1 + color_markup_percent / 100)%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0023 stopped: authoritative color surcharge patch was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0023', 'Preserve all color surcharges when confirming or amending orders')
ON CONFLICT (version) DO NOTHING;

COMMIT;
