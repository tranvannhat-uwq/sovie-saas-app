BEGIN;

-- A customer receipt may be larger than the current receivable. The resulting
-- negative balance is customer credit and is automatically consumed by later
-- order charges through the existing signed customer-debt convention.
CREATE OR REPLACE FUNCTION public.rpc_record_customer_receipt(
  p_customer_id text,
  p_amount numeric,
  p_notes text,
  p_payment_method text,
  p_idempotency_key text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_variable
DECLARE
  actor public.profiles%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  existing_entry public.cashbook_transactions%ROWTYPE;
  request_hash text;
  cashbook_id text;
  payment_id text;
  ledger_id text;
  new_balance numeric;
  normalized_method text := lower(COALESCE(NULLIF(p_payment_method, ''), 'cash'));
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF p_customer_id IS NULL OR p_customer_id = '' OR p_amount IS NULL OR p_amount <= 0 THEN
    RAISE EXCEPTION 'Customer and a positive receipt amount are required';
  END IF;
  IF normalized_method NOT IN ('cash', 'bank', 'wallet') THEN
    RAISE EXCEPTION 'Payment method must be cash, bank or wallet';
  END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8
     OR length(p_idempotency_key) > 128 THEN
    RAISE EXCEPTION 'A stable receipt idempotency key (8..128 chars) is required';
  END IF;

  request_hash := md5(jsonb_build_object(
    'customerId', p_customer_id, 'amount', round(p_amount),
    'notes', COALESCE(p_notes, ''), 'paymentMethod', normalized_method
  )::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(actor.auth_user_id::text || ':' || p_idempotency_key, 0));

  SELECT * INTO existing_entry
  FROM public.cashbook_transactions
  WHERE created_by = actor.auth_user_id::text
    AND idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF existing_entry.request_fingerprint <> request_hash
       OR existing_entry.transaction_type <> 'customer_payment' THEN
      RAISE EXCEPTION '409: idempotency key was already used with a different receipt'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.p2_cashbook_response(existing_entry.id) || jsonb_build_object(
      'already_recorded', true,
      'new_debt', (SELECT balance_after FROM public.customer_debt_transactions
        WHERE cashbook_transaction_id = existing_entry.id AND transaction_type = 'payment'
        ORDER BY transaction_date LIMIT 1),
      'customer_credit', GREATEST(-COALESCE((SELECT balance_after
        FROM public.customer_debt_transactions
        WHERE cashbook_transaction_id = existing_entry.id AND transaction_type = 'payment'
        ORDER BY transaction_date LIMIT 1), 0), 0)
    );
  END IF;

  SELECT * INTO STRICT customer_row
  FROM public.customers
  WHERE id = p_customer_id
    AND COALESCE(status, 'active') = 'active'
    AND deleted_at IS NULL
  FOR UPDATE;

  cashbook_id := 'PT-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
    lpad(nextval('public.cashbook_display_seq')::text, 8, '0');
  payment_id := 'PAY-' || gen_random_uuid()::text;
  ledger_id := 'DTX-PAY-' || gen_random_uuid()::text;
  new_balance := round(COALESCE(customer_row.debt, 0)) - round(p_amount);

  INSERT INTO public.cashbook_transactions(
    id, date, transaction_date, type, transaction_type, direction, category,
    partner, customer_id, value, method, payment_method, accounting, status,
    creator, created_by, note, starred, idempotency_key, request_fingerprint
  ) VALUES (
    cashbook_id, now(), now(), 'thu', 'customer_payment', 'in', 'Thu tiền khách hàng',
    customer_row.name, customer_row.id, round(p_amount), normalized_method,
    normalized_method, true, 'completed', actor.display_name, actor.auth_user_id::text,
    COALESCE(p_notes, 'Thu tiền khách hàng'), false, p_idempotency_key, request_hash
  );

  INSERT INTO public.payments(
    id, customer_id, amount, payment_method, status, cashbook_transaction_id,
    idempotency_key, request_fingerprint, created_by, created_at
  ) VALUES (
    payment_id, customer_row.id, round(p_amount), normalized_method, 'completed',
    cashbook_id, p_idempotency_key, request_hash, actor.auth_user_id::text, now()
  );

  INSERT INTO public.customer_debt_transactions(
    id, customer_id, transaction_type, amount, debt_change, balance_before,
    balance_after, cashbook_transaction_id, description, idempotency_key,
    created_by, transaction_date
  ) VALUES (
    ledger_id, customer_row.id, 'payment', round(p_amount), -round(p_amount),
    round(COALESCE(customer_row.debt, 0)), new_balance, cashbook_id,
    COALESCE(p_notes, 'Thu tiền khách hàng'), p_idempotency_key,
    actor.auth_user_id::text, now()
  );

  UPDATE public.customers
  SET debt = new_balance, last_payment_at = now(), updated_at = now(),
      updated_by = actor.auth_user_id::text
  WHERE id = customer_row.id;

  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES ('customer_payments', 'RECORD_RECEIPT', cashbook_id,
    jsonb_build_object('customer_id', customer_row.id, 'amount', round(p_amount),
      'payment_method', normalized_method, 'new_debt', new_balance,
      'customer_credit', GREATEST(-new_balance, 0)),
    actor.auth_user_id::text, now());

  RETURN public.p2_cashbook_response(cashbook_id) || jsonb_build_object(
    'payment_id', payment_id, 'ledger_id', ledger_id, 'new_debt', new_balance,
    'customer_credit', GREATEST(-new_balance, 0),
    'debt_change', -round(p_amount), 'already_recorded', false,
    'performed_by', actor.auth_user_id::text
  );
END;
$$;

-- This reversal is private to the amendment transaction. Unlike the legacy
-- standalone cancellation RPC it supports a signed (credit) customer balance
-- and later unallocated receipts. The replacement order is confirmed before
-- the surrounding transaction commits, so a failure rolls every reversal back.
CREATE OR REPLACE FUNCTION public.p19_reverse_order_for_amendment(
  p_order_id text,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_variable
DECLARE
  actor public.profiles%ROWTYPE;
  sale public.orders%ROWTYPE;
  charge public.customer_debt_transactions%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  new_balance numeric;
  reversal_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO STRICT sale FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF sale.status <> 'settled' THEN
    RAISE EXCEPTION 'Only a settled order may be reversed for amendment';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_returns
    WHERE sale_id = sale.id AND status NOT IN ('cancelled', 'canceled', 'draft')) THEN
    RAISE EXCEPTION 'Order has active sales returns and cannot be amended';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
    WHERE order_id = sale.id AND status = 'completed') THEN
    RAISE EXCEPTION 'Cancel linked order payments before amending the order';
  END IF;

  IF sale.customer_id IS NOT NULL THEN
    SELECT * INTO STRICT charge
    FROM public.customer_debt_transactions
    WHERE order_id = sale.id AND transaction_type = 'order'
    ORDER BY transaction_date LIMIT 1;
    SELECT * INTO STRICT customer_row
    FROM public.customers WHERE id = sale.customer_id FOR UPDATE;
    IF COALESCE(customer_row.total_transaction, 0) < COALESCE(sale.total_payable, 0)
       OR COALESCE(customer_row.net_revenue, 0) < COALESCE(sale.total_payable, 0) THEN
      RAISE EXCEPTION 'Customer revenue aggregates are inconsistent; amendment stopped for review';
    END IF;

    new_balance := round(COALESCE(customer_row.debt, 0)) - round(charge.debt_change);
    reversal_id := 'DTX-ORDER-AMEND-' || charge.id;
    INSERT INTO public.customer_debt_transactions(
      id, customer_id, transaction_type, amount, debt_change, balance_before,
      balance_after, order_id, reversal_of_id, description, created_by, transaction_date
    ) VALUES (
      reversal_id, sale.customer_id, 'order_cancel', ABS(charge.debt_change),
      -charge.debt_change, round(COALESCE(customer_row.debt, 0)), new_balance,
      sale.id, charge.id, 'Sửa đơn ' || sale.id || ': ' || btrim(p_reason),
      actor.auth_user_id::text, now()
    );
    UPDATE public.customers
    SET debt = new_balance,
        total_transaction = total_transaction - COALESCE(sale.total_payable, 0),
        net_revenue = net_revenue - COALESCE(sale.total_payable, 0),
        updated_at = now(), updated_by = actor.auth_user_id::text
    WHERE id = sale.customer_id;
  END IF;

  INSERT INTO public.commission_transactions(
    id, employee_id, salary_period, order_id, transaction_type,
    calculation_basis, basis_amount, commission_rate, commission_amount,
    rule_id, status, calculated_at, created_at
  )
  SELECT 'COMM-VOID-' || original.id, original.employee_id, original.salary_period,
    original.order_id, 'order_cancel_reversal', original.calculation_basis,
    -COALESCE(original.basis_amount, 0), original.commission_rate,
    -COALESCE(original.commission_amount, 0), original.rule_id,
    original.status, now(), now()
  FROM public.commission_transactions original
  WHERE original.order_id = sale.id
    AND original.transaction_type <> 'order_cancel_reversal'
    AND NOT EXISTS (SELECT 1 FROM public.commission_transactions reversal
      WHERE reversal.id = 'COMM-VOID-' || original.id)
  ON CONFLICT (id) DO NOTHING;

  UPDATE public.orders
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = actor.auth_user_id::text,
      cancellation_reason = btrim(p_reason), updated_at = now(),
      updated_by = actor.auth_user_id::text
  WHERE id = sale.id;

  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('orders', 'AMEND_REVERSE', sale.id, to_jsonb(sale),
    jsonb_build_object('status', 'cancelled', 'reason', btrim(p_reason),
      'debt_reversal_id', reversal_id, 'new_debt', new_balance),
    actor.auth_user_id::text, now());
  RETURN jsonb_build_object('success', true, 'order_id', sale.id,
    'status', 'cancelled', 'new_debt', new_balance);
