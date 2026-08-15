BEGIN;

DO $migration$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0044') THEN
    RAISE EXCEPTION 'Migration 0045 requires migration 0044';
  END IF;
END
$migration$;

-- Amendment lineage is not a reversal. Keeping it separate preserves the
-- one-real-reversal-per-ledger-entry invariant used by cancellation flows.
ALTER TABLE public.customer_debt_transactions
  ADD COLUMN IF NOT EXISTS amends_ledger_id text;

CREATE INDEX IF NOT EXISTS customer_debt_amends_ledger_idx
  ON public.customer_debt_transactions(amends_ledger_id)
  WHERE amends_ledger_id IS NOT NULL;

UPDATE public.customer_debt_transactions
SET amends_ledger_id = reversal_of_id,
    reversal_of_id = NULL
WHERE transaction_type IN ('payment_amend', 'payment_relink', 'return_amend')
  AND reversal_of_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.rpc_amend_cashbook_transaction(
  p_cashbook_id text,
  p_input jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_variable
DECLARE
  actor public.profiles%ROWTYPE;
  collector public.profiles%ROWTYPE;
  entry public.cashbook_transactions%ROWTYPE;
  updated_entry public.cashbook_transactions%ROWTYPE;
  customer_ledger public.customer_debt_transactions%ROWTYPE;
  customer_payment public.payments%ROWTYPE;
  supplier_payment public.purchase_payments%ROWTYPE;
  return_row public.sales_returns%ROWTYPE;
  sale public.orders%ROWTYPE;
  old_customer public.customers%ROWTYPE;
  new_customer public.customers%ROWTYPE;
  old_supplier public.suppliers%ROWTYPE;
  new_supplier public.suppliers%ROWTYPE;
  operation text;
  next_value numeric;
  next_date timestamptz;
  next_method text;
  next_category text;
  next_partner text;
  next_collector_id text;
  next_collector_name text;
  next_counterparty_type text;
  next_counterparty_id text;
  next_customer_id text;
  next_supplier_id text;
  next_debt_reduction numeric;
  next_sale_paid numeric;
  debt_delta numeric := 0;
  has_customer_ledger boolean := false;
  amendment_reason text := COALESCE(NULLIF(btrim(p_input->>'reason'), ''), 'Sá»­a phiáº¿u thu/chi');
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;

  IF NULLIF(btrim(p_cashbook_id), '') IS NULL THEN
    RAISE EXCEPTION 'Cashbook transaction id is required';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('cashbook-amend:' || btrim(p_cashbook_id), 0));

  SELECT * INTO STRICT entry
  FROM public.cashbook_transactions
  WHERE id = btrim(p_cashbook_id)
  FOR UPDATE;

  IF lower(COALESCE(entry.status, '')) IN ('cancelled', 'canceled', 'Ä‘Ã£ há»§y', 'da huy')
     OR entry.cancelled_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cancelled cashbook transactions cannot be amended';
  END IF;
  IF entry.reversal_of_id IS NOT NULL
     OR lower(COALESCE(entry.transaction_type, '')) LIKE '%reversal%' THEN
    RAISE EXCEPTION 'Reversal cashbook transactions cannot be amended';
  END IF;

  next_value := round(COALESCE(NULLIF(p_input->>'value', '')::numeric, entry.value, 0));
  IF next_value <= 0 THEN RAISE EXCEPTION 'Cashbook value must be positive'; END IF;
  next_method := lower(COALESCE(NULLIF(p_input->>'method', ''), entry.payment_method, entry.method, 'cash'));
  IF next_method NOT IN ('cash', 'bank', 'wallet') THEN
    RAISE EXCEPTION 'Cashbook method must be cash, bank or wallet';
  END IF;
  next_date := COALESCE(NULLIF(p_input->>'transactionDate', '')::timestamptz,
                        entry.transaction_date, entry.date, now());
  next_category := COALESCE(NULLIF(btrim(p_input->>'category'), ''), entry.category, 'KhÃ¡c');
  next_partner := COALESCE(NULLIF(btrim(p_input->>'partner'), ''), entry.partner, 'KhÃ¡c');

  next_collector_id := NULLIF(btrim(p_input->>'collectorId'), '');
  IF next_collector_id IS NOT NULL THEN
    SELECT * INTO collector FROM public.profiles profile
    WHERE next_collector_id IN (profile.id, profile.username, profile.auth_user_id::text)
    ORDER BY CASE WHEN profile.id = next_collector_id THEN 0 ELSE 1 END
    LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'Selected collector is not an active employee'; END IF;
    IF collector.is_active IS NOT TRUE
       AND entry.collector_id IS DISTINCT FROM collector.id
       AND entry.collector_id IS DISTINCT FROM collector.username
       AND entry.collector_id IS DISTINCT FROM collector.auth_user_id::text THEN
      RAISE EXCEPTION 'Selected collector is not an active employee';
    END IF;
    next_collector_id := collector.id;
    next_collector_name := collector.display_name;
  ELSE
    next_collector_id := entry.collector_id;
    next_collector_name := COALESCE(NULLIF(btrim(p_input->>'collectorName'), ''),
                                    entry.collector_name, entry.creator, actor.display_name);
  END IF;

  next_counterparty_type := lower(COALESCE(NULLIF(btrim(p_input->>'counterpartyType'), ''),
    entry.counterparty_type, CASE WHEN entry.customer_id IS NOT NULL THEN 'customer'
      WHEN entry.supplier_id IS NOT NULL THEN 'supplier' ELSE 'other' END));
  IF next_counterparty_type NOT IN ('customer', 'supplier', 'employee', 'other') THEN
    RAISE EXCEPTION 'Unsupported cashbook counterparty type';
  END IF;
  next_counterparty_id := NULLIF(btrim(p_input->>'counterpartyId'), '');
  operation := public.p13_classify_cashbook(entry.id);

  SELECT * INTO customer_ledger
  FROM public.customer_debt_transactions ledger
  WHERE ledger.cashbook_transaction_id = entry.id
    AND ledger.transaction_type = 'payment'
    AND ledger.reversal_of_id IS NULL
  ORDER BY ledger.transaction_date, ledger.created_at
  LIMIT 1
  FOR UPDATE;
  has_customer_ledger := FOUND;

  IF has_customer_ledger OR operation = 'customer_debt_receipt' THEN
    IF NOT has_customer_ledger THEN
      RAISE EXCEPTION 'Customer receipt ledger is missing; reconcile the voucher before amendment';
    END IF;
    IF entry.type <> 'thu' THEN RAISE EXCEPTION 'Customer debt receipts must remain receipt vouchers'; END IF;
    IF next_counterparty_type <> 'customer' THEN
      RAISE EXCEPTION 'Customer debt receipts require a customer counterparty';
    END IF;
    next_customer_id := COALESCE(next_counterparty_id, entry.customer_id, customer_ledger.customer_id);
    IF entry.order_id IS NOT NULL AND next_customer_id IS DISTINCT FROM entry.customer_id THEN
      RAISE EXCEPTION 'An order-linked receipt cannot be moved to another customer';
    END IF;

    SELECT * INTO STRICT old_customer FROM public.customers
    WHERE id = customer_ledger.customer_id FOR UPDATE;
    IF next_customer_id = old_customer.id THEN
      new_customer := old_customer;
      debt_delta := round(entry.value) - next_value;
      IF debt_delta <> 0 THEN
        INSERT INTO public.customer_debt_transactions(
          id, customer_id, transaction_type, amount, debt_change, balance_before,
          balance_after, cashbook_transaction_id, amends_ledger_id, description,
          created_by, transaction_date
        ) VALUES (
          'DTX-CB-AMEND-' || gen_random_uuid()::text, old_customer.id, 'payment_amend',
          abs(debt_delta), debt_delta, round(COALESCE(old_customer.debt, 0)),
          round(COALESCE(old_customer.debt, 0)) + debt_delta, entry.id,
          customer_ledger.id, amendment_reason, actor.auth_user_id::text, next_date
        );
        UPDATE public.customers SET debt = round(COALESCE(debt, 0)) + debt_delta,
          last_payment_at = GREATEST(COALESCE(last_payment_at, next_date), next_date),
          updated_at = now(), updated_by = actor.auth_user_id::text
        WHERE id = old_customer.id;
      END IF;
    ELSE
      SELECT * INTO STRICT new_customer FROM public.customers
      WHERE id = next_customer_id AND COALESCE(status, 'active') = 'active'
        AND deleted_at IS NULL FOR UPDATE;
      INSERT INTO public.customer_debt_transactions(
        id, customer_id, transaction_type, amount, debt_change, balance_before,
        balance_after, cashbook_transaction_id, amends_ledger_id, description,
        created_by, transaction_date
      ) VALUES
        ('DTX-CB-RELINK-OLD-' || gen_random_uuid()::text, old_customer.id, 'payment_relink',
         round(entry.value), round(entry.value), round(COALESCE(old_customer.debt, 0)),
         round(COALESCE(old_customer.debt, 0)) + round(entry.value), entry.id,
         customer_ledger.id, amendment_reason, actor.auth_user_id::text, next_date),
        ('DTX-CB-RELINK-NEW-' || gen_random_uuid()::text, new_customer.id, 'payment_relink',
         next_value, -next_value, round(COALESCE(new_customer.debt, 0)),
         round(COALESCE(new_customer.debt, 0)) - next_value, entry.id,
         customer_ledger.id, amendment_reason, actor.auth_user_id::text, next_date);
      UPDATE public.customers SET debt = round(COALESCE(debt, 0)) + round(entry.value),
        updated_at = now(), updated_by = actor.auth_user_id::text WHERE id = old_customer.id;
      UPDATE public.customers SET debt = round(COALESCE(debt, 0)) - next_value,
        last_payment_at = GREATEST(COALESCE(last_payment_at, next_date), next_date),
        updated_at = now(), updated_by = actor.auth_user_id::text WHERE id = new_customer.id;
    END IF;

    SELECT * INTO customer_payment FROM public.payments payment
    WHERE payment.cashbook_transaction_id = entry.id AND payment.status = 'completed'
    ORDER BY payment.created_at LIMIT 1 FOR UPDATE;
    IF FOUND THEN
      UPDATE public.payments SET customer_id = next_customer_id, amount = next_value,
        payment_method = next_method, updated_by = actor.auth_user_id::text
      WHERE id = customer_payment.id;
    END IF;
    next_partner := new_customer.name;
    next_counterparty_id := next_customer_id;

  ELSIF operation = 'sale_receipt' OR entry.order_id IS NOT NULL THEN
    IF entry.type <> 'thu' THEN RAISE EXCEPTION 'Sale receipts must remain receipt vouchers'; END IF;
    IF next_counterparty_type <> 'customer' THEN
      RAISE EXCEPTION 'Sale receipts require a customer counterparty';
    END IF;

    SELECT * INTO customer_payment FROM public.payments payment
    WHERE payment.cashbook_transaction_id = entry.id AND payment.status = 'completed'
    ORDER BY payment.created_at LIMIT 1 FOR UPDATE;
    SELECT * INTO STRICT sale FROM public.orders order_row
    WHERE order_row.id = COALESCE(entry.order_id, customer_payment.order_id)
    FOR UPDATE;
    next_customer_id := COALESCE(next_counterparty_id, entry.customer_id, sale.customer_id);
    IF sale.customer_id IS NULL OR next_customer_id IS DISTINCT FROM sale.customer_id THEN
      RAISE EXCEPTION 'An order-linked receipt cannot be moved to another customer';
    END IF;

    SELECT * INTO STRICT old_customer FROM public.customers
    WHERE id = sale.customer_id FOR UPDATE;
    new_customer := old_customer;
    next_sale_paid := round(COALESCE(sale.paid_amount, 0)) - round(entry.value) + next_value;
    IF next_sale_paid < 0
       OR next_sale_paid > round(COALESCE(sale.total_amount, sale.total_payable, 0)) THEN
      RAISE EXCEPTION 'Amended receipt would make the order paid amount invalid';
    END IF;
    debt_delta := round(entry.value) - next_value;
    IF round(COALESCE(old_customer.debt, 0)) + debt_delta < 0 THEN
      RAISE EXCEPTION 'Amended receipt exceeds the customer debt available for this order';
    END IF;
    IF debt_delta <> 0 THEN
      INSERT INTO public.customer_debt_transactions(
        id, customer_id, transaction_type, amount, debt_change, balance_before,
        balance_after, order_id, cashbook_transaction_id, description,
        created_by, transaction_date
      ) VALUES (
        'DTX-SALE-AMEND-' || gen_random_uuid()::text, old_customer.id,
        'sale_payment_amend', abs(debt_delta), debt_delta,
        round(COALESCE(old_customer.debt, 0)),
        round(COALESCE(old_customer.debt, 0)) + debt_delta,
        sale.id, entry.id, amendment_reason, actor.auth_user_id::text, next_date
      );
      UPDATE public.customers
      SET debt = round(COALESCE(debt, 0)) + debt_delta,
          last_payment_at = GREATEST(COALESCE(last_payment_at, next_date), next_date),
          updated_at = now(), updated_by = actor.auth_user_id::text
      WHERE id = old_customer.id;
    END IF;
    UPDATE public.orders
    SET paid_amount = next_sale_paid,
        debt_amount = round(COALESCE(total_amount, total_payable, 0)) - next_sale_paid,
        updated_at = now(), updated_by = actor.auth_user_id::text
    WHERE id = sale.id;
    IF customer_payment.id IS NOT NULL THEN
      UPDATE public.payments
      SET customer_id = old_customer.id, order_id = sale.id, amount = next_value,
          payment_method = next_method, updated_by = actor.auth_user_id::text
      WHERE id = customer_payment.id;
    END IF;
    next_partner := old_customer.name;
    next_counterparty_id := old_customer.id;

  ELSIF operation IN ('supplier_payment', 'purchase_payment')
        OR entry.purchase_payment_id IS NOT NULL THEN
    IF entry.type <> 'chi' THEN RAISE EXCEPTION 'Supplier payments must remain payment vouchers'; END IF;
    IF next_counterparty_type <> 'supplier' THEN
      RAISE EXCEPTION 'Supplier payments require a supplier counterparty';
    END IF;
    SELECT * INTO STRICT supplier_payment FROM public.purchase_payments payment
    WHERE payment.id = entry.purchase_payment_id OR payment.cashbook_transaction_id = entry.id
    ORDER BY payment.created_at LIMIT 1 FOR UPDATE;
    next_supplier_id := COALESCE(next_counterparty_id, entry.supplier_id, supplier_payment.supplier_id);
    IF supplier_payment.purchase_id IS NOT NULL
       AND next_supplier_id IS DISTINCT FROM supplier_payment.supplier_id THEN
      RAISE EXCEPTION 'A purchase-linked payment cannot be moved to another supplier';
    END IF;
    SELECT * INTO STRICT old_supplier FROM public.suppliers
    WHERE id = supplier_payment.supplier_id FOR UPDATE;
    IF next_supplier_id = old_supplier.id THEN
      new_supplier := old_supplier;
      IF next_value > round(COALESCE(old_supplier.debt, 0)) + round(entry.value) THEN
        RAISE EXCEPTION 'Amended supplier payment exceeds available supplier debt';
      END IF;
      debt_delta := round(entry.value) - next_value;
      IF debt_delta <> 0 THEN
        INSERT INTO public.supplier_debt_transactions(
          id, supplier_id, purchase_id, payment_id, transaction_type,
          amount_change, balance_after, notes, created_by, transaction_date
        ) VALUES (
          'SDL-CB-AMEND-' || gen_random_uuid()::text, old_supplier.id,
          supplier_payment.purchase_id, supplier_payment.id, 'supplier_payment_amend',
          debt_delta, round(COALESCE(old_supplier.debt, 0)) + debt_delta,
          amendment_reason, actor.auth_user_id::text, next_date
        );
      END IF;
    ELSE
      SELECT * INTO STRICT new_supplier FROM public.suppliers
      WHERE id = next_supplier_id AND is_active = true FOR UPDATE;
      IF next_value > round(COALESCE(new_supplier.debt, 0)) THEN
        RAISE EXCEPTION 'Amended payment exceeds the new supplier debt';
      END IF;
      INSERT INTO public.supplier_debt_transactions(
        id, supplier_id, purchase_id, payment_id, transaction_type,
        amount_change, balance_after, notes, created_by, transaction_date
      ) VALUES
        ('SDL-CB-RELINK-OLD-' || gen_random_uuid()::text, old_supplier.id, NULL,
         supplier_payment.id, 'supplier_payment_relink', round(entry.value),
         round(COALESCE(old_supplier.debt, 0)) + round(entry.value), amendment_reason,
         actor.auth_user_id::text, next_date),
        ('SDL-CB-RELINK-NEW-' || gen_random_uuid()::text, new_supplier.id, NULL,
         supplier_payment.id, 'supplier_payment_relink', -next_value,
         round(COALESCE(new_supplier.debt, 0)) - next_value, amendment_reason,
         actor.auth_user_id::text, next_date);
    END IF;
    UPDATE public.purchase_payments SET supplier_id = next_supplier_id,
      amount = next_value, payment_method = next_method,
      notes = COALESCE(p_input->>'note', '')
    WHERE id = supplier_payment.id;
    IF supplier_payment.purchase_id IS NOT NULL THEN
      PERFORM public.p4_recompute_purchase(supplier_payment.purchase_id);
    END IF;
    PERFORM public.p4_recompute_supplier(old_supplier.id);
    IF next_supplier_id IS DISTINCT FROM old_supplier.id THEN
      PERFORM public.p4_recompute_supplier(next_supplier_id);
    END IF;
    next_partner := new_supplier.name;
    next_counterparty_id := next_supplier_id;

  ELSIF entry.transaction_type = 'sales_return_refund'
        OR entry.sales_return_id IS NOT NULL THEN
    IF entry.type <> 'chi' THEN RAISE EXCEPTION 'Sales-return refunds must remain payment vouchers'; END IF;
    SELECT * INTO STRICT return_row FROM public.sales_returns
    WHERE id = COALESCE(entry.sales_return_id, entry.external_reference) FOR UPDATE;
    IF next_counterparty_type <> 'customer'
       OR next_counterparty_id IS DISTINCT FROM return_row.customer_id THEN
      RAISE EXCEPTION 'A return refund must remain linked to the order customer';
    END IF;
    IF next_value > round(COALESCE(NULLIF(return_row.total_refund, 0), return_row.total_return_amount, 0)) THEN
      RAISE EXCEPTION 'Cash refund cannot exceed the total return amount';
    END IF;
    SELECT * INTO STRICT old_customer FROM public.customers
    WHERE id = return_row.customer_id FOR UPDATE;
    next_debt_reduction := round(COALESCE(NULLIF(return_row.total_refund, 0),
                                         return_row.total_return_amount, 0)) - next_value;
    IF next_debt_reduction > round(COALESCE(old_customer.debt, 0))
                              + round(COALESCE(return_row.debt_reduction_amount, 0)) THEN
      RAISE EXCEPTION 'Amendment would reduce more customer debt than was available before the return';
    END IF;
    debt_delta := round(COALESCE(return_row.debt_reduction_amount, 0)) - next_debt_reduction;
    IF debt_delta <> 0 THEN
      INSERT INTO public.customer_debt_transactions(
        id, customer_id, transaction_type, amount, debt_change, balance_before,
        balance_after, sales_return_id, order_id, cashbook_transaction_id,
        amends_ledger_id, description, created_by, transaction_date
      ) VALUES (
        'DTX-RET-AMEND-' || gen_random_uuid()::text, old_customer.id, 'return_amend',
        abs(debt_delta), debt_delta, round(COALESCE(old_customer.debt, 0)),
        round(COALESCE(old_customer.debt, 0)) + debt_delta, return_row.id,
        return_row.order_id, entry.id, return_row.debt_ledger_id,
        amendment_reason, actor.auth_user_id::text, next_date
      );
      UPDATE public.customers SET debt = round(COALESCE(debt, 0)) + debt_delta,
        updated_at = now(), updated_by = actor.auth_user_id::text
      WHERE id = old_customer.id;
    END IF;
    UPDATE public.sales_returns SET refund_amount = next_value,
      debt_reduction_amount = next_debt_reduction, updated_at = now(),
      updated_by = actor.auth_user_id::text WHERE id = return_row.id;
    next_partner := old_customer.name;
    next_counterparty_type := 'customer';
    next_counterparty_id := old_customer.id;
  END IF;

  -- Voucher direction is immutable: receipt and payment editing are separate flows.
  UPDATE public.cashbook_transactions
  SET date = next_date,
      transaction_date = next_date,
      category = next_category,
      partner = next_partner,
      customer_id = CASE WHEN has_customer_ledger OR operation = 'sale_receipt'
                         OR order_id IS NOT NULL THEN next_customer_id ELSE customer_id END,
      supplier_id = CASE WHEN operation IN ('supplier_payment', 'purchase_payment')
                         OR purchase_payment_id IS NOT NULL THEN next_supplier_id ELSE supplier_id END,
      value = next_value,
      method = next_method,
      payment_method = next_method,
      accounting = COALESCE((p_input->>'accounting')::boolean, accounting, true),
      note = COALESCE(p_input->>'note', note, ''),
      collector_id = next_collector_id,
      collector_name = next_collector_name,
      counterparty_type = next_counterparty_type,
      counterparty_id = next_counterparty_id,
      amended_at = now(),
      amendment_count = COALESCE(amendment_count, 0) + 1,
      updated_by = actor.auth_user_id::text
  WHERE id = entry.id
  RETURNING * INTO updated_entry;

  INSERT INTO public.audit_logs(
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'cashbook_transactions', 'AMEND', entry.id, to_jsonb(entry),
    to_jsonb(updated_entry) || jsonb_build_object(
      'operation_type', operation,
      'reason', amendment_reason,
      'financial_strategy', CASE
        WHEN has_customer_ledger THEN 'append_customer_debt_adjustment'
        WHEN operation = 'sale_receipt' OR entry.order_id IS NOT NULL
          THEN 'append_sale_receipt_debt_adjustment'
        WHEN operation IN ('supplier_payment', 'purchase_payment')
          OR entry.purchase_payment_id IS NOT NULL THEN 'append_supplier_debt_adjustment'
        WHEN entry.transaction_type = 'sales_return_refund'
          OR entry.sales_return_id IS NOT NULL THEN 'rebalance_return_debt_and_cash'
        ELSE 'cashbook_metadata_and_value_only'
      END
    ), actor.auth_user_id::text, now()
  );

  RETURN public.p2_cashbook_response(entry.id) || jsonb_build_object(
    'amended', true,
    'operation_type', operation,
    'customer_id', updated_entry.customer_id,
    'supplier_id', updated_entry.supplier_id,
    'collector_id', updated_entry.collector_id,
    'collector_name', updated_entry.collector_name,
    'counterparty_type', updated_entry.counterparty_type,
    'counterparty_id', updated_entry.counterparty_id,
    'performed_by', actor.auth_user_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_amend_cashbook_transaction(text, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_amend_cashbook_transaction(text, jsonb)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0045', 'Separate cashbook amendment lineage from financial reversal lineage')
ON CONFLICT (version) DO NOTHING;

NOTIFY pgrst, 'reload schema';

COMMIT;

