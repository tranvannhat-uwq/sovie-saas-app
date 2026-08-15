-- Canonical customer-debt ledger repair.
-- Convention: debt > 0 means the customer owes the company; debt < 0 is a
-- customer credit/advance. This migration does not rewrite existing balances,
-- because an old negative balance can be either an advance or legacy data.

ALTER TABLE IF EXISTS public.orders ADD COLUMN IF NOT EXISTS shipping_fee_value numeric NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS public.orders ADD COLUMN IF NOT EXISTS shipping_fee_amount numeric NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS public.draft_orders ADD COLUMN IF NOT EXISTS shipping_fee_value numeric NOT NULL DEFAULT 0;
ALTER TABLE IF EXISTS public.draft_orders ADD COLUMN IF NOT EXISTS shipping_fee_amount numeric NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION public.rpc_confirm_order(p_order jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_order_id text := NULLIF(p_order->>'id', '');
    v_customer_id text := NULLIF(p_order->>'customerId', '');
    v_total_payable numeric := GREATEST(0, COALESCE((p_order->>'totalPayable')::numeric, 0));
    v_shipping_fee numeric := GREATEST(0, COALESCE((p_order->>'shippingFeeAmount')::numeric, (p_order->>'shippingFeeValue')::numeric, 0));
    v_paid_amount numeric := GREATEST(0, COALESCE((p_order->>'paidAmount')::numeric, 0));
    v_debt_amount numeric;
    v_created_by text := COALESCE(NULLIF(p_order->>'createdBy', ''), 'admin');
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
    IF v_order_id IS NULL THEN RAISE EXCEPTION 'Order ID is required'; END IF;
    IF jsonb_typeof(p_order->'items') <> 'array' OR jsonb_array_length(p_order->'items') = 0 THEN
        RAISE EXCEPTION 'An order must contain at least one item';
    END IF;

    v_debt_amount := GREATEST(0, COALESCE((p_order->>'amountDue')::numeric, v_total_payable + v_shipping_fee - v_paid_amount));
    IF v_paid_amount > v_total_payable + v_shipping_fee THEN
        RAISE EXCEPTION 'Paid amount cannot exceed the order total';
    END IF;

    -- A repeated request is a no-op: it must never create debt twice.
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
        COALESCE(p_order->>'salespersonId', v_created_by), p_order->>'customerManagerId',
        COALESCE(p_order->>'companyId', 'ABS_NORTH'), p_order->>'revenueBrandId',
        COALESCE(p_order->>'notes', ''), p_order->'items',
        COALESCE((p_order->>'totalMarket')::numeric, 0), COALESCE((p_order->>'totalDiscount')::numeric, 0),
        COALESCE((p_order->>'subtotal')::numeric, v_total_payable), COALESCE((p_order->>'discountValue')::numeric, 0),
        COALESCE(p_order->>'discountType', 'amount'), COALESCE((p_order->>'discountAmount')::numeric, 0),
        COALESCE((p_order->>'otherFeeValue')::numeric, 0), COALESCE(p_order->>'otherFeeType', 'amount'),
        COALESCE((p_order->>'otherFeeAmount')::numeric, 0), v_shipping_fee, v_shipping_fee,
        v_total_payable, v_total_payable, v_paid_amount, v_debt_amount, 0, v_total_payable,
        'settled', COALESCE((p_order->>'date')::timestamptz, now()), now(),
        COALESCE(p_order->>'pricelistId', 'retail'), v_created_by,
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
            id, order_id, product_id, brand_id, product_code_snapshot, variant_code_snapshot,
            product_name_snapshot, packaging_name_snapshot, specification_snapshot, unit_snapshot,
            price_list_id, price_list_name_snapshot, price_source, price_selected_by, quantity,
            list_price, unit_price, sale_price, final_unit_price, discount_percent,
            discount_amount, line_total, returned_quantity, returned_amount, net_amount, created_at
        ) VALUES (
            COALESCE(NULLIF(v_item->>'id', ''), v_order_id || '-item-' || v_item_index),
            v_order_id, v_product_id, NULLIF(v_item->>'brand', ''), v_product_code,
            v_product_code, COALESCE(v_item->>'productName', v_item->>'name', ''),
            COALESCE(v_item->>'packagingName', v_item->>'package', ''),
            COALESCE(v_item->>'specificationSnapshot', v_item->>'package', ''),
            COALESCE(v_item->>'unitName', v_item->>'packageWeightUnit', ''),
            NULLIF(v_item->>'priceListId', ''), COALESCE(v_item->>'priceListNameSnapshot', ''),
            COALESCE(NULLIF(v_item->>'priceSource', ''), 'manual'),
            COALESCE(v_item->>'priceSelectedBy', v_created_by), v_quantity, v_price, v_price,
            v_final_unit_price, v_final_unit_price, COALESCE((v_item->>'discountPercent')::numeric, 0),
            GREATEST(0, round(v_quantity * v_price) - round(v_quantity * v_final_unit_price)),
            round(v_quantity * v_final_unit_price), 0, 0, round(v_quantity * v_final_unit_price), now()
        );
        v_item_index := v_item_index + 1;
    END LOOP;

    IF v_customer_id IS NOT NULL THEN
        SELECT COALESCE(debt, 0) INTO STRICT v_balance_before FROM public.customers WHERE id = v_customer_id FOR UPDATE;
        v_balance_after := v_balance_before + v_debt_amount;
        INSERT INTO public.customer_debt_transactions (
            id, customer_id, transaction_type, amount, debt_change, balance_before, balance_after,
            order_id, description, created_by, transaction_date
        ) VALUES (
            'dtx-ord-' || v_order_id, v_customer_id, 'order', v_debt_amount, v_debt_amount,
            v_balance_before, v_balance_after, v_order_id, 'Mua hàng (Hóa đơn ' || v_order_id || ')', v_created_by, now()
        );
        UPDATE public.customers SET debt = v_balance_after,
            total_transaction = COALESCE(total_transaction, 0) + v_total_payable,
            net_revenue = COALESCE(net_revenue, 0) + v_total_payable,
            last_order_at = now(), updated_at = now() WHERE id = v_customer_id;
    END IF;
    DELETE FROM public.draft_orders WHERE id = v_order_id;
    RETURN jsonb_build_object('success', true, 'order_id', v_order_id,
      'new_debt', CASE WHEN v_customer_id IS NULL THEN NULL ELSE v_balance_after END,
      'debt_change', v_debt_amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_record_customer_payment(
    p_customer_id text, p_amount numeric, p_notes text, p_created_by text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_before numeric; v_after numeric; v_cashbook_id text; v_tx_id text;
BEGIN
    IF p_customer_id IS NULL OR p_customer_id = '' OR p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Customer and a positive payment amount are required';
    END IF;
    SELECT COALESCE(debt, 0) INTO STRICT v_before FROM public.customers WHERE id = p_customer_id FOR UPDATE;
    IF v_before <= 0 THEN RAISE EXCEPTION 'Customer has no receivable debt to collect'; END IF;
    IF p_amount > v_before THEN RAISE EXCEPTION 'Payment exceeds outstanding debt'; END IF;
    v_after := v_before - p_amount;
    v_cashbook_id := 'cb-pay-' || floor(extract(epoch FROM clock_timestamp()) * 1000)::text;
    v_tx_id := 'dtx-pay-' || floor(extract(epoch FROM clock_timestamp()) * 1000)::text;
    INSERT INTO public.cashbook_transactions (id, date, transaction_date, type, transaction_type, direction,
      category, partner, customer_id, value, method, payment_method, accounting, status, creator, created_by, note)
    VALUES (v_cashbook_id, now(), now(), 'thu', 'Thu nợ khách hàng', 'in', 'Thu nợ khách hàng',
      (SELECT name FROM public.customers WHERE id = p_customer_id), p_customer_id, p_amount, 'cash', 'cash',
      true, 'Đã thanh toán', COALESCE(p_created_by, 'admin'), COALESCE(p_created_by, 'admin'), p_notes);
    INSERT INTO public.customer_debt_transactions (id, customer_id, transaction_type, amount, debt_change,
      balance_before, balance_after, cashbook_transaction_id, description, created_by, transaction_date)
    VALUES (v_tx_id, p_customer_id, 'payment', p_amount, -p_amount, v_before, v_after, v_cashbook_id,
      COALESCE(p_notes, 'Thu tiền nợ'), COALESCE(p_created_by, 'admin'), now());
    UPDATE public.customers SET debt = v_after, last_payment_at = now(), updated_at = now() WHERE id = p_customer_id;
    RETURN jsonb_build_object('success', true, 'cashbook_id', v_cashbook_id, 'new_debt', v_after, 'debt_change', -p_amount);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_record_sales_return(
    p_return_id text, p_sale_id text, p_customer_id text, p_total_refund numeric,
    p_reason text, p_created_by text, p_items jsonb, p_order_status text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_before numeric; v_after numeric; v_total_return numeric; v_net_revenue numeric; v_item jsonb; v_index integer := 0;
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
    INSERT INTO public.sales_returns (id, sale_id, order_id, customer_id, salesperson_id, total_return_amount,
      debt_reduction_amount, refund_amount, total_refund, reason, status, created_by, created_at, return_date)
    VALUES (p_return_id, p_sale_id, p_sale_id, NULLIF(p_customer_id, ''), p_created_by, p_total_refund,
      p_total_refund, 0, p_total_refund, p_reason, 'completed', p_created_by, now(), now());
    FOR v_item IN SELECT value FROM jsonb_array_elements(COALESCE(p_items, '[]'::jsonb)) LOOP
      INSERT INTO public.sales_return_items (id, return_id, sale_item_id, product_id, variant_id, variant_code_snapshot,
        product_name, quantity, import_price, discount_type, discount_value, refund_price, subtotal,
        package_type, packaging_name_snapshot, specification_snapshot)
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
    UPDATE public.orders SET status = COALESCE(p_order_status, 'partially_returned'), updated_at = now() WHERE id = p_sale_id;
    IF p_customer_id IS NOT NULL AND p_customer_id <> '' THEN
      SELECT COALESCE(debt, 0), COALESCE(total_return, 0), COALESCE(net_revenue, 0)
        INTO STRICT v_before, v_total_return, v_net_revenue FROM public.customers WHERE id = p_customer_id FOR UPDATE;
      v_after := v_before - p_total_refund;
      v_total_return := v_total_return + p_total_refund;
      v_net_revenue := GREATEST(0, v_net_revenue - p_total_refund);
      INSERT INTO public.customer_debt_transactions (id, customer_id, transaction_type, amount, debt_change,
        balance_before, balance_after, sales_return_id, order_id, description, created_by, transaction_date)
      VALUES ('dtx-ret-' || p_return_id, p_customer_id, 'return', p_total_refund, -p_total_refund,
        v_before, v_after, p_return_id, p_sale_id, 'Phiếu trả hàng ' || p_return_id || ': ' || COALESCE(p_reason, ''), p_created_by, now());
      UPDATE public.customers SET debt = v_after, total_return = v_total_return, net_revenue = v_net_revenue,
        updated_at = now() WHERE id = p_customer_id;
    END IF;
    RETURN jsonb_build_object('success', true, 'return_id', p_return_id, 'new_debt', v_after,
      'new_total_return', v_total_return, 'new_net_revenue', v_net_revenue);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_sales_return(
    p_return_id text, p_order_status text, p_created_by text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_return public.sales_returns%ROWTYPE; v_before numeric; v_after numeric; v_total_return numeric; v_net_revenue numeric;
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
        COALESCE(v_return.total_refund, v_return.total_return_amount, 0), COALESCE(v_return.total_refund, v_return.total_return_amount, 0),
        v_before, v_after, p_return_id, v_return.sale_id, 'Hủy phiếu trả hàng ' || p_return_id, COALESCE(p_created_by, 'admin'), now());
      UPDATE public.customers SET debt = v_after, total_return = v_total_return, net_revenue = v_net_revenue,
        updated_at = now() WHERE id = v_return.customer_id;
    END IF;
    UPDATE public.sales_returns SET status = 'cancelled' WHERE id = p_return_id;
    UPDATE public.orders SET status = COALESCE(p_order_status, 'settled'), updated_at = now() WHERE id = v_return.sale_id;
    RETURN jsonb_build_object('success', true, 'new_debt', v_after,
      'new_total_return', v_total_return, 'new_net_revenue', v_net_revenue);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_confirm_order(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_record_customer_payment(text, numeric, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_record_sales_return(text, text, text, numeric, text, text, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.rpc_cancel_sales_return(text, text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_customer_payment(text, numeric, text, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_sales_return(text, text, text, numeric, text, text, jsonb, text) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sales_return(text, text, text) TO anon, authenticated;
