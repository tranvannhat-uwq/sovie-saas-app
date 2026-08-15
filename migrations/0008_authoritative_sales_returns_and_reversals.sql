BEGIN;

-- Phase 3: authoritative sales returns and compensating transactions.
-- This migration intentionally has no inventory or production dependency.

ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS refund_cashbook_transaction_id text;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS debt_ledger_id text;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS sales_return_id text;

CREATE UNIQUE INDEX IF NOT EXISTS sales_returns_actor_idempotency_uidx
  ON public.sales_returns(created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS sales_returns_refund_cashbook_uidx
  ON public.sales_returns(refund_cashbook_transaction_id)
  WHERE refund_cashbook_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS sales_return_items_return_idx
  ON public.sales_return_items(return_id);
CREATE INDEX IF NOT EXISTS sales_return_items_sale_item_idx
  ON public.sales_return_items(sale_item_id);

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM public.sales_return_items WHERE COALESCE(quantity, 0) < 0)
     OR EXISTS (SELECT 1 FROM public.sales_returns
       WHERE COALESCE(total_refund, 0) < 0 OR COALESCE(total_return_amount, 0) < 0) THEN
    RAISE EXCEPTION 'Migration 0008 stopped: negative legacy return values require review';
  END IF;
END
$migration$;

CREATE SEQUENCE IF NOT EXISTS public.sales_return_display_seq;

DROP TRIGGER IF EXISTS p3_sales_returns_no_api_delete ON public.sales_returns;
CREATE TRIGGER p3_sales_returns_no_api_delete
BEFORE DELETE ON public.sales_returns
FOR EACH ROW EXECUTE FUNCTION public.p2_reject_api_financial_mutation();

DROP TRIGGER IF EXISTS p3_sales_return_items_immutable ON public.sales_return_items;
CREATE TRIGGER p3_sales_return_items_immutable
BEFORE UPDATE OR DELETE ON public.sales_return_items
FOR EACH ROW EXECUTE FUNCTION public.p2_reject_api_financial_mutation();

CREATE OR REPLACE FUNCTION public.p3_sales_return_response(p_return_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'success', true,
    'return_id', sales_return.id,
    'order_id', sales_return.sale_id,
    'customer_id', sales_return.customer_id,
    'status', sales_return.status,
    'order_status', sale.status,
    'total_refund', COALESCE(NULLIF(sales_return.total_refund, 0), sales_return.total_return_amount, 0),
    'debt_reduction', COALESCE(sales_return.debt_reduction_amount, 0),
    'cash_refund', COALESCE(sales_return.refund_amount, 0),
    'refund_cashbook_id', sales_return.refund_cashbook_transaction_id,
    'debt_ledger_id', sales_return.debt_ledger_id,
    'created_by', sales_return.created_by,
    'created_at', sales_return.created_at,
    'cancelled_at', sales_return.cancelled_at,
    'cancellation_reason', sales_return.cancellation_reason,
    'new_debt', customer.debt,
    'new_total_return', customer.total_return,
    'new_net_revenue', customer.net_revenue,
    'order_returned_amount', sale.returned_amount,
    'order_net_revenue', sale.net_revenue,
    'return', jsonb_build_object(
      'id', sales_return.id,
      'saleId', sales_return.sale_id,
      'orderId', sales_return.order_id,
      'customerId', sales_return.customer_id,
      'salespersonId', sales_return.salesperson_id,
      'createdBy', sales_return.created_by,
      'createdAt', sales_return.created_at,
      'returnDate', sales_return.return_date,
      'reason', sales_return.reason,
      'totalRefund', COALESCE(NULLIF(sales_return.total_refund, 0), sales_return.total_return_amount, 0),
      'debtReductionAmount', COALESCE(sales_return.debt_reduction_amount, 0),
      'refundAmount', COALESCE(sales_return.refund_amount, 0),
      'refundCashbookId', sales_return.refund_cashbook_transaction_id,
      'status', sales_return.status,
      'cancelledAt', sales_return.cancelled_at,
      'cancellationReason', sales_return.cancellation_reason,
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', item.id,
          'saleItemId', item.sale_item_id,
          'productId', item.product_id,
          'variantId', item.variant_id,
          'variantCode', item.variant_code_snapshot,
          'productName', item.product_name,
          'quantity', item.quantity,
          'importPrice', item.import_price,
          'refundPrice', item.refund_price,
          'subtotal', item.subtotal,
          'packageType', item.package_type,
          'packagingName', item.packaging_name_snapshot,
          'specificationSnapshot', item.specification_snapshot
        ) ORDER BY item.id)
        FROM public.sales_return_items item WHERE item.return_id = sales_return.id
      ), '[]'::jsonb)
    )
  )
  FROM public.sales_returns sales_return
  JOIN public.orders sale ON sale.id = sales_return.sale_id
  LEFT JOIN public.customers customer ON customer.id = sales_return.customer_id
  WHERE sales_return.id = p_return_id
