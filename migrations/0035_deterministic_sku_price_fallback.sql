BEGIN;

-- Global/general price lists are sibling business levels and must not inherit
-- from one another. A private/group/sales list may follow its explicit parent
-- chain and then fall back to the canonical "Bảng giá chung" list.
CREATE OR REPLACE FUNCTION public.p1_resolve_sku_price(
  p_price_list_id text,
  p_product_id text
) RETURNS TABLE(price numeric, source_list_id text, source_list_name text, source_type text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  current_list_id text := p_price_list_id;
  next_list_id text;
  canonical_list_id text;
  visited text[] := ARRAY[]::text[];
  fallback_used boolean := false;
  requested_is_global_general boolean := false;
  found_price numeric;
  found_name text;
  found_type text;
BEGIN
  SELECT COALESCE(list.price_list_type, list.type, 'general') = 'general'
      AND list.customer_id IS NULL
      AND list.customer_group_id IS NULL
  INTO requested_is_global_general
  FROM public.pricelists list
  WHERE list.id = p_price_list_id;

  SELECT list.id INTO canonical_list_id
  FROM public.pricelists list
  WHERE COALESCE(list.price_list_type, list.type, 'general') = 'general'
    AND list.customer_id IS NULL
    AND list.customer_group_id IS NULL
    AND public.p1_price_list_is_effective(list)
    AND public.can_use_price_list(list.id)
    AND (
      lower(btrim(COALESCE(list.name, ''))) IN (
        'bảng giá chung', 'bang gia chung', 'giá chung', 'gia chung'
      )
      OR upper(btrim(COALESCE(list.code, ''))) IN (
        'BANG_GIA_CHUNG', 'BG_CHUNG', 'GIA_CHUNG'
      )
    )
  ORDER BY list.display_order, list.id
  LIMIT 1;

  LOOP
    EXIT WHEN current_list_id IS NULL OR current_list_id = '' OR current_list_id = ANY(visited);
    visited := array_append(visited, current_list_id);

    SELECT item.price, list.name, COALESCE(list.price_list_type, list.type, 'general')
    INTO found_price, found_name, found_type
    FROM public.price_list_items item
    JOIN public.pricelists list ON list.id = item.price_list_id
    WHERE item.price_list_id = current_list_id
      AND (item.product_id = p_product_id OR item.variant_id = p_product_id)
      AND public.p1_price_list_is_effective(list)
      AND public.can_use_price_list(list.id)
    ORDER BY CASE WHEN item.variant_id = p_product_id THEN 0 ELSE 1 END, item.id
    LIMIT 1;

    IF found_price IS NOT NULL THEN
      RETURN QUERY SELECT round(found_price), current_list_id, found_name, found_type;
      RETURN;
    END IF;

    SELECT list.parent_price_list_id INTO next_list_id
    FROM public.pricelists list
    WHERE list.id = current_list_id;
    current_list_id := next_list_id;

    IF (current_list_id IS NULL OR current_list_id = '')
       AND NOT fallback_used
       AND NOT requested_is_global_general
       AND canonical_list_id IS NOT NULL
       AND NOT (canonical_list_id = ANY(visited)) THEN
      fallback_used := true;
      current_list_id := canonical_list_id;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'SKU % has no effective database price in price list %',
    p_product_id, p_price_list_id;
END;
$$;

ALTER FUNCTION public.p1_resolve_sku_price(text, text) SECURITY DEFINER;
ALTER FUNCTION public.p1_resolve_sku_price(text, text)
  SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.p1_resolve_sku_price(text, text)
  FROM PUBLIC, anon, authenticated;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'p1_resolve_sku_price'
      AND pg_get_function_identity_arguments(procedure.oid) =
          'p_price_list_id text, p_product_id text'
      AND procedure.prosrc LIKE '%requested_is_global_general%'
      AND procedure.prosrc LIKE '%canonical_list_id%'
      AND procedure.prosrc LIKE '%bảng giá chung%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0035 stopped: deterministic SKU fallback was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0035', 'Make SKU price fallback deterministic across browser and database')
ON CONFLICT (version) DO NOTHING;

COMMIT;
