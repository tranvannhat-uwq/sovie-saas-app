BEGIN;

-- Phase 1: authoritative products/SKUs, price lists and order finalization.
-- This migration is additive. It neither reads nor mutates inventory/production data.

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS pricing_version text NOT NULL DEFAULT 'p1-v1';
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS orders_actor_idempotency_uidx
  ON public.orders(created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS price_list_items_variant_lookup_idx
  ON public.price_list_items(price_list_id, variant_id);
CREATE INDEX IF NOT EXISTS products_group_active_idx
  ON public.products(product_group_id, is_active);

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM public.price_list_items WHERE price < 0) THEN
    RAISE EXCEPTION 'Migration 0006 stopped: negative price_list_items.price must be reviewed first';
  END IF;
END
$migration$;

ALTER TABLE public.price_list_items
  DROP CONSTRAINT IF EXISTS price_list_items_price_nonnegative;
ALTER TABLE public.price_list_items
  ADD CONSTRAINT price_list_items_price_nonnegative CHECK (price >= 0) NOT VALID;
ALTER TABLE public.price_list_items
  VALIDATE CONSTRAINT price_list_items_price_nonnegative;

CREATE SEQUENCE IF NOT EXISTS public.order_display_seq;

CREATE OR REPLACE FUNCTION public.p1_price_list_is_effective(p_list public.pricelists)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT p_list.is_active
     AND (p_list.effective_from IS NULL OR p_list.effective_from <= CURRENT_DATE)
     AND (p_list.effective_to IS NULL OR p_list.effective_to >= CURRENT_DATE)
$$;

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

    FOREACH candidate IN ARRAY ARRAY[customer_row.default_price_list_id, customer_row.pricelist_id]
    LOOP
      IF candidate IS NOT NULL AND candidate <> '' THEN
        SELECT price_list.id INTO resolved
        FROM public.pricelists price_list
        WHERE (price_list.id = candidate OR price_list.code = candidate OR price_list.name = candidate)
          AND public.p1_price_list_is_effective(price_list)
          AND public.can_use_price_list(price_list.id)
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
  visited text[] := ARRAY[]::text[];
  fallback_used boolean := false;
  found_price numeric;
  found_name text;
  found_type text;
BEGIN
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

    SELECT parent_price_list_id INTO next_list_id
    FROM public.pricelists WHERE id = current_list_id;
    current_list_id := next_list_id;

    IF (current_list_id IS NULL OR current_list_id = '') AND NOT fallback_used THEN
      fallback_used := true;
      SELECT list.id INTO current_list_id
      FROM public.pricelists list
      WHERE COALESCE(list.price_list_type, list.type, 'general') = 'general'
        AND list.customer_id IS NULL
        AND list.customer_group_id IS NULL
        AND public.p1_price_list_is_effective(list)
        AND NOT (list.id = ANY(visited))
        AND public.can_use_price_list(list.id)
      ORDER BY list.display_order, list.id
      LIMIT 1;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'SKU % has no effective database price', p_product_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.p1_order_response(p_order_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'success', true,
    'order_id', sale.id,
    'order', jsonb_build_object(
      'id', sale.id,
      'idempotencyKey', sale.idempotency_key,
      'companyId', sale.company_id,
      'customerId', sale.customer_id,
      'customerName', sale.customer_name,
      'notes', sale.notes,
      'items', sale.items,
      'date', sale.order_date,
      'status', sale.status,
      'totalMarket', sale.total_market,
      'totalDiscount', sale.total_discount,
      'subtotal', sale.subtotal,
      'discountType', sale.discount_type,
      'discountValue', sale.discount_value,
      'discountAmount', sale.discount_amount,
      'otherFeeType', sale.other_fee_type,
      'otherFeeValue', sale.other_fee_value,
      'otherFeeAmount', sale.other_fee_amount,
      'shippingFeeValue', sale.shipping_fee_value,
      'shippingFeeAmount', sale.shipping_fee_amount,
      'totalPayable', sale.total_payable,
      'totalAmount', sale.total_amount,
      'paidAmount', sale.paid_amount,
      'amountDue', sale.debt_amount,
      'pricelistId', sale.pricelist_id,
      'createdBy', sale.created_by,
      'pricingVersion', sale.pricing_version
    ),
    'new_debt', CASE WHEN sale.customer_id IS NULL THEN NULL ELSE (
      SELECT ledger.balance_after
      FROM public.customer_debt_transactions ledger
      WHERE ledger.order_id = sale.id AND ledger.transaction_type = 'order'
      ORDER BY ledger.created_at DESC LIMIT 1
    ) END,
    'debt_change', sale.debt_amount,
    'performed_by', sale.created_by
  )
  FROM public.orders sale
  WHERE sale.id = p_order_id