$$;

CREATE OR REPLACE FUNCTION public.rpc_record_sales_return(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  sale public.orders%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  order_item public.order_items%ROWTYPE;
  existing_return public.sales_returns%ROWTYPE;
  input_item jsonb;
  normalized_items jsonb;
  order_id text := NULLIF(btrim(p_input->>'orderId'), '');
  reason text := NULLIF(btrim(p_input->>'reason'), '');
  v_payment_method text := lower(COALESCE(NULLIF(p_input->>'paymentMethod', ''), 'cash'));
  v_idempotency_key text := NULLIF(btrim(p_input->>'idempotencyKey'), '');
  request_hash text;
  return_id text;
  ledger_id text;
  refund_cashbook_id text;
  item_id text;
  item_quantity numeric;
  previous_quantity numeric;
  previous_cumulative_amount numeric;
  item_cap numeric;
  cumulative_amount numeric;
  line_refund numeric;
  v_total_refund numeric := 0;
  debt_reduction numeric := 0;
  cash_refund numeric := 0;
  balance_before numeric;
  balance_after numeric;
  existing_returned numeric;
  new_order_returned numeric;
  new_order_status text;
  commission_original public.commission_transactions%ROWTYPE;
  prior_commission_reversal numeric;
  prior_basis_reversal numeric;
  target_commission_reversal numeric;
  target_basis_reversal numeric;
  commission_delta numeric;
  basis_delta numeric;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF order_id IS NULL OR reason IS NULL OR length(reason) < 3 THEN
    RAISE EXCEPTION 'Order and a return reason of at least 3 characters are required';
  END IF;
  IF v_payment_method NOT IN ('cash', 'bank', 'wallet') THEN
    RAISE EXCEPTION 'Refund method must be cash, bank or wallet';
  END IF;
  IF v_idempotency_key IS NULL OR length(v_idempotency_key) < 8 OR length(v_idempotency_key) > 128 THEN
    RAISE EXCEPTION 'A stable return idempotency key (8..128 chars) is required';
  END IF;
  IF jsonb_typeof(p_input->'items') <> 'array' OR jsonb_array_length(p_input->'items') = 0 THEN
    RAISE EXCEPTION 'At least one returned order item is required';
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
    'saleItemId', NULLIF(btrim(item->>'saleItemId'), ''),
    'quantity', round(COALESCE(NULLIF(item->>'quantity', '')::numeric, 0), 6)
  ) ORDER BY item->>'saleItemId')
  INTO normalized_items
  FROM jsonb_array_elements(p_input->'items') item;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(normalized_items) item
    GROUP BY item->>'saleItemId' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'A sale item may appear only once in one return request';
  END IF;

  request_hash := md5(jsonb_build_object(
    'orderId', order_id, 'reason', reason, 'paymentMethod', v_payment_method,
    'items', normalized_items
  )::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(actor.auth_user_id::text || ':' || v_idempotency_key, 0));
  SELECT * INTO existing_return FROM public.sales_returns
  WHERE created_by = actor.auth_user_id::text
    AND idempotency_key = v_idempotency_key;
  IF FOUND THEN
    IF existing_return.request_fingerprint <> request_hash THEN
      RAISE EXCEPTION '409: idempotency key was already used with a different return'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.p3_sales_return_response(existing_return.id)
      || jsonb_build_object('already_recorded', true);
  END IF;

  SELECT * INTO STRICT sale FROM public.orders WHERE id = order_id FOR UPDATE;
  IF sale.status NOT IN ('settled', 'partially_returned') THEN
    RAISE EXCEPTION 'Only settled or partially returned orders can accept a return';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.sales_return_items legacy_item
    JOIN public.sales_returns legacy_return ON legacy_return.id = legacy_item.return_id
    WHERE legacy_return.sale_id = sale.id
      AND legacy_return.status NOT IN ('cancelled', 'canceled')
      AND (legacy_item.sale_item_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM public.order_items matched_item
        WHERE matched_item.id = legacy_item.sale_item_id AND matched_item.order_id = sale.id
      ))
  ) THEN
    RAISE EXCEPTION 'Active legacy return items are not linked to order items; return stopped for review';
  END IF;
  IF sale.customer_id IS NOT NULL THEN
    SELECT * INTO STRICT customer_row FROM public.customers
    WHERE id = sale.customer_id AND deleted_at IS NULL FOR UPDATE;
  END IF;

  return_id := 'RET3-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
    lpad(nextval('public.sales_return_display_seq')::text, 8, '0');
  INSERT INTO public.sales_returns(
    id, sale_id, order_id, customer_id, salesperson_id, total_return_amount,
    debt_reduction_amount, refund_amount, total_refund, reason, status,
    created_by, created_at, return_date, idempotency_key, request_fingerprint,
    updated_by, updated_at
  ) VALUES (
    return_id, sale.id, sale.id, sale.customer_id,
    COALESCE(sale.salesperson_id, sale.created_by), 0, 0, 0, 0, reason,
    'completed', actor.auth_user_id::text, now(), now(), v_idempotency_key,
    request_hash, actor.auth_user_id::text, now()
  );

  FOR input_item IN SELECT value FROM jsonb_array_elements(normalized_items) LOOP
    item_id := NULLIF(input_item->>'saleItemId', '');
    item_quantity := COALESCE((input_item->>'quantity')::numeric, 0);
    IF item_id IS NULL OR item_quantity <= 0 THEN
      RAISE EXCEPTION 'Each return item requires an order item ID and positive quantity';
    END IF;
    SELECT * INTO STRICT order_item FROM public.order_items
    WHERE id = item_id AND order_id = sale.id FOR UPDATE;
    SELECT COALESCE(sum(previous_item.quantity), 0) INTO previous_quantity
    FROM public.sales_return_items previous_item
    JOIN public.sales_returns previous_return ON previous_return.id = previous_item.return_id
    WHERE previous_return.sale_id = sale.id
      AND previous_return.status NOT IN ('cancelled', 'canceled')
      AND previous_item.sale_item_id = order_item.id;
    IF item_quantity > COALESCE(order_item.quantity, 0) - previous_quantity THEN
      RAISE EXCEPTION 'Returned quantity exceeds remaining sold quantity for item %', item_id;
    END IF;

    SELECT GREATEST(0, CASE
      WHEN COALESCE(sale.subtotal, 0) <= 0 THEN COALESCE(order_item.line_total, 0)
      WHEN order_item.id = (
        SELECT last_item.id FROM public.order_items last_item
        WHERE last_item.order_id = sale.id ORDER BY last_item.id DESC LIMIT 1
      ) THEN COALESCE(sale.total_payable, 0) - COALESCE((
        SELECT sum(round(COALESCE(other_item.line_total, 0) * sale.total_payable / sale.subtotal))
        FROM public.order_items other_item
        WHERE other_item.order_id = sale.id AND other_item.id <> order_item.id
      ), 0)
      ELSE round(COALESCE(order_item.line_total, 0) * sale.total_payable / sale.subtotal)
    END) INTO item_cap;

    previous_cumulative_amount := CASE
      WHEN previous_quantity = order_item.quantity THEN item_cap
      ELSE round(item_cap * previous_quantity / order_item.quantity)
    END;
    cumulative_amount := CASE
      WHEN previous_quantity + item_quantity = order_item.quantity
        THEN item_cap
      ELSE round(item_cap * (previous_quantity + item_quantity) / order_item.quantity)
    END;
    line_refund := cumulative_amount - previous_cumulative_amount;
    IF line_refund < 0 THEN
      RAISE EXCEPTION 'Existing returned amount is inconsistent for item %', item_id;
    END IF;
    v_total_refund := v_total_refund + line_refund;

    INSERT INTO public.sales_return_items(
      id, return_id, sale_item_id, product_id, variant_id, variant_code_snapshot,
      product_name, quantity, import_price, discount_type, discount_value,
      refund_price, subtotal, package_type, packaging_name_snapshot,
      specification_snapshot
    ) VALUES (
      return_id || '-ITEM-' || item_id, return_id, order_item.id,
      order_item.product_id, order_item.variant_id, order_item.variant_code_snapshot,
      order_item.product_name_snapshot, item_quantity,
      COALESCE(order_item.final_unit_price, order_item.unit_price, 0),
      'canonical', 0, CASE WHEN item_quantity = 0 THEN 0 ELSE line_refund / item_quantity END,
      line_refund, order_item.unit_snapshot, order_item.packaging_name_snapshot,
      order_item.specification_snapshot
    );
    UPDATE public.order_items
    SET returned_quantity = previous_quantity + item_quantity,
        returned_amount = cumulative_amount,
        net_amount = GREATEST(0, item_cap - cumulative_amount)
    WHERE id = order_item.id;
  END LOOP;

  SELECT COALESCE(sum(COALESCE(NULLIF(previous_return.total_refund, 0), previous_return.total_return_amount, 0)), 0)
    INTO existing_returned
  FROM public.sales_returns previous_return
  WHERE previous_return.sale_id = sale.id
    AND previous_return.id <> return_id
    AND previous_return.status NOT IN ('cancelled', 'canceled');
  new_order_returned := existing_returned + v_total_refund;
  IF new_order_returned > COALESCE(sale.total_payable, 0) THEN
    RAISE EXCEPTION 'Return value exceeds the remaining order value';
  END IF;

  IF sale.customer_id IS NOT NULL THEN
    IF COALESCE(customer_row.net_revenue, 0) < v_total_refund
       OR COALESCE(customer_row.total_transaction, 0) < v_total_refund THEN
      RAISE EXCEPTION 'Customer revenue aggregates are inconsistent; return stopped for review';
    END IF;
    balance_before := COALESCE(customer_row.debt, 0);
    debt_reduction := LEAST(v_total_refund, GREATEST(balance_before, 0));
    cash_refund := v_total_refund - debt_reduction;
    balance_after := balance_before - debt_reduction;
    IF debt_reduction > 0 THEN
      ledger_id := 'DTX-RET3-' || gen_random_uuid()::text;
      INSERT INTO public.customer_debt_transactions(
        id, customer_id, transaction_type, amount, debt_change, balance_before,
        balance_after, sales_return_id, order_id, description, created_by,
        transaction_date
      ) VALUES (
        ledger_id, sale.customer_id, 'return', debt_reduction, -debt_reduction,
        balance_before, balance_after, return_id, sale.id,
        'Trả hàng ' || return_id || ' của đơn ' || sale.id,
        actor.auth_user_id::text, now()
      );
    END IF;
    IF cash_refund > 0 THEN
      refund_cashbook_id := 'PC-RET-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
        lpad(nextval('public.cashbook_display_seq')::text, 8, '0');
      INSERT INTO public.cashbook_transactions(
        id, date, transaction_date, type, transaction_type, direction, category,
        partner, customer_id, order_id, sales_return_id, value, method,
        payment_method, accounting, status, creator, created_by, note, starred,
        external_reference
      ) VALUES (
        refund_cashbook_id, now(), now(), 'chi', 'sales_return_refund', 'out',
        'Hoàn tiền trả hàng', customer_row.name, customer_row.id, sale.id,
        return_id, cash_refund, v_payment_method, v_payment_method, false, 'completed',
        actor.display_name, actor.auth_user_id::text,
        'Hoàn tiền phiếu trả ' || return_id, false, return_id
      );
    END IF;
    UPDATE public.customers
    SET debt = balance_after,
        total_return = COALESCE(total_return, 0) + v_total_refund,
        net_revenue = net_revenue - v_total_refund,
        updated_at = now(), updated_by = actor.auth_user_id::text
    WHERE id = customer_row.id;
  ELSIF v_total_refund > 0 THEN
    RAISE EXCEPTION 'Guest order refunds require a linked customer for audit and payment';
  END IF;

  new_order_status := CASE WHEN NOT EXISTS (
    SELECT 1 FROM public.order_items item
    WHERE item.order_id = sale.id
      AND COALESCE((
        SELECT sum(return_item.quantity)
        FROM public.sales_return_items return_item
        JOIN public.sales_returns active_return ON active_return.id = return_item.return_id
        WHERE active_return.sale_id = sale.id
          AND active_return.status NOT IN ('cancelled', 'canceled')
          AND return_item.sale_item_id = item.id
      ), 0) < COALESCE(item.quantity, 0)
  ) THEN 'returned' ELSE 'partially_returned' END;
  UPDATE public.orders
  SET returned_amount = new_order_returned,
      net_revenue = GREATEST(0, COALESCE(total_payable, 0) - new_order_returned),
      status = new_order_status, updated_at = now(), updated_by = actor.auth_user_id::text
  WHERE id = sale.id;

  FOR commission_original IN
    SELECT original.* FROM public.commission_transactions original
    WHERE original.order_id = sale.id
      AND original.sales_return_id IS NULL
      AND original.transaction_type NOT IN ('order_cancel_reversal', 'sales_return_reversal', 'sales_return_cancel_reversal')
  LOOP
    SELECT COALESCE(-sum(reversal.commission_amount), 0),
           COALESCE(-sum(reversal.basis_amount), 0)
      INTO prior_commission_reversal, prior_basis_reversal
    FROM public.commission_transactions reversal
    WHERE reversal.order_id = sale.id
      AND reversal.transaction_type IN ('sales_return_reversal', 'sales_return_cancel_reversal')
      AND right(reversal.id, length(commission_original.id) + 1) = '-' || commission_original.id;
    target_commission_reversal := CASE
      WHEN new_order_returned = sale.total_payable THEN COALESCE(commission_original.commission_amount, 0)
      ELSE round(COALESCE(commission_original.commission_amount, 0) * new_order_returned / NULLIF(sale.total_payable, 0))
    END;
    target_basis_reversal := CASE
      WHEN new_order_returned = sale.total_payable THEN COALESCE(commission_original.basis_amount, 0)
      ELSE round(COALESCE(commission_original.basis_amount, 0) * new_order_returned / NULLIF(sale.total_payable, 0))
    END;
    commission_delta := GREATEST(0, target_commission_reversal - prior_commission_reversal);
    basis_delta := GREATEST(0, target_basis_reversal - prior_basis_reversal);
    IF commission_delta > 0 OR basis_delta > 0 THEN
      INSERT INTO public.commission_transactions(
        id, employee_id, salary_period, order_id, sales_return_id, transaction_type,
        calculation_basis, basis_amount, commission_rate, commission_amount,
        rule_id, status, calculated_at, created_at
      ) VALUES (
        'COMM-RET3-' || return_id || '-' || commission_original.id,
        commission_original.employee_id, commission_original.salary_period,
        sale.id, return_id, 'sales_return_reversal',
        commission_original.calculation_basis, -basis_delta,
        commission_original.commission_rate, -commission_delta,
        commission_original.rule_id, commission_original.status, now(), now()
      );
    END IF;
  END LOOP;

  UPDATE public.sales_returns
  SET total_return_amount = v_total_refund, debt_reduction_amount = debt_reduction,
      refund_amount = cash_refund, total_refund = v_total_refund,
      refund_cashbook_transaction_id = refund_cashbook_id,
      debt_ledger_id = ledger_id, updated_at = now(),
      updated_by = actor.auth_user_id::text
  WHERE id = return_id;

  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES ('sales_returns', 'RECORD', return_id,
    jsonb_build_object('order_id', sale.id, 'total_refund', v_total_refund,
      'debt_reduction', debt_reduction, 'cash_refund', cash_refund,
      'order_status', new_order_status, 'idempotency_key', v_idempotency_key),
    actor.auth_user_id::text, now());
  RETURN public.p3_sales_return_response(return_id) || jsonb_build_object(
    'already_recorded', false, 'performed_by', actor.auth_user_id::text
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_sales_return(
  p_return_id text, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  sales_return public.sales_returns%ROWTYPE;
  sale public.orders%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  return_item public.sales_return_items%ROWTYPE;
  order_item public.order_items%ROWTYPE;
  original_ledger public.customer_debt_transactions%ROWTYPE;
  refund_entry public.cashbook_transactions%ROWTYPE;
  reversal_id text;
  debt_restore numeric := 0;
  new_balance numeric;
  new_returned_amount numeric;
  new_order_status text;
  remaining_quantity numeric;
  remaining_amount numeric;
  item_cap numeric;
  commission_original public.commission_transactions%ROWTYPE;
  current_commission_effect numeric;
  current_basis_effect numeric;
  target_commission_effect numeric;
  target_basis_effect numeric;
  commission_adjustment numeric;
  basis_adjustment numeric;
  return_value numeric;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'A cancellation reason of at least 3 characters is required';
  END IF;
  SELECT * INTO STRICT sales_return FROM public.sales_returns
  WHERE id = p_return_id FOR UPDATE;
  SELECT * INTO STRICT sale FROM public.orders WHERE id = sales_return.sale_id FOR UPDATE;
  IF sales_return.status IN ('cancelled', 'canceled') THEN
    RETURN public.p3_sales_return_response(sales_return.id)
      || jsonb_build_object('already_cancelled', true);
  END IF;
  IF sales_return.status <> 'completed' THEN
    RAISE EXCEPTION 'Only a completed sales return can be cancelled';
  END IF;
  return_value := COALESCE(NULLIF(sales_return.total_refund, 0), sales_return.total_return_amount, 0);

  IF sales_return.customer_id IS NOT NULL THEN
    SELECT * INTO STRICT customer_row FROM public.customers
    WHERE id = sales_return.customer_id FOR UPDATE;
    IF COALESCE(customer_row.total_return, 0) < return_value THEN
      RAISE EXCEPTION 'Customer return aggregates are inconsistent; cancellation stopped for review';
    END IF;
    IF sales_return.debt_ledger_id IS NOT NULL THEN
      SELECT * INTO STRICT original_ledger FROM public.customer_debt_transactions
      WHERE id = sales_return.debt_ledger_id;
    ELSE
      SELECT * INTO original_ledger FROM public.customer_debt_transactions
      WHERE sales_return_id = sales_return.id AND transaction_type = 'return'
      ORDER BY transaction_date LIMIT 1;
    END IF;
    IF original_ledger.id IS NOT NULL THEN
      debt_restore := -COALESCE(original_ledger.debt_change, 0);
      new_balance := COALESCE(customer_row.debt, 0) + debt_restore;
      reversal_id := 'DTX-RET3-VOID-' || original_ledger.id;
      INSERT INTO public.customer_debt_transactions(
        id, customer_id, transaction_type, amount, debt_change, balance_before,
        balance_after, sales_return_id, order_id, reversal_of_id, description,
        created_by, transaction_date
      ) VALUES (
        reversal_id, sales_return.customer_id, 'return_cancel',
        debt_restore, debt_restore, customer_row.debt,
        new_balance, sales_return.id, sale.id, original_ledger.id,
        'Hủy phiếu trả ' || sales_return.id || ': ' || btrim(p_reason),
        actor.auth_user_id::text, now()
      );
    ELSE
      IF COALESCE(sales_return.debt_reduction_amount, 0) > 0
         OR (sales_return.idempotency_key IS NULL AND return_value > 0) THEN
        RAISE EXCEPTION 'Return debt ledger is missing; cancellation stopped for review';
      END IF;
      new_balance := COALESCE(customer_row.debt, 0);
    END IF;
    UPDATE public.customers
    SET debt = new_balance,
        total_return = total_return - return_value,
        net_revenue = net_revenue + return_value,
        updated_at = now(), updated_by = actor.auth_user_id::text
    WHERE id = customer_row.id;
  END IF;

  IF sales_return.refund_cashbook_transaction_id IS NOT NULL THEN
    SELECT * INTO STRICT refund_entry FROM public.cashbook_transactions
    WHERE id = sales_return.refund_cashbook_transaction_id FOR UPDATE;
    IF refund_entry.status NOT IN ('cancelled', 'canceled') THEN
      UPDATE public.cashbook_transactions
      SET status = 'cancelled', cancelled_at = now(),
          cancelled_by = actor.auth_user_id::text,
          cancellation_reason = 'Hủy phiếu trả ' || sales_return.id,
          updated_by = actor.auth_user_id::text
      WHERE id = refund_entry.id;
      INSERT INTO public.cashbook_transactions(
        id, date, transaction_date, type, transaction_type, direction, category,
        partner, customer_id, order_id, sales_return_id, value, method,
        payment_method, accounting, status, creator, created_by, note, starred,
        reversal_of_id
      ) VALUES (
        'VOID-' || refund_entry.id, now(), now(), 'thu',
        'sales_return_refund_reversal', 'in', 'Đảo hoàn tiền trả hàng',
        refund_entry.partner, refund_entry.customer_id, refund_entry.order_id,
        sales_return.id, refund_entry.value, refund_entry.method,
        refund_entry.payment_method, false, 'cancelled', actor.display_name,
        actor.auth_user_id::text, 'Giao dịch đảo cho ' || refund_entry.id,
        false, refund_entry.id
      ) ON CONFLICT (id) DO NOTHING;
    END IF;
  END IF;

  FOR return_item IN SELECT * FROM public.sales_return_items
    WHERE return_id = sales_return.id ORDER BY id FOR UPDATE
  LOOP
    SELECT * INTO STRICT order_item FROM public.order_items
    WHERE id = return_item.sale_item_id AND order_id = sale.id FOR UPDATE;
    SELECT COALESCE(sum(other_item.quantity), 0) INTO remaining_quantity
    FROM public.sales_return_items other_item
    JOIN public.sales_returns other_return ON other_return.id = other_item.return_id
    WHERE other_return.sale_id = sale.id
      AND other_return.id <> sales_return.id
      AND other_return.status NOT IN ('cancelled', 'canceled')
      AND other_item.sale_item_id = order_item.id;
    SELECT GREATEST(0, CASE
      WHEN COALESCE(sale.subtotal, 0) <= 0 THEN COALESCE(order_item.line_total, 0)
      WHEN order_item.id = (
        SELECT last_item.id FROM public.order_items last_item
        WHERE last_item.order_id = sale.id ORDER BY last_item.id DESC LIMIT 1
      ) THEN COALESCE(sale.total_payable, 0) - COALESCE((
        SELECT sum(round(COALESCE(other_order_item.line_total, 0) * sale.total_payable / sale.subtotal))
        FROM public.order_items other_order_item
        WHERE other_order_item.order_id = sale.id AND other_order_item.id <> order_item.id
      ), 0)
      ELSE round(COALESCE(order_item.line_total, 0) * sale.total_payable / sale.subtotal)
    END) INTO item_cap;
    remaining_amount := CASE
      WHEN remaining_quantity = order_item.quantity THEN item_cap
      ELSE round(item_cap * remaining_quantity / order_item.quantity)
    END;
    UPDATE public.order_items
    SET returned_quantity = remaining_quantity,
        returned_amount = remaining_amount,
        net_amount = GREATEST(0, item_cap - remaining_amount)
    WHERE id = return_item.sale_item_id;
  END LOOP;

  SELECT COALESCE(sum(COALESCE(NULLIF(other_return.total_refund, 0), other_return.total_return_amount, 0)), 0)
    INTO new_returned_amount
  FROM public.sales_returns other_return
  WHERE other_return.sale_id = sale.id
    AND other_return.id <> sales_return.id
    AND other_return.status NOT IN ('cancelled', 'canceled');
  new_order_status := CASE
    WHEN new_returned_amount = 0 THEN 'settled'
    WHEN NOT EXISTS (SELECT 1 FROM public.order_items item
      WHERE item.order_id = sale.id AND COALESCE((
        SELECT sum(other_item.quantity)
        FROM public.sales_return_items other_item
        JOIN public.sales_returns other_return ON other_return.id = other_item.return_id
        WHERE other_return.sale_id = sale.id
          AND other_return.id <> sales_return.id
          AND other_return.status NOT IN ('cancelled', 'canceled')
          AND other_item.sale_item_id = item.id
      ), 0) < COALESCE(item.quantity, 0))
      THEN 'returned'
    ELSE 'partially_returned'
  END;
  UPDATE public.orders
  SET returned_amount = new_returned_amount,
      net_revenue = GREATEST(0, COALESCE(total_payable, 0) - new_returned_amount),
      status = new_order_status, updated_at = now(), updated_by = actor.auth_user_id::text
  WHERE id = sale.id;

  FOR commission_original IN SELECT * FROM public.commission_transactions original
    WHERE original.order_id = sale.id
      AND original.sales_return_id IS NULL
      AND original.transaction_type NOT IN ('order_cancel_reversal', 'sales_return_reversal', 'sales_return_cancel_reversal')
  LOOP
    SELECT COALESCE(sum(effect.commission_amount), 0), COALESCE(sum(effect.basis_amount), 0)
      INTO current_commission_effect, current_basis_effect
    FROM public.commission_transactions effect
    WHERE effect.order_id = sale.id
      AND effect.transaction_type IN ('sales_return_reversal', 'sales_return_cancel_reversal')
      AND right(effect.id, length(commission_original.id) + 1) = '-' || commission_original.id;
    target_commission_effect := -CASE
      WHEN new_returned_amount = sale.total_payable THEN COALESCE(commission_original.commission_amount, 0)
      ELSE round(COALESCE(commission_original.commission_amount, 0) * new_returned_amount / NULLIF(sale.total_payable, 0))
    END;
    target_basis_effect := -CASE
      WHEN new_returned_amount = sale.total_payable THEN COALESCE(commission_original.basis_amount, 0)
      ELSE round(COALESCE(commission_original.basis_amount, 0) * new_returned_amount / NULLIF(sale.total_payable, 0))
    END;
    commission_adjustment := COALESCE(target_commission_effect, 0) - current_commission_effect;
    basis_adjustment := COALESCE(target_basis_effect, 0) - current_basis_effect;
    IF commission_adjustment <> 0 OR basis_adjustment <> 0 THEN
      INSERT INTO public.commission_transactions(
        id, employee_id, salary_period, order_id, sales_return_id, transaction_type,
        calculation_basis, basis_amount, commission_rate, commission_amount,
        rule_id, status, calculated_at, created_at
      ) VALUES (
        'COMM-RET3-VOID-' || sales_return.id || '-' || commission_original.id,
        commission_original.employee_id, commission_original.salary_period,
        commission_original.order_id, sales_return.id, 'sales_return_cancel_reversal',
        commission_original.calculation_basis, basis_adjustment,
        commission_original.commission_rate, commission_adjustment,
        commission_original.rule_id, commission_original.status, now(), now()
      ) ON CONFLICT (id) DO NOTHING;
    END IF;
  END LOOP;

  UPDATE public.sales_returns
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = actor.auth_user_id::text,
      cancellation_reason = btrim(p_reason), updated_at = now(),
      updated_by = actor.auth_user_id::text
  WHERE id = sales_return.id;
  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('sales_returns', 'CANCEL', sales_return.id, to_jsonb(sales_return),
    jsonb_build_object('reason', btrim(p_reason), 'order_status', new_order_status,
      'new_debt', new_balance, 'order_returned_amount', new_returned_amount),
    actor.auth_user_id::text, now());
  RETURN public.p3_sales_return_response(sales_return.id) || jsonb_build_object(
    'already_cancelled', false, 'performed_by', actor.auth_user_id::text
  );
END;
$$;

REVOKE INSERT, UPDATE, DELETE ON TABLE public.sales_returns, public.sales_return_items FROM authenticated;
REVOKE ALL ON FUNCTION public.p3_sales_return_response(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_record_sales_return(text, text, numeric, text, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_cancel_sales_return(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_record_sales_return(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_sales_return(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_record_sales_return(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sales_return(text, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0008', 'Authoritative sales returns with debt, refund, revenue and commission reversals')
ON CONFLICT (version) DO NOTHING;

COMMIT;
