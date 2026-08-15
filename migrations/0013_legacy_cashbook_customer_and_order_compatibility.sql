BEGIN;

-- Compatibility only: preserve historical rows and make their business type explicit
-- when it can be inferred from a strong relational link.
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS operation_type text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS reference_type text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS reference_id text;

CREATE INDEX IF NOT EXISTS cashbook_operation_type_idx
  ON public.cashbook_transactions(operation_type);
CREATE INDEX IF NOT EXISTS cashbook_reference_idx
  ON public.cashbook_transactions(reference_type, reference_id);

-- Strong-link backfill only. Uncertain rows stay NULL and are classified at runtime.
UPDATE public.cashbook_transactions cb
SET operation_type = 'customer_debt_receipt',
    reference_type = 'customer',
    reference_id = cb.customer_id
WHERE cb.operation_type IS NULL
  AND EXISTS (
    SELECT 1 FROM public.customer_debt_transactions debt
    WHERE debt.cashbook_transaction_id = cb.id
      AND debt.transaction_type = 'payment'
      AND debt.reversal_of_id IS NULL
  );

UPDATE public.cashbook_transactions cb
SET operation_type = 'supplier_payment',
    reference_type = CASE WHEN cb.purchase_id IS NULL THEN 'supplier' ELSE 'purchase' END,
    reference_id = COALESCE(cb.purchase_id, cb.supplier_id)
WHERE cb.operation_type IS NULL
  AND (
    cb.purchase_payment_id IS NOT NULL
    OR EXISTS (SELECT 1 FROM public.purchase_payments payment
      WHERE payment.cashbook_transaction_id = cb.id)
  );

UPDATE public.cashbook_transactions cb
SET operation_type = 'sale_receipt',
    reference_type = 'order',
    reference_id = cb.order_id
WHERE cb.operation_type IS NULL AND cb.order_id IS NOT NULL;

UPDATE public.cashbook_transactions cb
SET operation_type = CASE WHEN lower(COALESCE(cb.type, '')) = 'thu'
    THEN 'other_receipt' ELSE 'other_payment' END
WHERE cb.operation_type IS NULL
  AND cb.transaction_type IN ('manual_thu', 'manual_chi');

CREATE OR REPLACE FUNCTION public.p13_classify_cashbook(p_cashbook_id text)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  entry public.cashbook_transactions%ROWTYPE;
  haystack text;
BEGIN
  SELECT * INTO STRICT entry FROM public.cashbook_transactions WHERE id = p_cashbook_id;
  IF entry.operation_type IN (
    'customer_debt_receipt', 'sale_receipt', 'other_receipt',
    'supplier_payment', 'purchase_payment', 'other_payment'
  ) THEN
    RETURN entry.operation_type;
  END IF;

  -- Exact relational evidence always wins over labels copied from an old UI.
  IF EXISTS (SELECT 1 FROM public.customer_debt_transactions d
    WHERE d.cashbook_transaction_id = entry.id
      AND d.transaction_type = 'payment' AND d.reversal_of_id IS NULL) THEN
    RETURN 'customer_debt_receipt';
  END IF;
  IF entry.purchase_payment_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.purchase_payments p WHERE p.cashbook_transaction_id = entry.id
  ) THEN
    RETURN 'supplier_payment';
  END IF;
  IF entry.order_id IS NOT NULL OR EXISTS (
    SELECT 1 FROM public.payments p
    WHERE p.cashbook_transaction_id = entry.id AND p.order_id IS NOT NULL
  ) THEN
    RETURN 'sale_receipt';
  END IF;

  haystack := lower(concat_ws(' ', entry.transaction_type, entry.category, entry.note));
  -- Some legacy sale receipts were incorrectly labelled "Thu nợ khách hàng".
  IF entry.type = 'thu' AND (
    haystack LIKE '%thu tiền hàng%' OR haystack LIKE '%thu bán hàng%'
    OR haystack LIKE '%sale receipt%'
  ) THEN RETURN 'sale_receipt'; END IF;

  IF entry.type = 'thu' AND entry.customer_id IS NOT NULL AND (
    entry.transaction_type = 'customer_payment'
    OR haystack LIKE '%thu nợ khách hàng%'
    OR haystack LIKE '%customer debt%'
  ) THEN RETURN 'customer_debt_receipt'; END IF;

  IF entry.type = 'chi' AND entry.supplier_id IS NOT NULL AND (
    entry.transaction_type = 'supplier_payment'
    OR haystack LIKE '%trả nhà cung cấp%'
    OR haystack LIKE '%supplier payment%'
  ) THEN RETURN 'supplier_payment'; END IF;
  IF entry.type = 'chi' AND entry.purchase_id IS NOT NULL THEN RETURN 'purchase_payment'; END IF;
  RETURN CASE WHEN entry.type = 'thu' THEN 'other_receipt' ELSE 'other_payment' END;