$$;

CREATE OR REPLACE FUNCTION public.rpc_confirm_order(p_order jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  product_row public.products%ROWTYPE;
  item jsonb;
  canonical_item jsonb;
  canonical_items jsonb := '[]'::jsonb;
  request_items jsonb;
  request_basis jsonb;
  request_hash text;
  existing_order public.orders%ROWTYPE;
  selected_list_id text;
  resolved_price record;
  order_id text;
  draft_id text;
  idempotency_key text;
  customer_id text;
  customer_name text;
  quantity numeric;
  unit_price numeric;
  gross_line numeric;
  line_discount_type text;
  line_discount_value numeric;
  line_discount numeric;
  line_total numeric;
  total_market numeric := 0;
  subtotal numeric := 0;
  line_discounts numeric := 0;
  order_discount_type text;
  order_discount_value numeric;
  order_discount numeric;
  other_fee_type text;
  other_fee_value numeric;
  other_fee numeric;
  shipping_fee numeric;
  total_payable numeric;
  total_amount numeric;
  debt_amount numeric;
  balance_before numeric;
  balance_after numeric;
  item_index integer := 0;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting', 'sale') THEN
    RAISE EXCEPTION '403: role cannot create orders' USING ERRCODE = '42501';
  END IF;

  idempotency_key := NULLIF(btrim(p_order->>'idempotencyKey'), '');
  IF idempotency_key IS NULL OR idempotency_key !~
      '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$' THEN
    RAISE EXCEPTION 'A valid idempotencyKey UUID is required';
  END IF;

  customer_id := NULLIF(p_order->>'customerId', '');
  IF customer_id IS NOT NULL THEN
    IF actor.role = 'sale' AND NOT public.can_access_customer(customer_id) THEN
      RAISE EXCEPTION '403: customer is outside sale scope' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO STRICT customer_row
    FROM public.customers
    WHERE id = customer_id
      AND COALESCE(status, 'active') = 'active'
      AND deleted_at IS NULL
    FOR UPDATE;
    customer_name := customer_row.name;
  ELSE
    customer_name := NULLIF(btrim(p_order->>'customerName'), '');
    IF customer_name IS NULL THEN RAISE EXCEPTION 'Customer is required'; END IF;
  END IF;

  IF jsonb_typeof(p_order->'items') <> 'array' OR jsonb_array_length(p_order->'items') = 0 THEN
    RAISE EXCEPTION 'At least one order item is required';
  END IF;
  IF COALESCE((p_order->>'paidAmount')::numeric, 0) <> 0 THEN
    RAISE EXCEPTION 'Payments must be recorded by the Phase 2 payment transaction';
  END IF;

  request_items := (
    SELECT jsonb_agg(jsonb_build_object(
      'variantId', COALESCE(value->>'variantId', value->>'productId'),
      'quantity', value->>'quantity',
      'discountType', COALESCE(value->>'discountType', 'percent'),
      'discountValue', COALESCE(value->>'discountValue', value->>'discountPercent', '0'),
      'colorCode', COALESCE(value->>'colorCode', ''),
      'colorPercent', COALESCE(value->>'colorPercent', '0'),
      'notes', COALESCE(value->>'notes', '')
    ) ORDER BY ordinality)
    FROM jsonb_array_elements(p_order->'items') WITH ORDINALITY
  );
  request_basis := jsonb_build_object(
    'customerId', customer_id,
    'requestedPriceListId', NULLIF(p_order->>'pricelistId', ''),
    'discountType', COALESCE(p_order->>'discountType', 'amount'),
    'discountValue', COALESCE(p_order->>'discountValue', '0'),
    'otherFeeType', COALESCE(p_order->>'otherFeeType', 'amount'),
    'otherFeeValue', COALESCE(p_order->>'otherFeeValue', '0'),
    'shippingFee', COALESCE(p_order->>'shippingFeeValue', p_order->>'shippingFeeAmount', '0'),
    'notes', COALESCE(p_order->>'notes', ''),
    'items', request_items
  );
  request_hash := md5(request_basis::text);

  PERFORM pg_advisory_xact_lock(hashtextextended(actor.auth_user_id::text || ':' || idempotency_key, 0));
  SELECT * INTO existing_order
  FROM public.orders
  WHERE created_by = actor.auth_user_id::text
    AND orders.idempotency_key = idempotency_key;
  IF FOUND THEN
    IF existing_order.request_fingerprint <> request_hash THEN
      RAISE EXCEPTION '409: idempotency key was already used with a different payload'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.p1_order_response(existing_order.id) || jsonb_build_object('already_finalized', true);
  END IF;

  selected_list_id := public.p1_resolve_order_price_list(customer_id, NULLIF(p_order->>'pricelistId', ''));

  FOR item IN SELECT value FROM jsonb_array_elements(p_order->'items') LOOP
    item_index := item_index + 1;
    IF NULLIF(item->>'priceListId', '') IS NOT NULL
       AND NOT public.can_use_price_list(item->>'priceListId') THEN
      RAISE EXCEPTION '403: item price list is not available to this user'
        USING ERRCODE = '42501';
    END IF;
    SELECT * INTO STRICT product_row
    FROM public.products
    WHERE id = COALESCE(NULLIF(item->>'variantId', ''), NULLIF(item->>'productId', ''))
      AND is_active = true;

    quantity := (item->>'quantity')::numeric;
    IF quantity IS NULL OR quantity <= 0 THEN RAISE EXCEPTION 'SKU % quantity must be positive', product_row.id; END IF;

    SELECT * INTO STRICT resolved_price
    FROM public.p1_resolve_sku_price(selected_list_id, product_row.id);
    unit_price := round(resolved_price.price);
    gross_line := round(quantity * unit_price);
    line_discount_type := COALESCE(NULLIF(item->>'discountType', ''), 'percent');
    line_discount_value := COALESCE(NULLIF(item->>'discountValue', '')::numeric,
                                    NULLIF(item->>'discountPercent', '')::numeric, 0);
    IF line_discount_value < 0 OR line_discount_type NOT IN ('percent', 'amount') THEN
      RAISE EXCEPTION 'Invalid line discount for SKU %', product_row.id;
    END IF;
    IF line_discount_type = 'percent' THEN
      IF line_discount_value > 100 THEN RAISE EXCEPTION 'Line discount cannot exceed 100 percent'; END IF;
      line_discount := round(gross_line * line_discount_value / 100);
    ELSE
      line_discount := round(line_discount_value);
    END IF;
    IF line_discount > gross_line THEN RAISE EXCEPTION 'Line discount exceeds line value'; END IF;
    line_total := gross_line - line_discount;

    canonical_item := jsonb_build_object(
      'id', 'pending-' || item_index,
      'productId', product_row.id,
      'productGroupId', product_row.product_group_id,
      'variantId', product_row.id,
      'variantCode', COALESCE(product_row.variant_code, product_row.code),
      'baseCode', COALESCE(product_row.base_code, product_row.code),
      'productCode', COALESCE(product_row.variant_code, product_row.code),
      'productName', product_row.name,
      'brand', product_row.brand,
      'brandId', product_row.brand_id,
      'package', COALESCE(product_row.packaging_name, product_row.package_type, ''),
      'packagingName', COALESCE(product_row.packaging_name, product_row.package_type, ''),
      'weightOrVolume', COALESCE(product_row.weight_or_volume, product_row.package_weight),
      'unitName', COALESCE(product_row.unit_name, product_row.package_weight_unit, ''),
      'specificationSnapshot', COALESCE(product_row.display_specification, ''),
      'colorCode', COALESCE(item->>'colorCode', ''),
      'colorPercent', COALESCE((item->>'colorPercent')::numeric, 0),
      'quantity', quantity,
      'discountType', line_discount_type,
      'discountValue', line_discount_value,
      'discountPercent', CASE WHEN line_discount_type = 'percent' THEN line_discount_value ELSE 0 END,
      'discountAmount', line_discount,
      'price', unit_price,
      'unitPrice', unit_price,
      'listPrice', unit_price,
      'finalUnitPrice', round(line_total / quantity),
      'priceListId', resolved_price.source_list_id,
      'priceListNameSnapshot', resolved_price.source_list_name,
      'priceSource', resolved_price.source_type,
      'lineTotal', line_total,
      'notes', COALESCE(item->>'notes', '')
    );
    canonical_items := canonical_items || jsonb_build_array(canonical_item);
    total_market := total_market + gross_line;
    subtotal := subtotal + line_total;
    line_discounts := line_discounts + line_discount;
  END LOOP;

  order_discount_type := COALESCE(NULLIF(p_order->>'discountType', ''), 'amount');
  order_discount_value := COALESCE(NULLIF(p_order->>'discountValue', '')::numeric, 0);
  IF order_discount_value < 0 OR order_discount_type NOT IN ('percent', 'amount') THEN
    RAISE EXCEPTION 'Invalid order discount';
  END IF;
  IF order_discount_type = 'percent' THEN
    IF order_discount_value > 100 THEN RAISE EXCEPTION 'Order discount cannot exceed 100 percent'; END IF;
    order_discount := round(subtotal * order_discount_value / 100);
  ELSE
    order_discount := round(order_discount_value);
  END IF;
  IF order_discount > subtotal THEN RAISE EXCEPTION 'Order discount exceeds subtotal'; END IF;

  other_fee_type := COALESCE(NULLIF(p_order->>'otherFeeType', ''), 'amount');
  other_fee_value := COALESCE(NULLIF(p_order->>'otherFeeValue', '')::numeric, 0);
  IF other_fee_value < 0 OR other_fee_type NOT IN ('percent', 'amount') THEN RAISE EXCEPTION 'Invalid other fee'; END IF;
  IF other_fee_type = 'percent' THEN
    other_fee := round((subtotal - order_discount) * other_fee_value / 100);
  ELSE
    other_fee := round(other_fee_value);
  END IF;
  shipping_fee := round(COALESCE(NULLIF(p_order->>'shippingFeeValue', '')::numeric,
                                 NULLIF(p_order->>'shippingFeeAmount', '')::numeric, 0));
  IF shipping_fee < 0 THEN RAISE EXCEPTION 'Shipping fee cannot be negative'; END IF;

  total_payable := subtotal - order_discount + other_fee;
  total_amount := total_payable + shipping_fee;
  debt_amount := total_amount;
  LOOP
    order_id := 'HD-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
      lpad(nextval('public.order_display_seq')::text, 8, '0');
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.orders WHERE id = order_id);
  END LOOP;

  canonical_items := (
    SELECT jsonb_agg(value || jsonb_build_object('id', order_id || '-item-' || ordinality) ORDER BY ordinality)
    FROM jsonb_array_elements(canonical_items) WITH ORDINALITY
  );

  INSERT INTO public.orders (
    id, idempotency_key, request_fingerprint, pricing_version, customer_id, customer_name,
    notes, items, total_market, total_discount, subtotal, discount_value, discount_type,
    discount_amount, other_fee_value, other_fee_type, other_fee_amount, shipping_fee_value,
    shipping_fee_amount, total_payable, total_amount, paid_amount, debt_amount, net_revenue,
    pricelist_id, company_id, salesperson_id, customer_manager_id, created_by, updated_by,
    status, order_date, confirmed_at, created_at, updated_at
  ) VALUES (
    order_id, idempotency_key, request_hash, 'p1-v1', customer_id, customer_name,
    COALESCE(p_order->>'notes', ''), canonical_items, total_market, line_discounts + order_discount,
    subtotal, order_discount_value, order_discount_type, order_discount, other_fee_value,
    other_fee_type, other_fee, shipping_fee, shipping_fee, total_payable, total_amount, 0,
    debt_amount, total_payable, selected_list_id, actor.company_id, actor.auth_user_id::text,
    CASE WHEN customer_id IS NULL THEN NULL ELSE customer_row.managed_by END,
    actor.auth_user_id::text, actor.auth_user_id::text, 'settled', now(), now(), now(), now()
  );

  FOR canonical_item IN SELECT value FROM jsonb_array_elements(canonical_items) LOOP
    INSERT INTO public.order_items (
      id, order_id, product_id, product_group_id, variant_id, brand_id,
      product_code_snapshot, variant_code_snapshot, product_name_snapshot,
      packaging_name_snapshot, weight_or_volume_snapshot, specification_snapshot, unit_snapshot,
      price_list_id, price_list_name_snapshot, price_source, price_selected_by, quantity,
      list_price, unit_price, sale_price, final_unit_price, discount_percent, discount_amount,
      line_total, net_amount, created_at
    ) VALUES (
      canonical_item->>'id', order_id, canonical_item->>'productId',
      NULLIF(canonical_item->>'productGroupId', ''), canonical_item->>'variantId',
      NULLIF(canonical_item->>'brandId', ''), canonical_item->>'productCode',
      canonical_item->>'variantCode', canonical_item->>'productName',
      canonical_item->>'packagingName',
      concat_ws(' ', canonical_item->>'weightOrVolume', canonical_item->>'unitName'),
      canonical_item->>'specificationSnapshot', canonical_item->>'unitName',
      canonical_item->>'priceListId', canonical_item->>'priceListNameSnapshot',
      canonical_item->>'priceSource', actor.auth_user_id::text,
      (canonical_item->>'quantity')::numeric, (canonical_item->>'listPrice')::numeric,
      (canonical_item->>'unitPrice')::numeric, (canonical_item->>'finalUnitPrice')::numeric,
      (canonical_item->>'finalUnitPrice')::numeric, (canonical_item->>'discountPercent')::numeric,
      (canonical_item->>'discountAmount')::numeric, (canonical_item->>'lineTotal')::numeric,
      (canonical_item->>'lineTotal')::numeric, now()
    );
  END LOOP;

  IF customer_id IS NOT NULL THEN
    balance_before := COALESCE(customer_row.debt, 0);
    balance_after := balance_before + debt_amount;
    INSERT INTO public.customer_debt_transactions (
      id, customer_id, transaction_type, amount, debt_change, balance_before, balance_after,
      order_id, description, created_by, transaction_date
    ) VALUES (
      'dtx-ord-' || order_id, customer_id, 'order', debt_amount, debt_amount,
      balance_before, balance_after, order_id, 'Order ' || order_id,
      actor.auth_user_id::text, now()
    );
    UPDATE public.customers
    SET debt = balance_after,
        total_transaction = COALESCE(total_transaction, 0) + total_payable,
        net_revenue = COALESCE(net_revenue, 0) + total_payable,
        last_order_at = now(), updated_at = now(), updated_by = actor.auth_user_id::text
    WHERE id = customer_id;
  END IF;

  draft_id := NULLIF(p_order->>'draftId', '');
  IF draft_id IS NOT NULL THEN
    DELETE FROM public.draft_orders
    WHERE id = draft_id
      AND (created_by = actor.auth_user_id::text OR public.is_admin_or_accounting());
  END IF;

  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('orders', 'CONFIRM', order_id, NULL,
    jsonb_build_object('idempotency_key', idempotency_key, 'total_amount', total_amount,
      'price_list_id', selected_list_id, 'pricing_version', 'p1-v1'),
    actor.auth_user_id::text, now());

  RETURN public.p1_order_response(order_id) || jsonb_build_object('already_finalized', false);
END;
$$;

-- Finalized orders are immutable history. Phase 2 will add an explicit cancellation/reversal RPC.
REVOKE DELETE ON TABLE public.orders, public.order_items FROM authenticated;

REVOKE ALL ON FUNCTION public.p1_price_list_is_effective(public.pricelists) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p1_resolve_order_price_list(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p1_resolve_sku_price(text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p1_order_response(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_confirm_order(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0006', 'Authoritative SKU pricing, order snapshots and idempotent finalization')
ON CONFLICT (version) DO NOTHING;

COMMIT;
