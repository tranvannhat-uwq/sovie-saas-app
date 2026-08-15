BEGIN;

-- Older frontends could persist a debt receipt as a standalone manual cashbook
-- row. Repair is deliberately explicit: an Admin/Accounting user selects the
-- exact voucher and customer, and this RPC atomically creates the missing
-- payment/ledger links and applies the debt change exactly once.
CREATE OR REPLACE FUNCTION public.rpc_reconcile_legacy_customer_receipt(
  p_cashbook_id text,
  p_customer_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  entry public.cashbook_transactions%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  existing_ledger public.customer_debt_transactions%ROWTYPE;
  existing_payment_id text;
  payment_id text;
  ledger_id text;
  reconcile_key text;
  request_hash text;
  new_balance numeric;
  haystack text;
  normalized_partner text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO STRICT entry
  FROM public.cashbook_transactions
  WHERE id = NULLIF(btrim(p_cashbook_id), '')
  FOR UPDATE;

  SELECT * INTO existing_ledger
  FROM public.customer_debt_transactions debt
  WHERE debt.cashbook_transaction_id = entry.id
    AND debt.transaction_type = 'payment'
    AND debt.reversal_of_id IS NULL
  ORDER BY debt.transaction_date
  LIMIT 1
  FOR UPDATE;

  IF existing_ledger.id IS NOT NULL THEN
    IF existing_ledger.customer_id <> p_customer_id THEN
      RAISE EXCEPTION 'Receipt is already linked to a different customer';
    END IF;
    RETURN public.p2_cashbook_response(entry.id) || jsonb_build_object(
      'already_reconciled', true,
      'customer_id', existing_ledger.customer_id,
      'ledger_id', existing_ledger.id,
      'new_debt', (SELECT debt FROM public.customers WHERE id = existing_ledger.customer_id)
    );
  END IF;

  IF entry.reversal_of_id IS NOT NULL
     OR entry.cancelled_at IS NOT NULL
     OR lower(COALESCE(entry.status, '')) IN ('cancelled', 'canceled', 'đã hủy', 'da huy') THEN
    RAISE EXCEPTION 'Cancelled or reversal vouchers cannot be reconciled';
  END IF;
  IF lower(COALESCE(entry.type, '')) <> 'thu'
     AND lower(COALESCE(entry.direction, '')) <> 'in' THEN
    RAISE EXCEPTION 'Only receipt vouchers can be reconciled';
  END IF;
  IF round(COALESCE(entry.value, 0)) <= 0 THEN
    RAISE EXCEPTION 'Receipt value must be positive';
  END IF;
  IF entry.order_id IS NOT NULL
     OR entry.sales_return_id IS NOT NULL
     OR entry.supplier_id IS NOT NULL
     OR entry.purchase_id IS NOT NULL
     OR entry.purchase_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Voucher already belongs to another financial workflow';
  END IF;
  IF entry.customer_id IS NOT NULL AND entry.customer_id <> p_customer_id THEN
    RAISE EXCEPTION 'Voucher is linked to a different customer';
  END IF;

  SELECT payment.id INTO existing_payment_id
  FROM public.payments payment
  WHERE payment.cashbook_transaction_id = entry.id
  LIMIT 1;
  IF existing_payment_id IS NOT NULL THEN
    RAISE EXCEPTION 'Voucher has a payment row but no debt ledger; stopped for review';
  END IF;

  haystack := lower(concat_ws(' ', entry.transaction_type, entry.category, entry.note));
  IF haystack NOT LIKE '%nợ%'
     AND haystack NOT LIKE '%tiền hàng%'
     AND haystack NOT LIKE '%tiền khách hàng%'
     AND haystack NOT LIKE '%trả trước%'
     AND haystack NOT LIKE '%customer payment%'
     AND haystack NOT LIKE '%customer debt%' THEN
    RAISE EXCEPTION 'Voucher is not labelled as a customer receipt';
  END IF;

  SELECT * INTO STRICT customer_row
  FROM public.customers
  WHERE id = NULLIF(btrim(p_customer_id), '')
    AND COALESCE(status, 'active') = 'active'
    AND deleted_at IS NULL
  FOR UPDATE;

  normalized_partner := lower(btrim(COALESCE(entry.partner, '')));
  IF entry.customer_id IS NULL
     AND normalized_partner <> lower(btrim(customer_row.name))
     AND normalized_partner <> lower(btrim(COALESCE(customer_row.code, '')))
     AND normalized_partner <> lower(btrim(customer_row.name || ' — ' || COALESCE(customer_row.code, '')))
     AND normalized_partner <> lower(btrim(customer_row.name || ' - ' || COALESCE(customer_row.code, ''))) THEN
    RAISE EXCEPTION 'Voucher partner does not exactly match the selected customer';
  END IF;

  payment_id := 'PAY-RECON-' || entry.id;
  ledger_id := 'DTX-RECON-' || entry.id;
  reconcile_key := left('reconcile:' || entry.id, 128);
  request_hash := md5(jsonb_build_object(
    'cashbookId', entry.id,
    'customerId', customer_row.id,
    'amount', round(entry.value)
  )::text);
  new_balance := round(COALESCE(customer_row.debt, 0)) - round(entry.value);

  UPDATE public.cashbook_transactions
  SET transaction_type = 'customer_payment',
      operation_type = 'customer_debt_receipt',
      reference_type = 'customer',
      reference_id = customer_row.id,
      customer_id = customer_row.id,
      direction = 'in',
      payment_method = COALESCE(NULLIF(entry.payment_method, ''), NULLIF(entry.method, ''), 'cash'),
      updated_by = actor.auth_user_id::text
  WHERE id = entry.id;

  INSERT INTO public.payments(
    id, customer_id, amount, payment_method, status, cashbook_transaction_id,
    idempotency_key, request_fingerprint, created_by, created_at
  ) VALUES (
    payment_id, customer_row.id, round(entry.value),
    COALESCE(NULLIF(entry.payment_method, ''), NULLIF(entry.method, ''), 'cash'),
    'completed', entry.id, reconcile_key, request_hash,
    actor.auth_user_id::text, now()
  );

  INSERT INTO public.customer_debt_transactions(
    id, customer_id, transaction_type, amount, debt_change,
    balance_before, balance_after, cashbook_transaction_id, description,
    idempotency_key, created_by, transaction_date
  ) VALUES (
    ledger_id, customer_row.id, 'payment', round(entry.value), -round(entry.value),
    round(COALESCE(customer_row.debt, 0)), new_balance, entry.id,
    'Đối soát phiếu thu cũ ' || entry.id, reconcile_key,
    actor.auth_user_id::text, now()
  );

  UPDATE public.customers
  SET debt = new_balance,
      last_payment_at = GREATEST(COALESCE(last_payment_at, '-infinity'::timestamptz),
                                 COALESCE(entry.transaction_date, entry.date, now())),
      updated_at = now(),
      updated_by = actor.auth_user_id::text
  WHERE id = customer_row.id;

  INSERT INTO public.audit_logs(
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'cashbook_transactions', 'RECONCILE_CUSTOMER_RECEIPT', entry.id, to_jsonb(entry),
    jsonb_build_object(
      'customer_id', customer_row.id,
      'amount', round(entry.value),
      'payment_id', payment_id,
      'ledger_id', ledger_id,
      'new_debt', new_balance
    ), actor.auth_user_id::text, now()
  );

  RETURN public.p2_cashbook_response(entry.id) || jsonb_build_object(
    'already_reconciled', false,
    'customer_id', customer_row.id,
    'payment_id', payment_id,
    'ledger_id', ledger_id,
    'new_debt', new_balance,
    'debt_change', -round(entry.value),
    'performed_by', actor.auth_user_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_reconcile_legacy_customer_receipt(text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_reconcile_legacy_customer_receipt(text, text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0032', 'Explicit idempotent reconciliation for legacy customer receipts')
ON CONFLICT (version) DO NOTHING;

COMMIT;
