BEGIN;

-- A disabled-for-sales list remains hidden from general selection. Sales may
-- use it only for an in-scope customer whose saved profile already references
-- that exact list by id, code or legacy name.
CREATE OR REPLACE FUNCTION public.can_use_price_list_for_customer(
  p_customer_id text,
  p_price_list_id text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.can_use_price_list(NULLIF(p_price_list_id, ''))
    OR (
      public.current_profile_role() = 'sale'
      AND NULLIF(p_customer_id, '') IS NOT NULL
      AND public.can_access_customer(p_customer_id)
      AND EXISTS (
        SELECT 1
        FROM public.customers customer
        JOIN public.pricelists price_list ON price_list.id = p_price_list_id
        WHERE customer.id = p_customer_id
          AND COALESCE(customer.status, 'active') = 'active'
          AND customer.deleted_at IS NULL
          AND price_list.is_active = true
          AND (price_list.effective_from IS NULL OR price_list.effective_from <= CURRENT_DATE)
          AND (price_list.effective_to IS NULL OR price_list.effective_to >= CURRENT_DATE)
          AND EXISTS (
            SELECT 1
            FROM unnest(ARRAY[customer.pricelist_id, customer.default_price_list_id]) AS refs(assigned_reference)
            WHERE NULLIF(btrim(assigned_reference), '') IS NOT NULL
              AND lower(btrim(assigned_reference)) IN (
                lower(btrim(price_list.id)),
                lower(btrim(COALESCE(price_list.code, ''))),
                lower(btrim(price_list.name))
              )
          )
      )
    )
$$;

CREATE OR REPLACE FUNCTION public.can_use_any_customer_assigned_price_list(
  p_price_list_id text
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.can_use_price_list(NULLIF(p_price_list_id, ''))
    OR EXISTS (
      SELECT 1
      FROM public.customers customer
      JOIN public.pricelists price_list ON price_list.id = p_price_list_id
      WHERE COALESCE(customer.status, 'active') = 'active'
        AND customer.deleted_at IS NULL
        AND price_list.is_active = true
        AND EXISTS (
          SELECT 1
          FROM unnest(ARRAY[customer.pricelist_id, customer.default_price_list_id]) AS refs(assigned_reference)
          WHERE NULLIF(btrim(assigned_reference), '') IS NOT NULL
            AND lower(btrim(assigned_reference)) IN (
              lower(btrim(price_list.id)),
              lower(btrim(COALESCE(price_list.code, ''))),
              lower(btrim(price_list.name))
            )
        )
        AND public.can_access_customer(customer.id)
    )
$$;

CREATE INDEX IF NOT EXISTS customers_pricelist_reference_lower_idx
  ON public.customers ((lower(btrim(pricelist_id))))
  WHERE NULLIF(btrim(pricelist_id), '') IS NOT NULL;
CREATE INDEX IF NOT EXISTS customers_default_pricelist_reference_lower_idx
  ON public.customers ((lower(btrim(default_price_list_id))))
  WHERE NULLIF(btrim(default_price_list_id), '') IS NOT NULL;

CREATE OR REPLACE FUNCTION public.can_use_order_price_lists_for_customer(
  p_customer_id text,
  p_price_list_id text,
  p_items jsonb
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.can_use_price_list_for_customer(p_customer_id, NULLIF(p_price_list_id, ''))
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END
      ) item
      WHERE NOT public.can_use_price_list_for_customer(
        p_customer_id,
        COALESCE(NULLIF(item->>'priceListId', ''), NULLIF(item->>'price_list_id', ''))
      )
    )
$$;

REVOKE ALL ON FUNCTION public.can_use_price_list_for_customer(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_use_any_customer_assigned_price_list(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.can_use_order_price_lists_for_customer(text, text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_price_list_for_customer(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_any_customer_assigned_price_list(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_order_price_lists_for_customer(text, text, jsonb) TO authenticated;

DROP POLICY IF EXISTS pricelists_select ON public.pricelists;
CREATE POLICY pricelists_select ON public.pricelists FOR SELECT TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR public.can_use_price_list(id)
    OR public.can_use_any_customer_assigned_price_list(id)
  );

DROP POLICY IF EXISTS price_items_select ON public.price_list_items;
CREATE POLICY price_items_select ON public.price_list_items FOR SELECT TO authenticated
  USING (
    public.can_use_price_list(price_list_id)
    OR public.can_use_any_customer_assigned_price_list(price_list_id)
  );

CREATE OR REPLACE FUNCTION public.p1_resolve_order_price_list(
  p_customer_id text,
  p_requested_id text
) RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  customer_row public.customers%ROWTYPE;
  candidate text;
  resolved text;
BEGIN
  PERFORM public.require_authenticated_profile();

  IF p_customer_id IS NOT NULL AND p_customer_id <> '' THEN
    SELECT * INTO STRICT customer_row
    FROM public.customers
    WHERE id = p_customer_id
      AND COALESCE(status, 'active') = 'active'
      AND deleted_at IS NULL;

    FOREACH candidate IN ARRAY ARRAY[customer_row.pricelist_id, customer_row.default_price_list_id]
    LOOP
      IF candidate IS NOT NULL AND candidate <> '' THEN
        SELECT price_list.id INTO resolved
        FROM public.pricelists price_list
        WHERE (price_list.id = candidate OR price_list.code = candidate OR price_list.name = candidate)
          AND public.p1_price_list_is_effective(price_list)
          AND public.can_use_price_list_for_customer(customer_row.id, price_list.id)
        ORDER BY CASE WHEN price_list.id = candidate THEN 0 WHEN price_list.code = candidate THEN 1 ELSE 2 END,
                 price_list.display_order, price_list.id
        LIMIT 1;
        IF resolved IS NOT NULL THEN RETURN resolved; END IF;
      END IF;
    END LOOP;

    SELECT price_list.id INTO resolved
    FROM public.pricelists price_list
    WHERE price_list.customer_id = customer_row.id
      AND COALESCE(price_list.price_list_type, price_list.type, 'general')
          IN ('dealer_private', 'customer_specific', 'customer')
      AND public.p1_price_list_is_effective(price_list)
      AND public.can_use_price_list(price_list.id)
    ORDER BY price_list.display_order, price_list.id
    LIMIT 1;
    IF resolved IS NOT NULL THEN RETURN resolved; END IF;

    SELECT price_list.id INTO resolved
    FROM public.pricelists price_list
    WHERE customer_row.customer_group_id IS NOT NULL
      AND price_list.customer_group_id = customer_row.customer_group_id
      AND public.p1_price_list_is_effective(price_list)
      AND public.can_use_price_list(price_list.id)
    ORDER BY price_list.display_order, price_list.id
    LIMIT 1;
    IF resolved IS NOT NULL THEN RETURN resolved; END IF;
  END IF;

  IF p_requested_id IS NOT NULL AND p_requested_id NOT IN ('', 'retail') THEN
    IF NOT public.can_use_price_list(p_requested_id) THEN
      RAISE EXCEPTION '403: requested price list is not available to this user'
        USING ERRCODE = '42501';
    END IF;
    SELECT price_list.id INTO resolved
    FROM public.pricelists price_list
    WHERE price_list.id = p_requested_id
      AND public.p1_price_list_is_effective(price_list)
    LIMIT 1;
    IF resolved IS NULL THEN
      RAISE EXCEPTION 'Requested price list is inactive or outside its effective dates';
    END IF;
    RETURN resolved;
  END IF;

  SELECT price_list.id INTO resolved
  FROM public.pricelists price_list
  WHERE COALESCE(price_list.price_list_type, price_list.type, 'general') = 'general'
    AND price_list.customer_id IS NULL
    AND price_list.customer_group_id IS NULL
    AND public.p1_price_list_is_effective(price_list)
    AND public.can_use_price_list(price_list.id)
  ORDER BY price_list.display_order, price_list.id
  LIMIT 1;

  IF resolved IS NULL THEN
    RAISE EXCEPTION 'No active authorized price list is configured';
  END IF;
  RETURN resolved;
END;
$$;

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
DECLARE resolved text;
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
    AND public.can_use_price_list_for_customer(p_customer_id, price_list.id)
  LIMIT 1;

  IF resolved IS NULL THEN
    RAISE EXCEPTION '403: only an assigned or authorized global price list may override customer pricing'
      USING ERRCODE = '42501';
  END IF;
  RETURN resolved;
END;
$$;

REVOKE ALL ON FUNCTION public.p25_resolve_order_price_list(text, text, boolean)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.p40_resolve_sku_price_for_customer(
  p_price_list_id text,
  p_product_id text,
  p_customer_id text
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
      lower(btrim(COALESCE(list.name, ''))) IN ('bảng giá chung', 'bang gia chung', 'giá chung', 'gia chung')
      OR upper(btrim(COALESCE(list.code, ''))) IN ('BANG_GIA_CHUNG', 'BG_CHUNG', 'GIA_CHUNG')
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
      AND public.can_use_price_list_for_customer(p_customer_id, list.id)
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

REVOKE ALL ON FUNCTION public.p40_resolve_sku_price_for_customer(text, text, text)
  FROM PUBLIC, anon, authenticated;

DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_confirm_order(jsonb)'::regprocedure)
  INTO current_definition;

  -- Re-running 0040 is safe. A previous successful run already contains both
  -- customer-scoped anchors, so there is nothing left to replace.
  IF current_definition LIKE '%public.can_use_price_list_for_customer(customer_id, item->>''priceListId'')%'
     AND current_definition LIKE '%public.p40_resolve_sku_price_for_customer(selected_list_id, product_row.id, customer_id)%' THEN
    RETURN;
  END IF;

  patched_definition := replace(
    current_definition,
    'NOT public.can_use_price_list(item->>''priceListId'')',
    'NOT public.can_use_price_list_for_customer(customer_id, item->>''priceListId'')'
  );
  patched_definition := replace(
    patched_definition,
    'FROM public.p1_resolve_sku_price(selected_list_id, product_row.id)',
    'FROM public.p40_resolve_sku_price_for_customer(selected_list_id, product_row.id, customer_id)'
  );

  IF patched_definition NOT LIKE '%public.can_use_price_list_for_customer(customer_id, item->>''priceListId'')%'
     OR patched_definition NOT LIKE '%public.p40_resolve_sku_price_for_customer(selected_list_id, product_row.id, customer_id)%' THEN
    RAISE EXCEPTION 'Migration 0040 stopped: this rpc_confirm_order version has unsupported pricing anchors';
  END IF;
  EXECUTE patched_definition;
END
$migration$;

ALTER FUNCTION public.rpc_confirm_order(jsonb) SECURITY DEFINER;
ALTER FUNCTION public.rpc_confirm_order(jsonb) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.rpc_confirm_order(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO authenticated;

DROP POLICY IF EXISTS orders_select ON public.orders;
CREATE POLICY orders_select ON public.orders FOR SELECT TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR (
      public.can_use_order_price_lists_for_customer(customer_id, pricelist_id, items)
      AND (
        created_by = auth.uid()::text
        OR salesperson_id = auth.uid()::text
        OR lower(salesperson_id) = lower(public.current_profile_username())
        OR (customer_id IS NOT NULL AND public.can_access_customer(customer_id))
      )
    )
  );

DROP POLICY IF EXISTS drafts_select ON public.draft_orders;
CREATE POLICY drafts_select ON public.draft_orders FOR SELECT TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR (
      public.can_use_order_price_lists_for_customer(customer_id, pricelist_id, items)
      AND (
        created_by = auth.uid()::text
        OR lower(created_by) = lower(public.current_profile_username())
      )
    )
  );

DROP POLICY IF EXISTS drafts_insert ON public.draft_orders;
CREATE POLICY drafts_insert ON public.draft_orders FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin_or_accounting()
    OR (
      (created_by = auth.uid()::text OR lower(created_by) = lower(public.current_profile_username()))
      AND (customer_id IS NULL OR public.can_access_customer(customer_id))
      AND public.can_use_order_price_lists_for_customer(customer_id, pricelist_id, items)
    )
  );

DROP POLICY IF EXISTS drafts_update ON public.draft_orders;
CREATE POLICY drafts_update ON public.draft_orders FOR UPDATE TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR created_by = auth.uid()::text
    OR lower(created_by) = lower(public.current_profile_username())
  )
  WITH CHECK (
    public.is_admin_or_accounting()
    OR (
      (created_by = auth.uid()::text OR lower(created_by) = lower(public.current_profile_username()))
      AND (customer_id IS NULL OR public.can_access_customer(customer_id))
      AND public.can_use_order_price_lists_for_customer(customer_id, pricelist_id, items)
    )
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'rpc_confirm_order'
      AND procedure.prosrc LIKE '%can_use_price_list_for_customer(customer_id%'
      AND procedure.prosrc LIKE '%p40_resolve_sku_price_for_customer(selected_list_id%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0040 stopped: rpc_confirm_order verification failed';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0040', 'Allow a Sale to use a disabled price list only for its pre-assigned customer')
ON CONFLICT(version) DO NOTHING;

COMMIT;