END;
$$;

-- Finalized orders stay immutable. An amendment atomically cancels/reverses
-- the original order and confirms a replacement using the authoritative
-- pricing RPC. If replacement confirmation fails, the cancellation rolls back.
CREATE OR REPLACE FUNCTION public.rpc_amend_order(
  p_order_id text,
  p_order jsonb,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_variable
DECLARE
  actor public.profiles%ROWTYPE;
  original_order public.orders%ROWTYPE;
  replacement jsonb;
  replacement_id text;
  amendment_key text := NULLIF(btrim(p_order->>'idempotencyKey'), '');
  active_return_count integer;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: only Admin or Accounting may amend a finalized order'
      USING ERRCODE = '42501';
  END IF;
  IF p_order_id IS NULL OR btrim(p_order_id) = '' THEN
    RAISE EXCEPTION 'Original order id is required';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'An amendment reason of at least 3 characters is required';
  END IF;
  IF amendment_key IS NULL THEN
    RAISE EXCEPTION 'A stable amendment idempotency key is required';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('order-amend:' || p_order_id, 0));

  SELECT audit.new_data->>'replacement_order_id'
  INTO replacement_id
  FROM public.audit_logs audit
  WHERE audit.table_name = 'orders'
    AND audit.action = 'AMEND'
    AND audit.record_id = p_order_id
    AND audit.new_data->>'idempotency_key' = amendment_key
  ORDER BY audit.created_at DESC
  LIMIT 1;
  IF replacement_id IS NOT NULL THEN
    RETURN public.p1_order_response(replacement_id) || jsonb_build_object(
      'already_amended', true,
      'original_order_id', p_order_id,
      'replacement_order_id', replacement_id
    );
  END IF;

  SELECT * INTO STRICT original_order
  FROM public.orders
  WHERE id = p_order_id
  FOR UPDATE;
  IF original_order.status <> 'settled' THEN
    RAISE EXCEPTION 'Only a settled order without returns may be amended';
  END IF;

  SELECT count(*) INTO active_return_count
  FROM public.sales_returns sale_return
  WHERE COALESCE(sale_return.sale_id, sale_return.order_id) = original_order.id
    AND sale_return.status NOT IN ('cancelled', 'canceled', 'draft');
  IF active_return_count > 0 THEN
    RAISE EXCEPTION 'Order has active sales returns and cannot be amended';
  END IF;

  PERFORM public.p19_reverse_order_for_amendment(
    original_order.id,
    'Sửa đơn đã chốt: ' || btrim(p_reason)
  );
  replacement := public.rpc_confirm_order((p_order - 'draftId') || jsonb_build_object(
    'amendedFromOrderId', original_order.id
  ));
  replacement_id := replacement->>'order_id';
  IF replacement_id IS NULL THEN
    RAISE EXCEPTION 'Replacement order was not returned by the confirmation transaction';
  END IF;

  INSERT INTO public.audit_logs(
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'orders', 'AMEND', original_order.id, to_jsonb(original_order),
    jsonb_build_object(
      'replacement_order_id', replacement_id,
      'idempotency_key', amendment_key,
      'reason', btrim(p_reason),
      'financial_strategy', 'cancel_original_and_confirm_replacement'
    ),
    actor.auth_user_id::text, now()
  );

  RETURN replacement || jsonb_build_object(
    'already_amended', false,
    'original_order_id', original_order.id,
    'replacement_order_id', replacement_id,
    'amendment_reason', btrim(p_reason)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_record_customer_receipt(text, numeric, text, text, text)
  FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.p19_reverse_order_for_amendment(text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_amend_order(text, jsonb, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_record_customer_receipt(text, numeric, text, text, text)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_amend_order(text, jsonb, text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0019', 'Amend finalized orders with immutable reversals and support customer advance receipts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