END;
$$;

CREATE OR REPLACE FUNCTION public.p2_cashbook_response(p_cashbook_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'success', true, 'cashbook_id', entry.id,
    'operation_type', public.p13_classify_cashbook(entry.id),
    'transaction', jsonb_build_object(
      'id', entry.id, 'cloudId', entry.id,
      'date', COALESCE(entry.transaction_date, entry.date),
      'type', entry.type, 'transactionType', entry.transaction_type,
      'operationType', public.p13_classify_cashbook(entry.id),
      'referenceType', entry.reference_type, 'referenceId', entry.reference_id,
      'direction', entry.direction, 'category', entry.category,
      'partner', entry.partner, 'customerId', entry.customer_id,
      'supplierId', entry.supplier_id, 'orderId', entry.order_id,
      'purchaseId', entry.purchase_id, 'purchasePaymentId', entry.purchase_payment_id,
      'value', entry.value, 'method', COALESCE(entry.payment_method, entry.method),
      'accounting', entry.accounting, 'status', entry.status,
      'creator', entry.creator, 'createdBy', entry.created_by, 'note', entry.note,
      'starred', entry.starred, 'reversalOfId', entry.reversal_of_id,
      'cancelledAt', entry.cancelled_at, 'cancellationReason', entry.cancellation_reason
    )
  ) FROM public.cashbook_transactions entry WHERE entry.id = p_cashbook_id
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_cashbook_entry(
  p_cashbook_id text, p_reason text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  entry public.cashbook_transactions%ROWTYPE;
  operation text;
  original_customer_ledger public.customer_debt_transactions%ROWTYPE;
  customer_balance numeric;
  supplier_balance numeric;
  debt_delta numeric := 0;
  supplier_payment_id text;
  reversal_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: Không đủ quyền hủy phiếu sổ quỹ' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(btrim(COALESCE(p_reason, '')), '') IS NULL THEN
    p_reason := 'Hủy phiếu sổ quỹ';
  END IF;
  SELECT * INTO STRICT entry FROM public.cashbook_transactions
  WHERE id = p_cashbook_id FOR UPDATE;
  IF entry.reversal_of_id IS NOT NULL THEN
    RAISE EXCEPTION 'Không thể hủy một giao dịch đảo';
  END IF;
  operation := public.p13_classify_cashbook(entry.id);
  IF entry.status IN ('cancelled', 'canceled', 'Đã hủy', 'Da huy') THEN
    RETURN public.p2_cashbook_response(entry.id)
      || jsonb_build_object('already_cancelled', true, 'cancellation_route', operation);
  END IF;

  -- Delegate fully linked supplier payments to the Phase 4 atomic flow.
  SELECT p.id INTO supplier_payment_id
  FROM public.purchase_payments p
  WHERE p.id = entry.purchase_payment_id OR p.cashbook_transaction_id = entry.id
  ORDER BY CASE WHEN p.id = entry.purchase_payment_id THEN 0 ELSE 1 END LIMIT 1;
  IF operation = 'supplier_payment' AND supplier_payment_id IS NOT NULL THEN
    RETURN public.rpc_cancel_supplier_payment(supplier_payment_id, p_reason)
      || jsonb_build_object('cancellation_route', operation);
  END IF;

  IF operation = 'customer_debt_receipt' THEN
    IF entry.customer_id IS NULL THEN
      RAISE EXCEPTION 'Phiếu thu nợ cũ thiếu khách hàng liên kết; không thể hoàn tác an toàn';
    END IF;
    SELECT * INTO original_customer_ledger
    FROM public.customer_debt_transactions d
    WHERE d.cashbook_transaction_id = entry.id
      AND d.transaction_type = 'payment' AND d.reversal_of_id IS NULL
    ORDER BY d.transaction_date LIMIT 1 FOR UPDATE;
    IF original_customer_ledger.id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.customer_debt_transactions r
      WHERE r.reversal_of_id = original_customer_ledger.id
    ) THEN
      RETURN public.p2_cashbook_response(entry.id)
        || jsonb_build_object('already_cancelled', true, 'cancellation_route', operation);
    END IF;
    SELECT COALESCE(debt, 0) INTO STRICT customer_balance
    FROM public.customers WHERE id = entry.customer_id FOR UPDATE;
    debt_delta := CASE WHEN original_customer_ledger.id IS NULL
      THEN COALESCE(entry.value, 0)
      ELSE -COALESCE(original_customer_ledger.debt_change, -entry.value) END;
    INSERT INTO public.customer_debt_transactions(
      id, customer_id, transaction_type, amount, debt_change,
      balance_before, balance_after, cashbook_transaction_id, reversal_of_id,
      description, created_by, transaction_date
    ) VALUES (
      'DTX-P13-VOID-' || entry.id, entry.customer_id, 'payment_cancel',
      ABS(debt_delta), debt_delta, customer_balance, customer_balance + debt_delta,
      entry.id, original_customer_ledger.id,
      'Hủy phiếu thu nợ ' || entry.id || ': ' || btrim(p_reason),
      actor.auth_user_id::text, now()
    ) ON CONFLICT (id) DO NOTHING;
    UPDATE public.customers SET debt = customer_balance + debt_delta,
      updated_at = now(), updated_by = actor.auth_user_id::text
    WHERE id = entry.customer_id;
    UPDATE public.payments SET status = 'cancelled', cancelled_at = now(),
      cancelled_by = actor.auth_user_id::text, cancellation_reason = btrim(p_reason),
      updated_by = actor.auth_user_id::text
    WHERE cashbook_transaction_id = entry.id AND status = 'completed';
  ELSIF operation = 'supplier_payment' THEN
    IF entry.supplier_id IS NULL THEN
      RAISE EXCEPTION 'Phiếu chi nhà cung cấp cũ thiếu liên kết; không thể hoàn tác an toàn';
    END IF;
    SELECT COALESCE(debt, 0) INTO STRICT supplier_balance
    FROM public.suppliers WHERE id = entry.supplier_id FOR UPDATE;
    INSERT INTO public.supplier_debt_transactions(
      id, supplier_id, purchase_id, transaction_type, amount_change,
      balance_after, notes, created_by, transaction_date
    ) VALUES (
      'SDL-P13-VOID-' || entry.id, entry.supplier_id, entry.purchase_id,
      'supplier_payment_reversal', COALESCE(entry.value, 0),
      supplier_balance + COALESCE(entry.value, 0), btrim(p_reason),
      actor.auth_user_id::text, now()
    ) ON CONFLICT (id) DO NOTHING;
    UPDATE public.suppliers SET debt = supplier_balance + COALESCE(entry.value, 0),
      total_paid = GREATEST(0, COALESCE(total_paid, 0) - COALESCE(entry.value, 0)),
      updated_at = now(), updated_by = actor.auth_user_id::text
    WHERE id = entry.supplier_id;
  END IF;

  UPDATE public.cashbook_transactions SET status = 'cancelled', cancelled_at = now(),
    cancelled_by = actor.auth_user_id::text, cancellation_reason = btrim(p_reason),
    operation_type = operation, updated_by = actor.auth_user_id::text
  WHERE id = entry.id;
  reversal_id := 'VOID-' || entry.id;
  INSERT INTO public.cashbook_transactions(
    id, date, transaction_date, type, transaction_type, operation_type,
    reference_type, reference_id, direction, category, partner,
    customer_id, supplier_id, order_id, purchase_id, purchase_payment_id,
    value, method, payment_method, accounting, status, creator, created_by,
    note, starred, reversal_of_id
  ) VALUES (
    reversal_id, now(), now(), CASE WHEN entry.type = 'thu' THEN 'chi' ELSE 'thu' END,
    'cashbook_reversal', CASE WHEN entry.type = 'thu' THEN 'other_payment' ELSE 'other_receipt' END,
    'cashbook', entry.id, CASE WHEN entry.type = 'thu' THEN 'out' ELSE 'in' END,
    'Đảo ' || COALESCE(entry.category, 'giao dịch'), entry.partner,
    entry.customer_id, entry.supplier_id, entry.order_id, entry.purchase_id,
    entry.purchase_payment_id, entry.value, entry.method, entry.payment_method,
    false, 'cancelled', actor.display_name, actor.auth_user_id::text,
    btrim(p_reason), false, entry.id
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('cashbook_transactions', 'CANCEL', entry.id, to_jsonb(entry),
    jsonb_build_object('operation_type', operation, 'reversal_id', reversal_id,
      'customer_debt_change', debt_delta, 'reason', btrim(p_reason)),
    actor.auth_user_id::text, now());
  RETURN public.p2_cashbook_response(entry.id) || jsonb_build_object(
    'already_cancelled', false, 'cancellation_route', operation,
    'customer_id', entry.customer_id, 'supplier_id', entry.supplier_id,
    'new_debt', CASE WHEN entry.customer_id IS NULL THEN NULL
      ELSE (SELECT debt FROM public.customers WHERE id = entry.customer_id) END,
    'supplier_debt', CASE WHEN entry.supplier_id IS NULL THEN NULL
      ELSE (SELECT debt FROM public.suppliers WHERE id = entry.supplier_id) END,
    'reversal_id', reversal_id, 'performed_by', actor.auth_user_id::text
  );
END;
$$;

-- Backward-compatible entry points used by older cached frontends.
CREATE OR REPLACE FUNCTION public.rpc_cancel_cashbook_transaction(p_cashbook_id text, p_reason text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT public.rpc_cancel_cashbook_entry(p_cashbook_id, p_reason) $$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_customer_payment(p_cashbook_id text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$ SELECT public.rpc_cancel_cashbook_entry(p_cashbook_id, 'Hủy phiếu thu công nợ') $$;

-- Cancelling a paid order keeps independent receipts intact. The remaining order
-- charge is reversed; any resulting negative debt is valid customer advance/credit.
CREATE OR REPLACE FUNCTION public.rpc_cancel_order(p_order_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  sale public.orders%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  charge public.customer_debt_transactions%ROWTYPE;
  original_charge numeric := 0;
  active_return_value numeric := 0;
  return_debt_effect numeric := 0;
  remaining_charge numeric := 0;
  new_balance numeric;
  reversal_id text;
  commission_original public.commission_transactions%ROWTYPE;
  commission_remaining numeric;
  basis_remaining numeric;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: Không đủ quyền hủy đơn' USING ERRCODE = '42501';
  END IF;
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'Vui lòng nhập lý do hủy đơn';
  END IF;
  SELECT * INTO STRICT sale FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF sale.status IN ('cancelled', 'canceled') THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true,
      'order_id', sale.id, 'status', sale.status);
  END IF;
  IF sale.status NOT IN ('settled', 'partially_returned', 'returned') THEN
    RAISE EXCEPTION 'Chỉ có thể hủy đơn đã chốt';
  END IF;

  SELECT COALESCE(sum(COALESCE(NULLIF(r.total_refund, 0), r.total_return_amount, 0)), 0)
  INTO active_return_value FROM public.sales_returns r
  WHERE r.sale_id = sale.id AND r.status NOT IN ('cancelled', 'canceled');

  IF sale.customer_id IS NOT NULL THEN
    SELECT * INTO customer_row FROM public.customers
    WHERE id = sale.customer_id FOR UPDATE;
    IF customer_row.id IS NULL THEN
      RAISE EXCEPTION 'Đơn hàng thiếu hồ sơ khách hàng liên kết';
    END IF;
    SELECT * INTO charge FROM public.customer_debt_transactions d
    WHERE d.order_id = sale.id AND d.transaction_type = 'order'
      AND d.reversal_of_id IS NULL ORDER BY d.transaction_date LIMIT 1 FOR UPDATE;
    original_charge := CASE WHEN charge.id IS NOT NULL THEN COALESCE(charge.debt_change, 0)
      ELSE COALESCE(NULLIF(sale.total_payable, 0), sale.total_amount, 0) END;
    SELECT COALESCE(sum(d.debt_change), 0) INTO return_debt_effect
    FROM public.customer_debt_transactions d
    WHERE d.order_id = sale.id AND d.transaction_type = 'return'
      AND NOT EXISTS (SELECT 1 FROM public.customer_debt_transactions x
        WHERE x.reversal_of_id = d.id);
    remaining_charge := GREATEST(0, original_charge + return_debt_effect);
    new_balance := COALESCE(customer_row.debt, 0) - remaining_charge;
    IF remaining_charge <> 0 THEN
      reversal_id := 'DTX-P13-ORDER-VOID-' || sale.id;
      INSERT INTO public.customer_debt_transactions(
        id, customer_id, transaction_type, amount, debt_change,
        balance_before, balance_after, order_id, reversal_of_id,
        description, created_by, transaction_date
      ) VALUES (
        reversal_id, sale.customer_id, 'order_cancel', remaining_charge,
        -remaining_charge, customer_row.debt, new_balance, sale.id, charge.id,
        'Hủy đơn ' || sale.id || ': ' || btrim(p_reason),
        actor.auth_user_id::text, now()
      ) ON CONFLICT (id) DO NOTHING;
    END IF;
    UPDATE public.customers SET debt = new_balance,
      total_transaction = GREATEST(0, COALESCE(total_transaction, 0) - COALESCE(sale.total_payable, sale.total_amount, 0)),
      total_return = GREATEST(0, COALESCE(total_return, 0) - active_return_value),
      net_revenue = GREATEST(0, COALESCE(net_revenue, 0)
        - GREATEST(0, COALESCE(sale.total_payable, sale.total_amount, 0) - active_return_value)),
      updated_at = now(), updated_by = actor.auth_user_id::text
    WHERE id = sale.customer_id;
  END IF;

  -- Reverse only the commission still active after any prior return reversals.
  FOR commission_original IN
    SELECT c.* FROM public.commission_transactions c
    WHERE c.order_id = sale.id
      AND c.transaction_type NOT IN ('order_cancel_reversal', 'sales_return_reversal', 'sales_return_cancel_reversal')
  LOOP
    SELECT COALESCE(commission_original.commission_amount, 0) + COALESCE(sum(c.commission_amount), 0),
           COALESCE(commission_original.basis_amount, 0) + COALESCE(sum(c.basis_amount), 0)
    INTO commission_remaining, basis_remaining
    FROM public.commission_transactions c
    WHERE c.order_id = sale.id
      AND c.transaction_type IN ('sales_return_reversal', 'sales_return_cancel_reversal')
      AND right(c.id, length(commission_original.id) + 1) = '-' || commission_original.id;
    IF commission_remaining <> 0 OR basis_remaining <> 0 THEN
      INSERT INTO public.commission_transactions(
        id, employee_id, salary_period, order_id, transaction_type,
        calculation_basis, basis_amount, commission_rate, commission_amount,
        rule_id, status, calculated_at, created_at
      ) VALUES (
        'COMM-P13-VOID-' || commission_original.id, commission_original.employee_id,
        commission_original.salary_period, sale.id, 'order_cancel_reversal',
        commission_original.calculation_basis, -basis_remaining,
        commission_original.commission_rate, -commission_remaining,
        commission_original.rule_id, commission_original.status, now(), now()
      ) ON CONFLICT (id) DO NOTHING;
    END IF;
  END LOOP;

  UPDATE public.orders SET status = 'cancelled', cancelled_at = now(),
    cancelled_by = actor.auth_user_id::text, cancellation_reason = btrim(p_reason),
    updated_at = now(), updated_by = actor.auth_user_id::text
  WHERE id = sale.id;
  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('orders', 'CANCEL', sale.id, to_jsonb(sale),
    jsonb_build_object('status', 'cancelled', 'reason', btrim(p_reason),
      'debt_reversal_id', reversal_id, 'remaining_order_charge', remaining_charge,
      'customer_balance', new_balance, 'customer_credit', GREATEST(-COALESCE(new_balance, 0), 0),
      'independent_payments_preserved', true), actor.auth_user_id::text, now());
  RETURN jsonb_build_object('success', true, 'already_cancelled', false,
    'order_id', sale.id, 'status', 'cancelled', 'customer_id', sale.customer_id,
    'new_debt', new_balance, 'customer_credit', GREATEST(-COALESCE(new_balance, 0), 0),
    'debt_change', -remaining_charge, 'payments_preserved', true,
    'cancelled_by', actor.auth_user_id::text, 'cancellation_reason', btrim(p_reason));
END;
$$;

REVOKE ALL ON FUNCTION public.p13_classify_cashbook(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_cancel_cashbook_entry(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_cashbook_transaction(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_customer_payment(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_order(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_cashbook_entry(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_cashbook_transaction(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_customer_payment(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_order(text, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0013', 'Legacy cashbook classification, customer profile and paid-order cancellation compatibility')
ON CONFLICT (version) DO NOTHING;

COMMIT;
