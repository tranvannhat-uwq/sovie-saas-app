-- Run after migration_sku_price_matrix.sql.
-- Replaces the order confirmation RPC so new orders keep immutable SKU/price snapshots.
-- This application does not manage inventory; this RPC does not update stock tables.

BEGIN;

ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS specification_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_list_id text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_list_name_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS unit_price numeric;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_source text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_selected_by text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS final_unit_price numeric;

CREATE OR REPLACE FUNCTION public.rpc_confirm_order(p_order jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_order_id text := NULLIF(p_order->>'id', '');
  v_customer_id text := NULLIF(p_order->>'customerId', '');
  v_total_payable numeric := COALESCE((p_order->>'totalPayable')::numeric, 0);
  v_paid_amount numeric := COALESCE((p_order->>'paidAmount')::numeric, 0);
  v_debt_amount numeric;
  v_debt_change numeric := 0;
  v_created_by text := COALESCE(NULLIF(p_order->>'createdBy', ''), 'admin');
  v_balance_before numeric := 0;
  v_balance_after numeric := 0;
  v_item jsonb;
  v_item_index integer := 0;
  v_product_id text;
  v_product_code text;
  v_brand text;
  v_specification text;
  v_quantity numeric;
  v_list_price numeric;
  v_unit_price numeric;
  v_final_unit_price numeric;
  v_discount_percent numeric;
  v_line_total numeric;
  v_price_source text;
  v_price_list_id text;
  v_cashbook_id text;
BEGIN
  IF v_order_id IS NULL THEN
    RAISE EXCEPTION 'Mã đơn hàng không được để trống';
  END IF;
  IF jsonb_typeof(p_order->'items') <> 'array'
     OR jsonb_array_length(p_order->'items') = 0 THEN
    RAISE EXCEPTION 'Đơn hàng phải có ít nhất một sản phẩm';
  END IF;
  IF v_total_payable < 0 OR v_paid_amount < 0 OR v_paid_amount > v_total_payable THEN
    RAISE EXCEPTION 'Số tiền đơn hàng hoặc thanh toán không hợp lệ';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.orders
    WHERE id = v_order_id AND status <> 'draft'
  ) THEN
    DELETE FROM public.draft_orders WHERE id = v_order_id;
    RETURN jsonb_build_object(
      'success', true,
      'order_id', v_order_id,
      'already_finalized', true
    );
  END IF;

  v_debt_amount := v_total_payable - v_paid_amount;

  INSERT INTO public.orders (
    id, customer_id, customer_name, salesperson_id, customer_manager_id,
    company_id, revenue_brand_id, notes, items, total_market, total_discount,
    subtotal, discount_value, discount_type, discount_amount, other_fee_value,
    other_fee_type, other_fee_amount, total_payable, total_amount, paid_amount,
    debt_amount, returned_amount, net_revenue, status, order_date, confirmed_at,
    pricelist_id, created_by, created_at, updated_at
  ) VALUES (
    v_order_id,
    v_customer_id,
    COALESCE(p_order->>'customerName', ''),
    COALESCE(p_order->>'salespersonId', v_created_by),
    p_order->>'customerManagerId',
    COALESCE(p_order->>'companyId', 'ABS_NORTH'),
    p_order->>'revenueBrandId',
    COALESCE(p_order->>'notes', ''),
    p_order->'items',
    COALESCE((p_order->>'totalMarket')::numeric, 0),
    COALESCE((p_order->>'totalDiscount')::numeric, 0),
    COALESCE((p_order->>'subtotal')::numeric, v_total_payable),
    COALESCE((p_order->>'discountValue')::numeric, 0),
    COALESCE(p_order->>'discountType', 'amount'),
    COALESCE((p_order->>'discountAmount')::numeric, 0),
    COALESCE((p_order->>'otherFeeValue')::numeric, 0),
    COALESCE(p_order->>'otherFeeType', 'amount'),
    COALESCE((p_order->>'otherFeeAmount')::numeric, 0),
    v_total_payable,
    v_total_payable,
    v_paid_amount,
    v_debt_amount,
    0,
    v_total_payable,
    'settled',
    COALESCE((p_order->>'date')::timestamptz, now()),
    now(),
    NULLIF(p_order->>'pricelistId', ''),
    v_created_by,
    COALESCE((p_order->>'date')::timestamptz, now()),
    now()
  );

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_order->'items')
  LOOP
    v_product_id := NULLIF(v_item->>'productId', '');
    v_product_code := COALESCE(v_item->>'productCode', v_item->>'code', '');
    v_brand := COALESCE(v_item->>'brand', '');
    v_specification := COALESCE(
      NULLIF(v_item->>'specificationSnapshot', ''),
      NULLIF(v_item->>'displaySpecification', ''),
      NULLIF(v_item->>'package', ''),
      NULLIF(v_item->>'packageType', ''),
      ''
    );
    v_quantity := COALESCE((v_item->>'quantity')::numeric, 0);
    v_list_price := COALESCE((v_item->>'listPrice')::numeric, (v_item->>'price')::numeric, 0);
    v_unit_price := COALESCE((v_item->>'unitPrice')::numeric, (v_item->>'price')::numeric, 0);
    v_final_unit_price := COALESCE(
      (v_item->>'finalUnitPrice')::numeric,
      (v_item->>'salePrice')::numeric,
      v_unit_price
    );
    v_discount_percent := COALESCE((v_item->>'discountPercent')::numeric, 0);
    v_price_source := COALESCE(NULLIF(v_item->>'priceSource', ''), 'missing');
    v_price_list_id := NULLIF(v_item->>'priceListId', '');
    v_line_total := round(v_quantity * v_final_unit_price);

    IF v_product_id IS NULL OR v_product_code = '' OR v_quantity <= 0 THEN
      RAISE EXCEPTION 'Dòng sản phẩm % không có SKU hợp lệ', v_item_index + 1;
    END IF;
    IF NOT EXISTS (
      SELECT 1
      FROM public.products product
      WHERE product.id = v_product_id
        AND product.code = v_product_code
        AND product.package_type IS NOT NULL
        AND product.is_legacy = false
    ) THEN
      RAISE EXCEPTION 'SKU % không tồn tại hoặc là sản phẩm legacy', v_product_code;
    END IF;
    IF v_unit_price <= 0 OR v_final_unit_price <= 0 OR v_price_source = 'missing' THEN
      RAISE EXCEPTION 'SKU % chưa có giá hợp lệ trong bảng giá đang áp dụng', v_product_code;
    END IF;
    IF v_price_source <> 'manual_override' AND v_price_list_id IS NULL THEN
      RAISE EXCEPTION 'SKU % thiếu bảng giá nguồn', v_product_code;
    END IF;

    INSERT INTO public.order_items (
      id, order_id, product_id, brand_id, product_code_snapshot,
      product_name_snapshot, specification_snapshot, unit_snapshot,
      price_list_id, price_list_name_snapshot, price_source, price_selected_by,
      quantity, list_price, unit_price, sale_price, final_unit_price,
      discount_percent, discount_amount, line_total,
      returned_quantity, returned_amount, net_amount, created_at
    ) VALUES (
      COALESCE(NULLIF(v_item->>'id', ''), v_order_id || '-item-' || v_item_index),
      v_order_id,
      v_product_id,
      NULLIF(v_brand, ''),
      v_product_code,
      COALESCE(v_item->>'productName', v_item->>'name', ''),
      v_specification,
      COALESCE(NULLIF(v_item->>'packageWeightUnit', ''), NULLIF(v_item->>'unit', ''), ''),
      v_price_list_id,
      COALESCE(NULLIF(v_item->>'priceListNameSnapshot', ''), NULLIF(p_order->>'priceListNameSnapshot', ''), ''),
      v_price_source,
      COALESCE(NULLIF(v_item->>'priceSelectedBy', ''), NULLIF(p_order->>'priceSelectedBy', ''), v_created_by),
      v_quantity,
      v_list_price,
      v_unit_price,
      v_final_unit_price,
      v_final_unit_price,
      v_discount_percent,
      round(v_quantity * v_unit_price) - v_line_total,
      v_line_total,
      0,
      0,
      v_line_total,
      now()
    );

    v_item_index := v_item_index + 1;
  END LOOP;

  IF v_customer_id IS NOT NULL THEN
    SELECT COALESCE(debt, 0)
    INTO STRICT v_balance_before
    FROM public.customers
    WHERE id = v_customer_id
    FOR UPDATE;

    v_debt_change := CASE
      WHEN v_balance_before <= 0 THEN -v_debt_amount
      ELSE v_debt_amount
    END;
    v_balance_after := v_balance_before + v_debt_change;

    INSERT INTO public.customer_debt_transactions (
      id, customer_id, transaction_type, amount, debt_change,
      balance_before, balance_after, order_id, description,
      created_by, transaction_date
    ) VALUES (
      'dtx-ord-' || v_order_id,
      v_customer_id,
      'order',
      v_total_payable,
      v_debt_change,
      v_balance_before,
      v_balance_after,
      v_order_id,
      'Mua hàng (Hóa đơn ' || v_order_id || ')',
      v_created_by,
      now()
    );

    UPDATE public.customers
    SET total_transaction = COALESCE(total_transaction, 0) + v_total_payable,
        net_revenue = COALESCE(net_revenue, 0) + v_total_payable,
        debt = v_balance_after,
        last_order_at = now(),
        updated_at = now()
    WHERE id = v_customer_id;
  END IF;

  IF v_paid_amount > 0 THEN
    v_cashbook_id := 'cb-ord-' || v_order_id;
    INSERT INTO public.cashbook_transactions (
      id, date, type, category, partner, value, method,
      accounting, status, creator, note, customer_id, order_id
    ) VALUES (
      v_cashbook_id,
      now(),
      'thu',
      'Thu tiền bán hàng',
      COALESCE(p_order->>'customerName', 'Khách hàng'),
      v_paid_amount,
      COALESCE(p_order->>'paymentMethod', 'cash'),
      true,
      'Đã thanh toán',
      v_created_by,
      'Thu tiền hàng cho hóa đơn ' || v_order_id,
      v_customer_id,
      v_order_id
    );
  END IF;

  DELETE FROM public.draft_orders WHERE id = v_order_id;

  RETURN jsonb_build_object(
    'success', true,
    'order_id', v_order_id,
    'new_debt', CASE WHEN v_customer_id IS NULL THEN NULL ELSE v_balance_after END,
    'debt_change', v_debt_change
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_confirm_order(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO anon, authenticated;

COMMIT;
