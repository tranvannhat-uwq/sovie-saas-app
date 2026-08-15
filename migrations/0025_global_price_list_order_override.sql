BEGIN;

-- A deliberate order override may use only a global/general price list. Dealer,
-- customer and group-specific lists continue to be resolved by the customer's
-- normal pricing rules.
CREATE OR REPLACE FUNCTION public.p25_resolve_order_price_list(
  p_customer_id text,
  p_requested_id text,
  p_override boolean DEFAULT false
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  resolved text;
BEGIN
  PERFORM public.require_authenticated_profile();

  IF NOT COALESCE(p_override, false) THEN
    RETURN public.p1_resolve_order_price_list(p_customer_id, p_requested_id);
  END IF;

  IF NULLIF(p_requested_id, '') IS NULL OR p_requested_id = 'retail' THEN
    RAISE EXCEPTION 'A global price list is required for an order price override';
  END IF;

  SELECT price_list.id INTO resolved
  FROM public.pricelists price_list
  WHERE price_list.id = p_requested_id
    AND COALESCE(price_list.price_list_type, price_list.type, 'general') = 'general'
    AND price_list.customer_id IS NULL
    AND price_list.customer_group_id IS NULL
    AND public.p1_price_list_is_effective(price_list)
    AND public.can_use_price_list(price_list.id)
  LIMIT 1;

  IF resolved IS NULL THEN
    RAISE EXCEPTION '403: only an active authorized global price list may override customer pricing'
      USING ERRCODE = '42501';
  END IF;

  RETURN resolved;
END
$$;

REVOKE ALL ON FUNCTION public.p25_resolve_order_price_list(text, text, boolean)
  FROM PUBLIC, anon, authenticated;

-- The business list named "Bảng giá chung" must be visible to sales users at
-- every agency. This narrowly updates global/general rows only.
UPDATE public.pricelists
SET is_available_for_sales = true,
    updated_at = now()
WHERE customer_id IS NULL
  AND customer_group_id IS NULL
  AND COALESCE(price_list_type, type, 'general') = 'general'
  AND (
    lower(btrim(name)) IN ('bảng giá chung', 'bang gia chung', 'giá chung', 'gia chung')
    OR upper(btrim(COALESCE(code, ''))) IN ('BANG_GIA_CHUNG', 'BG_CHUNG', 'GIA_CHUNG')
  );

DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
  old_resolver text := 'selected_list_id := public.p1_resolve_order_price_list(customer_id, NULLIF(p_order->>''pricelistId'', ''''));';
  new_resolver text := E'selected_list_id := public.p25_resolve_order_price_list(\n'
    || E'    customer_id,\n'
    || E'    NULLIF(p_order->>''pricelistId'', ''''),\n'
    || E'    COALESCE(NULLIF(p_order->>''priceListOverride'', '''')::boolean, false)\n'
    || E'  );';
  fingerprint_anchor text := '''requestedPriceListId'', NULLIF(p_order->>''pricelistId'', ''''),';
BEGIN
  SELECT pg_get_functiondef('public.rpc_confirm_order(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0025 stopped: rpc_confirm_order(jsonb) is missing';
  END IF;

  IF current_definition NOT LIKE '%public.p25_resolve_order_price_list(%' THEN
    patched_definition := replace(current_definition, old_resolver, new_resolver);
    IF patched_definition = current_definition THEN
      RAISE EXCEPTION 'Migration 0025 stopped: authoritative price-list resolver anchor was not found';
    END IF;
    current_definition := patched_definition;
  END IF;

  IF current_definition NOT LIKE '%''priceListOverride'', COALESCE(p_order->>''priceListOverride'', ''false'')%' THEN
    patched_definition := replace(
      current_definition,
      fingerprint_anchor,
      fingerprint_anchor || E'\n    ''priceListOverride'', COALESCE(p_order->>''priceListOverride'', ''false''),'
    );
    IF patched_definition = current_definition THEN
      RAISE EXCEPTION 'Migration 0025 stopped: request fingerprint anchor was not found';
    END IF;
    current_definition := patched_definition;
  END IF;

  IF current_definition NOT LIKE '%public.p25_resolve_order_price_list(%'
     OR current_definition NOT LIKE '%''priceListOverride'', COALESCE(p_order->>''priceListOverride'', ''false'')%' THEN
    RAISE EXCEPTION 'Migration 0025 stopped: global price-list override was not assembled';
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
      AND procedure.prosrc LIKE '%public.p25_resolve_order_price_list(%'
      AND procedure.prosrc LIKE '%''priceListOverride'', COALESCE(p_order->>''priceListOverride'', ''false'')%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0025 stopped: global price-list override patch was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0025', 'Allow explicit global price-list overrides on orders for every agency')
ON CONFLICT (version) DO NOTHING;

COMMIT;
