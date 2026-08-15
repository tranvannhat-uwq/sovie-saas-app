BEGIN;

-- Admin and Accounting may finalize the explicit "retail" (manual-price)
-- workflow after confirming it in the UI. Sale behavior remains unchanged:
-- browser-supplied prices are never trusted for that role.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
  resolver_statement text;
  sku_resolver_statement text;
  standard_price_statement text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_confirm_order(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0048 stopped: rpc_confirm_order(jsonb) is missing';
  END IF;

  IF current_definition NOT LIKE '%manual_pricing boolean := false;%' THEN
    patched_definition := replace(
      current_definition,
      'item_index integer := 0;',
      E'item_index integer := 0;\n  manual_pricing boolean := false;'
    );
    IF patched_definition = current_definition THEN
      RAISE EXCEPTION 'Migration 0048 stopped: declaration anchor was not found';
    END IF;
    current_definition := patched_definition;

    patched_definition := replace(
      current_definition,
      'actor := public.require_authenticated_profile();',
      E'actor := public.require_authenticated_profile();\n\n'
        || E'  manual_pricing := NULLIF(p_order->>''pricelistId'', '''') = ''retail''\n'
        || E'    AND COALESCE(NULLIF(p_order->>''manualPriceConfirmed'', '''')::boolean, false);\n'
        || E'  IF manual_pricing AND actor.role NOT IN (''admin'', ''accounting'') THEN\n'
        || E'    RAISE EXCEPTION ''403: only Admin or Accounting may confirm manual order prices''\n'
        || E'      USING ERRCODE = ''42501'';\n'
        || E'  END IF;'
    );
    IF patched_definition = current_definition THEN
      RAISE EXCEPTION 'Migration 0048 stopped: authenticated actor anchor was not found';
    END IF;
    current_definition := patched_definition;

    -- Include the complete browser item payload only for the privileged manual
    -- workflow. This makes every entered price part of the idempotency hash
    -- without depending on the deployed request_items field layout.
    patched_definition := replace(
      current_definition,
      '''items'', request_items',
      '''manualItems'', CASE WHEN manual_pricing THEN p_order->''items'' ELSE NULL END, ''items'', request_items'
    );
    IF patched_definition = current_definition THEN
      RAISE EXCEPTION 'Migration 0048 stopped: request fingerprint items anchor was not found';
    END IF;
    current_definition := patched_definition;

    resolver_statement := substring(
      current_definition
      FROM 'selected_list_id[[:space:]]*:=[[:space:]]*public[.]p25_resolve_order_price_list[(][^;]+;'
    );
    IF resolver_statement IS NULL THEN
      RAISE EXCEPTION 'Migration 0048 stopped: price-list resolver anchor was not found';
    END IF;
    current_definition := replace(
      current_definition,
      resolver_statement,
      E'IF manual_pricing THEN\n'
        || E'    selected_list_id := ''retail'';\n'
        || E'  ELSE\n'
        || E'    ' || resolver_statement || E'\n'
        || E'  END IF;'
    );

    sku_resolver_statement := substring(
      current_definition
      FROM 'SELECT[[:space:]]+[*][[:space:]]+INTO[[:space:]]+STRICT[[:space:]]+resolved_price[[:space:]]+FROM[[:space:]]+public[.]p[0-9]+_resolve_sku_price[^ (]*[(][^;]+;'
    );
    IF sku_resolver_statement IS NULL THEN
      RAISE EXCEPTION 'Migration 0048 stopped: SKU price resolver anchor was not found';
    END IF;
    current_definition := replace(
      current_definition,
      sku_resolver_statement,
      E'IF NOT manual_pricing THEN\n'
        || E'      ' || sku_resolver_statement || E'\n'
        || E'    END IF;'
    );

    standard_price_statement := substring(
      current_definition
      FROM 'unit_price[[:space:]]*:=[[:space:]]*round[(]resolved_price[.]price[^;]*;'
    );
    IF standard_price_statement IS NULL THEN
      RAISE EXCEPTION 'Migration 0048 stopped: standard unit price calculation was not found';
    END IF;
    current_definition := replace(
      current_definition,
      standard_price_statement,
      E'IF manual_pricing THEN\n'
        || E'      unit_price := round(COALESCE(NULLIF(item->>''price'', '''')::numeric, NULLIF(item->>''unitPrice'', '''')::numeric));\n'
        || E'      IF unit_price IS NULL OR unit_price < 0 THEN\n'
        || E'        RAISE EXCEPTION ''Manual price for SKU % must be a non-negative number'', product_row.id;\n'
        || E'      END IF;\n'
        || E'    ELSE\n'
        || E'      ' || standard_price_statement || E'\n'
        || E'    END IF;'
    );

    current_definition := replace(
      current_definition,
      '''priceListId'', resolved_price.source_list_id,',
      '''priceListId'', CASE WHEN manual_pricing THEN NULL ELSE resolved_price.source_list_id END,'
    );
    current_definition := replace(
      current_definition,
      '''priceListNameSnapshot'', resolved_price.source_list_name,',
      '''priceListNameSnapshot'', CASE WHEN manual_pricing THEN ''Nhập tay có xác nhận'' ELSE resolved_price.source_list_name END,'
    );
    current_definition := replace(
      current_definition,
      '''priceSource'', resolved_price.source_type,',
      '''priceSource'', CASE WHEN manual_pricing THEN ''manual_override'' ELSE resolved_price.source_type END,'
    );
    current_definition := replace(
      current_definition,
      '''p1-v1'', customer_id, customer_name,',
      'CASE WHEN manual_pricing THEN ''manual-v1'' ELSE ''p1-v1'' END, customer_id, customer_name,'
    );
    current_definition := replace(
      current_definition,
      '''price_list_id'', selected_list_id, ''pricing_version'', ''p1-v1''),',
      '''price_list_id'', selected_list_id, ''pricing_version'', CASE WHEN manual_pricing THEN ''manual-v1'' ELSE ''p1-v1'' END),'
    );

    IF current_definition NOT LIKE '%manualItems%'
       OR current_definition NOT LIKE '%only Admin or Accounting may confirm manual order prices%'
       OR current_definition NOT LIKE '%CASE WHEN manual_pricing THEN ''manual_override''%'
       OR current_definition NOT LIKE '%manual-v1%' THEN
      RAISE EXCEPTION 'Migration 0048 stopped: manual pricing patch was not assembled';
    END IF;

    EXECUTE current_definition;
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
      AND procedure.prosrc LIKE '%manual_pricing boolean := false;%'
      AND procedure.prosrc LIKE '%actor.role NOT IN (''admin'', ''accounting'')%'
      AND procedure.prosrc LIKE '%manualItems%'
      AND procedure.prosrc LIKE '%manual_override%'
      AND procedure.prosrc LIKE '%manual-v1%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0048 stopped: privileged manual pricing was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0048', 'Allow confirmed manual order prices for Admin and Accounting')
ON CONFLICT (version) DO NOTHING;

COMMIT;
