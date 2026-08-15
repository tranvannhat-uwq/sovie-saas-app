BEGIN;

-- Internal order implementation: preserves the current debt-ledger behavior.
-- It is not executable by API roles; public.rpc_confirm_order is the only gate.
CREATE OR REPLACE FUNCTION public.p0_confirm_order_core(p_order jsonb, p_actor uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_order_id text := NULLIF(p_order->>'id', '');
  v_customer_id text := NULLIF(p_order->>'customerId', '');
  v_total_payable numeric := GREATEST(0, COALESCE((p_order->>'totalPayable')::numeric, 0));
  v_shipping_fee numeric := GREATEST(0, COALESCE((p_order->>'shippingFeeAmount')::numeric, (p_order->>'shippingFeeValue')::numeric, 0));
  v_paid_amount numeric := GREATEST(0, COALESCE((p_order->>'paidAmount')::numeric, 0));
  v_debt_amount numeric;
  v_actor text := p_actor::text;
  v_balance_before numeric := 0;
  v_balance_after numeric := 0;
  v_item jsonb;
  v_item_index integer := 0;
  v_product_id text;
  v_product_code text;
  v_quantity numeric;
  v_price numeric;
  v_final_unit_price numeric;
BEGIN
  IF p_actor IS NULL THEN RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501'; END IF;
  IF v_order_id IS NULL THEN RAISE EXCEPTION 'Order ID is required'; END IF;
  IF jsonb_typeof(p_order->'items') <> 'array' OR jsonb_array_length(p_order->'items') = 0 THEN
    RAISE EXCEPTION 'An order must contain at least one item';
  END IF;
  v_debt_amount := GREATEST(0, COALESCE((p_order->>'amountDue')::numeric, v_total_payable + v_shipping_fee - v_paid_amount));
  IF v_paid_amount > v_total_payable + v_shipping_fee THEN
    RAISE EXCEPTION 'Paid amount cannot exceed the order total';
  END IF;

  IF EXISTS (SELECT 1 FROM public.orders WHERE id = v_order_id AND status <> 'draft') THEN
    SELECT COALESCE(debt, 0) INTO v_balance_after FROM public.customers WHERE id = v_customer_id;
    DELETE FROM public.draft_orders WHERE id = v_order_id;
    RETURN jsonb_build_object('success', true, 'order_id', v_order_id, 'already_finalized', true,
      'new_debt', CASE WHEN v_customer_id IS NULL THEN NULL ELSE v_balance_after END);
  END IF;

  INSERT INTO public.orders (
    id, customer_id, customer_name, salesperson_id, customer_manager_id, company_id,
    revenue_brand_id, notes, items, total_market, total_discount, subtotal,
    discount_value, discount_type, discount_amount, other_fee_value, other_fee_type,
    other_fee_amount, shipping_fee_value, shipping_fee_amount, total_payable,
    total_amount, paid_amount, debt_amount, returned_amount, net_revenue, status,
    order_date, confirmed_at, pricelist_id, created_by, created_at, updated_at
  ) VALUES (
    v_order_id, v_customer_id, COALESCE(p_order->>'customerName', ''),
    CASE WHEN public.current_profile_role() = 'sale' THEN v_actor
         ELSE COALESCE(NULLIF(p_order->>'salespersonId', ''), v_actor) END,
    p_order->>'customerManagerId', COALESCE(p_order->>'companyId', 'ABS_NORTH'),
    p_order->>'revenueBrandId', COALESCE(p_order->>'notes', ''), p_order->'items',
    COALESCE((p_order->>'totalMarket')::numeric, 0), COALESCE((p_order->>'totalDiscount')::numeric, 0),
    COALESCE((p_order->>'subtotal')::numeric, v_total_payable), COALESCE((p_order->>'discountValue')::numeric, 0),
    COALESCE(p_order->>'discountType', 'amount'), COALESCE((p_order->>'discountAmount')::numeric, 0),
    COALESCE((p_order->>'otherFeeValue')::numeric, 0), COALESCE(p_order->>'otherFeeType', 'amount'),
    COALESCE((p_order->>'otherFeeAmount')::numeric, 0), v_shipping_fee, v_shipping_fee,
    v_total_payable, v_total_payable, v_paid_amount, v_debt_amount, 0, v_total_payable,
    'settled', COALESCE((p_order->>'date')::timestamptz, now()), now(),
    COALESCE(NULLIF(p_order->>'pricelistId', ''), 'retail'), v_actor,
    COALESCE((p_order->>'date')::timestamptz, now()), now()
  );

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_order->'items') LOOP
    v_product_id := NULLIF(COALESCE(v_item->>'variantId', v_item->>'productId'), '');
    v_product_code := COALESCE(v_item->>'variantCode', v_item->>'productCode', v_item->>'code', '');
    v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
    v_price := COALESCE((v_item->>'unitPrice')::numeric, (v_item->>'price')::numeric, 0);
    v_final_unit_price := COALESCE((v_item->>'finalUnitPrice')::numeric, v_price);
    IF v_product_id IS NULL OR v_product_code = '' OR v_quantity <= 0 OR v_price <= 0 OR v_final_unit_price < 0 THEN
      RAISE EXCEPTION 'Invalid order item %', v_item_index + 1;
    END IF;
    INSERT INTO public.order_items (
      id, order_id, product_id, variant_id, brand_id, product_code_snapshot, variant_code_snapshot,
      product_name_snapshot, packaging_name_snapshot, specification_snapshot, unit_snapshot,
      price_list_id, price_list_name_snapshot, price_source, price_selected_by, quantity,
      list_price, unit_price, sale_price, final_unit_price, discount_percent,
      discount_amount, line_total, returned_quantity, returned_amount, net_amount, created_at
    ) VALUES (
      COALESCE(NULLIF(v_item->>'id', ''), v_order_id || '-item-' || v_item_index),
      v_order_id, v_product_id, v_product_id, NULLIF(v_item->>'brand', ''), v_product_code,
      v_product_code, COALESCE(v_item->>'productName', v_item->>'name', ''),
      COALESCE(v_item->>'packagingName', v_item->>'package', ''),
      COALESCE(v_item->>'specificationSnapshot', v_item->>'package', ''),
      COALESCE(v_item->>'unitName', v_item->>'packageWeightUnit', ''),
      NULLIF(v_item->>'priceListId', ''), COALESCE(v_item->>'priceListNameSnapshot', ''),
      COALESCE(NULLIF(v_item->>'priceSource', ''), 'manual'), v_actor, v_quantity,
      v_price, v_price, v_final_unit_price, v_final_unit_price,
      COALESCE((v_item->>'discountPercent')::numeric, 0),
      GREATEST(0, round(v_quantity * v_price) - round(v_quantity * v_final_unit_price)),
      round(v_quantity * v_final_unit_price), 0, 0, round(v_quantity * v_final_unit_price), now()
    );
    v_item_index := v_item_index + 1;
  END LOOP;

  IF v_customer_id IS NOT NULL THEN
    SELECT COALESCE(debt, 0) INTO STRICT v_balance_before
    FROM public.customers WHERE id = v_customer_id FOR UPDATE;
    v_balance_after := v_balance_before + v_debt_amount;
    INSERT INTO public.customer_debt_transactions (
      id, customer_id, transaction_type, amount, debt_change, balance_before, balance_after,
      order_id, description, created_by, transaction_date
    ) VALUES (
      'dtx-ord-' || v_order_id, v_customer_id, 'order', v_debt_amount, v_debt_amount,
      v_balance_before, v_balance_after, v_order_id, 'Order ' || v_order_id, v_actor, now()
    );
    UPDATE public.customers SET debt = v_balance_after,
      total_transaction = COALESCE(total_transaction, 0) + v_total_payable,
      net_revenue = COALESCE(net_revenue, 0) + v_total_payable,
      last_order_at = now(), updated_at = now() WHERE id = v_customer_id;
  END IF;
  DELETE FROM public.draft_orders WHERE id = v_order_id;
  RETURN jsonb_build_object('success', true, 'order_id', v_order_id,
    'new_debt', CASE WHEN v_customer_id IS NULL THEN NULL ELSE v_balance_after END,
    'debt_change', v_debt_amount, 'performed_by', v_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_confirm_order(p_order jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  item jsonb;
  list_id text;
BEGIN
  actor := public.require_authenticated_profile();
  list_id := NULLIF(p_order->>'pricelistId', '');
  IF NOT public.can_use_price_list(list_id) THEN
    RAISE EXCEPTION '403: price list is not available to this user' USING ERRCODE = '42501';
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(COALESCE(p_order->'items', '[]'::jsonb)) LOOP
    list_id := NULLIF(item->>'priceListId', '');
    IF NOT public.can_use_price_list(list_id) THEN
      RAISE EXCEPTION '403: item price list is not available to this user' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  IF actor.role = 'sale'
     AND NULLIF(p_order->>'customerId', '') IS NOT NULL
     AND NOT public.can_access_customer(p_order->>'customerId') THEN
    RAISE EXCEPTION '403: customer is outside sale scope' USING ERRCODE = '42501';
  END IF;
  RETURN public.p0_confirm_order_core(
    p_order - 'createdBy' - 'priceSelectedBy' - 'status' ||
      jsonb_build_object('createdBy', actor.auth_user_id::text, 'priceSelectedBy', actor.auth_user_id::text),
    actor.auth_user_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.p0_record_customer_payment_core(
  p_customer_id text, p_amount numeric, p_notes text, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_before numeric; v_after numeric; v_cashbook_id text; v_tx_id text; v_actor text := p_actor::text;
BEGIN
  IF p_customer_id IS NULL OR p_customer_id = '' OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Customer and a positive payment amount are required';
  END IF;
  SELECT COALESCE(debt, 0) INTO STRICT v_before FROM public.customers WHERE id = p_customer_id FOR UPDATE;
  IF v_before <= 0 THEN RAISE EXCEPTION 'Customer has no receivable debt to collect'; END IF;
  IF p_amount > v_before THEN RAISE EXCEPTION 'Payment exceeds outstanding debt'; END IF;
  v_after := v_before - p_amount;
  v_cashbook_id := 'cb-pay-' || gen_random_uuid()::text;
  v_tx_id := 'dtx-pay-' || gen_random_uuid()::text;
  INSERT INTO public.cashbook_transactions (id, date, transaction_date, type, transaction_type, direction,
    category, partner, customer_id, value, method, payment_method, accounting, status, creator, created_by, note)
  VALUES (v_cashbook_id, now(), now(), 'thu', 'customer_payment', 'in', 'customer_payment',
    (SELECT name FROM public.customers WHERE id = p_customer_id), p_customer_id, p_amount, 'cash', 'cash',
    true, 'completed', v_actor, v_actor, p_notes);
  INSERT INTO public.customer_debt_transactions (id, customer_id, transaction_type, amount, debt_change,
    balance_before, balance_after, cashbook_transaction_id, description, created_by, transaction_date)
  VALUES (v_tx_id, p_customer_id, 'payment', p_amount, -p_amount, v_before, v_after, v_cashbook_id,
    COALESCE(p_notes, 'Customer payment'), v_actor, now());
  UPDATE public.customers SET debt = v_after, last_payment_at = now(), updated_at = now() WHERE id = p_customer_id;
  RETURN jsonb_build_object('success', true, 'cashbook_id', v_cashbook_id,
    'new_debt', v_after, 'debt_change', -p_amount, 'performed_by', v_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_record_customer_payment(
  p_customer_id text, p_amount numeric, p_notes text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  RETURN public.p0_record_customer_payment_core(p_customer_id, p_amount, p_notes, actor.auth_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.p0_record_sales_return_core(
  p_return_id text, p_sale_id text, p_customer_id text, p_total_refund numeric,
  p_reason text, p_items jsonb, p_order_status text, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_before numeric; v_after numeric; v_total_return numeric; v_net_revenue numeric;
  v_item jsonb; v_index integer := 0; v_actor text := p_actor::text;
BEGIN
  IF p_return_id IS NULL OR p_return_id = '' OR p_total_refund IS NULL OR p_total_refund <= 0 THEN
    RAISE EXCEPTION 'Return ID and a positive refund are required';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customer_debt_transactions WHERE sales_return_id = p_return_id AND transaction_type = 'return') THEN
    SELECT COALESCE(debt, 0), COALESCE(total_return, 0), COALESCE(net_revenue, 0)
      INTO v_after, v_total_return, v_net_revenue FROM public.customers WHERE id = p_customer_id;
    RETURN jsonb_build_object('success', true, 'already_recorded', true, 'new_debt', v_after,
      'new_total_return', v_total_return, 'new_net_revenue', v_net_revenue);
  END IF;
  INSERT INTO public.sales_returns (id, sale_id, order_id, customer_id, salesperson_id,
    total_return_amount, debt_reduction_amount, refund_amount, total_refund, reason,
    status, created_by, created_at, return_date)
  VALUES (p_return_id, p_sale_id, p_sale_id, NULLIF(p_customer_id, ''), v_actor,
    p_total_refund, p_total_refund, 0, p_total_refund, p_reason, 'completed', v_actor, now(), now());
  FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
    INSERT INTO public.sales_return_items (id, return_id, sale_item_id, product_id, variant_id,
      variant_code_snapshot, product_name, quantity, import_price, discount_type, discount_value,
      refund_price, subtotal, package_type, packaging_name_snapshot, specification_snapshot)
    VALUES (COALESCE(NULLIF(v_item->>'id', ''), p_return_id || '-item-' || v_index), p_return_id,
      NULLIF(v_item->>'saleItemId', ''), NULLIF(v_item->>'productId', ''), NULLIF(v_item->>'variantId', ''),
      COALESCE(v_item->>'variantCode', v_item->>'productId', ''), COALESCE(v_item->>'productName', ''),
      COALESCE((v_item->>'quantity')::numeric, 0), COALESCE((v_item->>'importPrice')::numeric, 0),
      COALESCE(v_item->>'discountType', 'percent'), COALESCE((v_item->>'discountValue')::numeric, 0),
      COALESCE((v_item->>'refundPrice')::numeric, 0), COALESCE((v_item->>'subtotal')::numeric, 0),
      COALESCE(v_item->>'packageType', ''), COALESCE(v_item->>'packagingName', v_item->>'packageType', ''),
      COALESCE(v_item->>'specificationSnapshot', ''));
    v_index := v_index + 1;
  END LOOP;
  UPDATE public.orders SET status = p_order_status, updated_at = now() WHERE id = p_sale_id;
  IF p_customer_id IS NOT NULL AND p_customer_id <> '' THEN
    SELECT COALESCE(debt, 0), COALESCE(total_return, 0), COALESCE(net_revenue, 0)
      INTO STRICT v_before, v_total_return, v_net_revenue FROM public.customers WHERE id = p_customer_id FOR UPDATE;
    v_after := v_before - p_total_refund;
    v_total_return := v_total_return + p_total_refund;
    v_net_revenue := GREATEST(0, v_net_revenue - p_total_refund);
    INSERT INTO public.customer_debt_transactions (id, customer_id, transaction_type, amount, debt_change,
      balance_before, balance_after, sales_return_id, order_id, description, created_by, transaction_date)
    VALUES ('dtx-ret-' || p_return_id, p_customer_id, 'return', p_total_refund, -p_total_refund,
      v_before, v_after, p_return_id, p_sale_id, 'Sales return ' || p_return_id, v_actor, now());
    UPDATE public.customers SET debt = v_after, total_return = v_total_return,
      net_revenue = v_net_revenue, updated_at = now() WHERE id = p_customer_id;
  END IF;
  RETURN jsonb_build_object('success', true, 'return_id', p_return_id, 'new_debt', v_after,
    'new_total_return', v_total_return, 'new_net_revenue', v_net_revenue, 'performed_by', v_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_record_sales_return(
  p_return_id text, p_sale_id text, p_total_refund numeric,
  p_reason text, p_items jsonb
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor public.profiles%ROWTYPE; actual_customer text; derived_status text; fully_returned boolean := false;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  SELECT customer_id INTO STRICT actual_customer FROM public.orders WHERE id = p_sale_id FOR UPDATE;
  SELECT COALESCE(bool_and(
    COALESCE((
      SELECT sum(return_item.quantity)
      FROM public.sales_return_items return_item
      JOIN public.sales_returns sales_return ON sales_return.id = return_item.return_id
      WHERE sales_return.sale_id = p_sale_id
        AND sales_return.status NOT IN ('cancelled', 'canceled')
        AND return_item.sale_item_id = order_item.id
    ), 0)
    + COALESCE((
      SELECT sum(COALESCE((new_item.value->>'quantity')::numeric, 0))
      FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) new_item
      WHERE new_item.value->>'saleItemId' = order_item.id
    ), 0) >= order_item.quantity
  ), false)
  INTO fully_returned
  FROM public.order_items order_item
  WHERE order_item.order_id = p_sale_id;
  derived_status := CASE WHEN fully_returned THEN 'returned' ELSE 'partially_returned' END;
  RETURN public.p0_record_sales_return_core(p_return_id, p_sale_id, actual_customer,
    p_total_refund, p_reason, p_items, derived_status, actor.auth_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.p0_cancel_sales_return_core(
  p_return_id text, p_order_status text, p_actor uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_return public.sales_returns%ROWTYPE; v_before numeric; v_after numeric;
  v_total_return numeric; v_net_revenue numeric; v_actor text := p_actor::text;
BEGIN
  SELECT * INTO STRICT v_return FROM public.sales_returns WHERE id = p_return_id FOR UPDATE;
  IF v_return.status IN ('cancelled', 'canceled') THEN
    SELECT COALESCE(debt, 0), COALESCE(total_return, 0), COALESCE(net_revenue, 0)
      INTO v_after, v_total_return, v_net_revenue FROM public.customers WHERE id = v_return.customer_id;
    RETURN jsonb_build_object('success', true, 'already_cancelled', true, 'new_debt', v_after,
      'new_total_return', v_total_return, 'new_net_revenue', v_net_revenue);
  END IF;
  IF v_return.customer_id IS NOT NULL AND v_return.customer_id <> '' THEN
    SELECT COALESCE(debt, 0), COALESCE(total_return, 0), COALESCE(net_revenue, 0)
      INTO STRICT v_before, v_total_return, v_net_revenue FROM public.customers WHERE id = v_return.customer_id FOR UPDATE;
    v_after := v_before + COALESCE(v_return.total_refund, v_return.total_return_amount, 0);
    v_total_return := GREATEST(0, v_total_return - COALESCE(v_return.total_refund, v_return.total_return_amount, 0));
    v_net_revenue := v_net_revenue + COALESCE(v_return.total_refund, v_return.total_return_amount, 0);
    INSERT INTO public.customer_debt_transactions (id, customer_id, transaction_type, amount, debt_change,
      balance_before, balance_after, sales_return_id, order_id, description, created_by, transaction_date)
    VALUES ('dtx-ret-void-' || p_return_id, v_return.customer_id, 'return_cancel',
      COALESCE(v_return.total_refund, v_return.total_return_amount, 0),
      COALESCE(v_return.total_refund, v_return.total_return_amount, 0), v_before, v_after,
      p_return_id, v_return.sale_id, 'Cancel sales return ' || p_return_id, v_actor, now());
    UPDATE public.customers SET debt = v_after, total_return = v_total_return,
      net_revenue = v_net_revenue, updated_at = now() WHERE id = v_return.customer_id;
  END IF;
  UPDATE public.sales_returns SET status = 'cancelled' WHERE id = p_return_id;
  UPDATE public.orders SET status = p_order_status, updated_at = now() WHERE id = v_return.sale_id;
  RETURN jsonb_build_object('success', true, 'new_debt', v_after,
    'new_total_return', v_total_return, 'new_net_revenue', v_net_revenue, 'performed_by', v_actor);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_sales_return(
  p_return_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor public.profiles%ROWTYPE; next_status text; sale_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  SELECT sales_return.sale_id INTO STRICT sale_id
  FROM public.sales_returns sales_return WHERE sales_return.id = p_return_id;
  next_status := CASE WHEN EXISTS (
    SELECT 1 FROM public.sales_returns remaining
    WHERE remaining.sale_id = sale_id AND remaining.id <> p_return_id
      AND remaining.status NOT IN ('cancelled', 'canceled')
  ) THEN 'partially_returned' ELSE 'settled' END;
  RETURN public.p0_cancel_sales_return_core(p_return_id, next_status, actor.auth_user_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_adjust_customer_debt(
  p_customer_id text, p_new_debt numeric, p_description text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE actor public.profiles%ROWTYPE; old_debt numeric; tx_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  SELECT COALESCE(debt, 0) INTO STRICT old_debt FROM public.customers WHERE id = p_customer_id FOR UPDATE;
  tx_id := 'dtx-adj-' || gen_random_uuid()::text;
  INSERT INTO public.customer_debt_transactions (id, customer_id, transaction_type, amount,
    debt_change, balance_before, balance_after, description, created_by, transaction_date)
  VALUES (tx_id, p_customer_id, 'adjust', ABS(p_new_debt - old_debt), p_new_debt - old_debt,
    old_debt, p_new_debt, COALESCE(p_description, 'Debt adjustment'), actor.auth_user_id::text, now());
  UPDATE public.customers SET debt = p_new_debt, updated_at = now() WHERE id = p_customer_id;
  RETURN jsonb_build_object('success', true, 'new_debt', p_new_debt,
    'debt_change', p_new_debt - old_debt, 'performed_by', actor.auth_user_id::text);
END;
$$;

DO $migration$
DECLARE signature regprocedure;
BEGIN
  FOREACH signature IN ARRAY ARRAY[
    to_regprocedure('public.p0_confirm_order_core(jsonb,uuid)'),
    to_regprocedure('public.p0_record_customer_payment_core(text,numeric,text,uuid)'),
    to_regprocedure('public.p0_record_sales_return_core(text,text,text,numeric,text,jsonb,text,uuid)'),
    to_regprocedure('public.p0_cancel_sales_return_core(text,text,uuid)')
  ] LOOP
    IF signature IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', signature);
    END IF;
  END LOOP;
END
$migration$;

REVOKE ALL ON FUNCTION public.rpc_confirm_order(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_record_customer_payment(text, numeric, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_record_sales_return(text, text, numeric, text, jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_sales_return(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_adjust_customer_debt(text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_customer_payment(text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_sales_return(text, text, numeric, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sales_return(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_customer_debt(text, numeric, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0003', 'Authenticated role-checked financial RPC boundary')
ON CONFLICT (version) DO NOTHING;

COMMIT;
