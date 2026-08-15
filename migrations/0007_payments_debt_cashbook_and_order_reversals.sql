BEGIN;

-- Phase 2: customer payments, append-only debt ledger, cashbook and safe
-- cancellation/reversal. No inventory, production, return or supplier logic.

ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS external_reference text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS reversal_of_id text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS cashbook_transaction_id text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS request_fingerprint text;
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS cancellation_reason text;

ALTER TABLE public.customer_debt_transactions ADD COLUMN IF NOT EXISTS reversal_of_id text;
ALTER TABLE public.customer_debt_transactions ADD COLUMN IF NOT EXISTS idempotency_key text;

ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancellation_reason text;
ALTER TABLE public.starting_balances ADD COLUMN IF NOT EXISTS updated_by text;

CREATE UNIQUE INDEX IF NOT EXISTS cashbook_actor_idempotency_uidx
  ON public.cashbook_transactions(created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS cashbook_reversal_once_uidx
  ON public.cashbook_transactions(reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS debt_reversal_once_uidx
  ON public.customer_debt_transactions(reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS payments_cashbook_uidx
  ON public.payments(cashbook_transaction_id)
  WHERE cashbook_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS debt_order_type_idx
  ON public.customer_debt_transactions(order_id, transaction_type);

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM public.cashbook_transactions WHERE COALESCE(value, 0) < 0)
     OR EXISTS (SELECT 1 FROM public.payments WHERE COALESCE(amount, 0) < 0) THEN
    RAISE EXCEPTION 'Migration 0007 stopped: negative legacy payment/cashbook values require review';
  END IF;
END
$migration$;

ALTER TABLE public.cashbook_transactions DROP CONSTRAINT IF EXISTS cashbook_value_nonnegative;
ALTER TABLE public.cashbook_transactions
  ADD CONSTRAINT cashbook_value_nonnegative CHECK (value >= 0) NOT VALID;
ALTER TABLE public.cashbook_transactions VALIDATE CONSTRAINT cashbook_value_nonnegative;
ALTER TABLE public.payments DROP CONSTRAINT IF EXISTS payments_amount_nonnegative;
ALTER TABLE public.payments
  ADD CONSTRAINT payments_amount_nonnegative CHECK (amount >= 0) NOT VALID;
ALTER TABLE public.payments VALIDATE CONSTRAINT payments_amount_nonnegative;

CREATE SEQUENCE IF NOT EXISTS public.cashbook_display_seq;

CREATE OR REPLACE FUNCTION public.p2_reject_api_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Financial history is append-only; use a reviewed reversal RPC'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p2_ledger_immutable ON public.customer_debt_transactions;
CREATE TRIGGER p2_ledger_immutable
BEFORE UPDATE OR DELETE ON public.customer_debt_transactions
FOR EACH ROW EXECUTE FUNCTION public.p2_reject_api_financial_mutation();

DROP TRIGGER IF EXISTS p2_cashbook_no_api_delete ON public.cashbook_transactions;
CREATE TRIGGER p2_cashbook_no_api_delete
BEFORE DELETE ON public.cashbook_transactions
FOR EACH ROW EXECUTE FUNCTION public.p2_reject_api_financial_mutation();

DROP TRIGGER IF EXISTS p2_payments_no_api_delete ON public.payments;
CREATE TRIGGER p2_payments_no_api_delete
BEFORE DELETE ON public.payments
FOR EACH ROW EXECUTE FUNCTION public.p2_reject_api_financial_mutation();

CREATE OR REPLACE FUNCTION public.p2_guard_customer_debt()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    IF TG_OP = 'INSERT' AND (
      COALESCE(NEW.debt, 0) <> 0
      OR COALESCE(NEW.total_transaction, 0) <> 0
      OR COALESCE(NEW.total_return, 0) <> 0
      OR COALESCE(NEW.net_revenue, 0) <> 0
      OR NEW.last_order_at IS NOT NULL
      OR NEW.last_payment_at IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'Customer financial balances can only be initialized through a reviewed RPC'
        USING ERRCODE = '42501';
    ELSIF TG_OP = 'UPDATE' AND (
      NEW.debt IS DISTINCT FROM OLD.debt
      OR NEW.total_transaction IS DISTINCT FROM OLD.total_transaction
      OR NEW.total_return IS DISTINCT FROM OLD.total_return
      OR NEW.net_revenue IS DISTINCT FROM OLD.net_revenue
      OR NEW.last_order_at IS DISTINCT FROM OLD.last_order_at
      OR NEW.last_payment_at IS DISTINCT FROM OLD.last_payment_at
    ) THEN
      RAISE EXCEPTION 'Customer financial balances can only change through a reviewed financial RPC'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p2_customer_debt_insert_guard ON public.customers;
CREATE TRIGGER p2_customer_debt_insert_guard
BEFORE INSERT ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.p2_guard_customer_debt();

DROP TRIGGER IF EXISTS p2_customer_debt_update_guard ON public.customers;
CREATE TRIGGER p2_customer_debt_update_guard
BEFORE UPDATE OF debt, total_transaction, total_return, net_revenue, last_order_at, last_payment_at
ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.p2_guard_customer_debt();

CREATE OR REPLACE FUNCTION public.p2_cashbook_response(p_cashbook_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'success', true,
    'cashbook_id', entry.id,
    'transaction', jsonb_build_object(
      'id', entry.id,
      'cloudId', entry.id,
      'date', COALESCE(entry.transaction_date, entry.date),
      'type', entry.type,
      'transactionType', entry.transaction_type,
      'direction', entry.direction,
      'category', entry.category,
      'partner', entry.partner,
      'customerId', entry.customer_id,
      'orderId', entry.order_id,
      'value', entry.value,
      'method', COALESCE(entry.payment_method, entry.method),
      'accounting', entry.accounting,
      'status', entry.status,
      'creator', entry.creator,
      'createdBy', entry.created_by,
      'note', entry.note,
      'starred', entry.starred,
      'reversalOfId', entry.reversal_of_id,
      'cancelledAt', entry.cancelled_at,
      'cancellationReason', entry.cancellation_reason
    )
  )
  FROM public.cashbook_transactions entry
  WHERE entry.id = p_cashbook_id
$$;

CREATE OR REPLACE FUNCTION public.rpc_record_customer_payment(
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
    RAISE EXCEPTION 'Customer and a positive payment amount are required';
  END IF;
  IF normalized_method NOT IN ('cash', 'bank', 'wallet') THEN
    RAISE EXCEPTION 'Payment method must be cash, bank or wallet';
  END IF;
  IF p_idempotency_key IS NULL OR length(btrim(p_idempotency_key)) < 8
     OR length(p_idempotency_key) > 128 THEN
    RAISE EXCEPTION 'A stable payment idempotency key (8..128 chars) is required';
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
      RAISE EXCEPTION '409: idempotency key was already used with a different payment'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.p2_cashbook_response(existing_entry.id) || jsonb_build_object(
      'already_recorded', true,
      'new_debt', (SELECT balance_after FROM public.customer_debt_transactions
        WHERE cashbook_transaction_id = existing_entry.id AND transaction_type = 'payment'
        ORDER BY transaction_date LIMIT 1)
    );
  END IF;

  SELECT * INTO STRICT customer_row
  FROM public.customers
  WHERE id = p_customer_id
    AND COALESCE(status, 'active') = 'active'
    AND deleted_at IS NULL
  FOR UPDATE;
  IF COALESCE(customer_row.debt, 0) <= 0 THEN
    RAISE EXCEPTION 'Customer has no receivable debt to collect';
  END IF;
  IF round(p_amount) > round(customer_row.debt) THEN
    RAISE EXCEPTION 'Payment exceeds outstanding debt';
  END IF;

  cashbook_id := 'PT-' || to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
    lpad(nextval('public.cashbook_display_seq')::text, 8, '0');
  payment_id := 'PAY-' || gen_random_uuid()::text;
  ledger_id := 'DTX-PAY-' || gen_random_uuid()::text;
  new_balance := round(customer_row.debt) - round(p_amount);

  INSERT INTO public.cashbook_transactions(
    id, date, transaction_date, type, transaction_type, direction, category,
    partner, customer_id, value, method, payment_method, accounting, status,
    creator, created_by, note, starred, idempotency_key, request_fingerprint
  ) VALUES (
    cashbook_id, now(), now(), 'thu', 'customer_payment', 'in', 'Thu nợ khách hàng',
    customer_row.name, customer_row.id, round(p_amount), normalized_method,
    normalized_method, true, 'completed', actor.display_name, actor.auth_user_id::text,
    COALESCE(p_notes, 'Thu nợ khách hàng'), false, p_idempotency_key, request_hash
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
    round(customer_row.debt), new_balance, cashbook_id,
    COALESCE(p_notes, 'Thu nợ khách hàng'), p_idempotency_key,
    actor.auth_user_id::text, now()
  );

  UPDATE public.customers
  SET debt = new_balance, last_payment_at = now(), updated_at = now(),
      updated_by = actor.auth_user_id::text
  WHERE id = customer_row.id;

  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES ('customer_payments', 'RECORD', cashbook_id,
    jsonb_build_object('customer_id', customer_row.id, 'amount', round(p_amount),
      'payment_method', normalized_method, 'new_debt', new_balance),
    actor.auth_user_id::text, now());

  RETURN public.p2_cashbook_response(cashbook_id) || jsonb_build_object(
    'payment_id', payment_id, 'ledger_id', ledger_id, 'new_debt', new_balance,
    'debt_change', -round(p_amount), 'already_recorded', false,
    'performed_by', actor.auth_user_id::text
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_customer_payment(p_cashbook_id text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  entry public.cashbook_transactions%ROWTYPE;
  original_ledger public.customer_debt_transactions%ROWTYPE;
  current_balance numeric;
  new_balance numeric;
  reversal_ledger_id text;
  reversal_cashbook_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO STRICT entry
  FROM public.cashbook_transactions WHERE id = p_cashbook_id FOR UPDATE;
  IF entry.transaction_type <> 'customer_payment' OR entry.customer_id IS NULL THEN
    RAISE EXCEPTION 'Cashbook entry is not a customer debt receipt';
  END IF;
  SELECT * INTO STRICT original_ledger
  FROM public.customer_debt_transactions
  WHERE cashbook_transaction_id = entry.id AND transaction_type = 'payment'
  ORDER BY transaction_date LIMIT 1;

  SELECT COALESCE(debt, 0) INTO STRICT current_balance
  FROM public.customers WHERE id = entry.customer_id FOR UPDATE;
  reversal_ledger_id := 'DTX-VOID-' || original_ledger.id;
  reversal_cashbook_id := 'VOID-' || entry.id;

  IF entry.status IN ('cancelled', 'canceled', 'Đã hủy', 'Da huy')
     OR EXISTS (SELECT 1 FROM public.customer_debt_transactions
       WHERE reversal_of_id = original_ledger.id) THEN
    RETURN public.p2_cashbook_response(entry.id) || jsonb_build_object(
      'already_cancelled', true, 'customer_id', entry.customer_id,
      'new_debt', current_balance
    );
  END IF;

  new_balance := current_balance - original_ledger.debt_change;
  INSERT INTO public.customer_debt_transactions(
    id, customer_id, transaction_type, amount, debt_change, balance_before,
    balance_after, cashbook_transaction_id, reversal_of_id, description,
    created_by, transaction_date
  ) VALUES (
    reversal_ledger_id, entry.customer_id, 'payment_cancel', entry.value,
    -original_ledger.debt_change, current_balance, new_balance, entry.id,
    original_ledger.id, 'Hủy phiếu thu ' || entry.id,
    actor.auth_user_id::text, now()
  );

  UPDATE public.customers
  SET debt = new_balance, updated_at = now(), updated_by = actor.auth_user_id::text
  WHERE id = entry.customer_id;
  UPDATE public.cashbook_transactions
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = actor.auth_user_id::text,
      cancellation_reason = 'Hủy phiếu thu công nợ', updated_by = actor.auth_user_id::text
  WHERE id = entry.id;
  UPDATE public.payments
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = actor.auth_user_id::text,
      cancellation_reason = 'Hủy phiếu thu công nợ', updated_by = actor.auth_user_id::text
  WHERE cashbook_transaction_id = entry.id AND status = 'completed';

  INSERT INTO public.cashbook_transactions(
    id, date, transaction_date, type, transaction_type, direction, category,
    partner, customer_id, value, method, payment_method, accounting, status,
    creator, created_by, note, starred, reversal_of_id
  ) VALUES (
    reversal_cashbook_id, now(), now(), 'chi', 'customer_payment_reversal', 'out',
    'Đảo phiếu thu khách hàng', entry.partner, entry.customer_id, entry.value,
    entry.method, entry.payment_method, false, 'cancelled', actor.display_name,
    actor.auth_user_id::text, 'Giao dịch đảo cho ' || entry.id, false, entry.id
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('customer_payments', 'CANCEL', entry.id, to_jsonb(entry),
    jsonb_build_object('reversal_ledger_id', reversal_ledger_id,
      'reversal_cashbook_id', reversal_cashbook_id, 'new_debt', new_balance),
    actor.auth_user_id::text, now());

  RETURN public.p2_cashbook_response(entry.id) || jsonb_build_object(
    'already_cancelled', false, 'customer_id', entry.customer_id,
    'new_debt', new_balance, 'debt_change', -original_ledger.debt_change,
    'reversal_ledger_id', reversal_ledger_id,
    'performed_by', actor.auth_user_id::text
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_cashbook_transaction(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  existing_entry public.cashbook_transactions%ROWTYPE;
  entry_id text;
  entry_type text := lower(NULLIF(p_input->>'type', ''));
  entry_method text := lower(COALESCE(NULLIF(p_input->>'method', ''), 'cash'));
  entry_value numeric := round(COALESCE(NULLIF(p_input->>'value', '')::numeric, 0));
  entry_key text := NULLIF(btrim(p_input->>'idempotencyKey'), '');
  request_hash text;
  entry_date timestamptz;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF entry_type NOT IN ('thu', 'chi') OR entry_value <= 0 THEN
    RAISE EXCEPTION 'Cashbook type and a positive value are required';
  END IF;
  IF entry_method NOT IN ('cash', 'bank', 'wallet') THEN
    RAISE EXCEPTION 'Cashbook method must be cash, bank or wallet';
  END IF;
  IF entry_key IS NULL OR length(entry_key) < 8 OR length(entry_key) > 128 THEN
    RAISE EXCEPTION 'A stable cashbook idempotency key (8..128 chars) is required';
  END IF;
  IF NULLIF(p_input->>'customerId', '') IS NOT NULL
     OR NULLIF(p_input->>'supplierId', '') IS NOT NULL THEN
    RAISE EXCEPTION 'Partner debt transactions require their dedicated reviewed RPC';
  END IF;

  entry_date := COALESCE(NULLIF(p_input->>'transactionDate', '')::timestamptz, now());
  request_hash := md5(jsonb_build_object(
    'type', entry_type, 'value', entry_value, 'method', entry_method,
    'category', COALESCE(p_input->>'category', ''),
    'partner', COALESCE(p_input->>'partner', ''),
    'accounting', COALESCE((p_input->>'accounting')::boolean, true),
    'note', COALESCE(p_input->>'note', ''), 'transactionDate', entry_date
  )::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(actor.auth_user_id::text || ':' || entry_key, 0));
  SELECT * INTO existing_entry FROM public.cashbook_transactions
  WHERE created_by = actor.auth_user_id::text AND idempotency_key = entry_key;
  IF FOUND THEN
    IF existing_entry.request_fingerprint <> request_hash THEN
      RAISE EXCEPTION '409: idempotency key was already used with a different cashbook payload'
        USING ERRCODE = '23505';
    END IF;
    RETURN public.p2_cashbook_response(existing_entry.id) || jsonb_build_object('already_recorded', true);
  END IF;

  entry_id := CASE WHEN entry_type = 'thu' THEN 'PT-' ELSE 'PC-' END ||
    to_char(clock_timestamp(), 'YYYYMMDD') || '-' ||
    lpad(nextval('public.cashbook_display_seq')::text, 8, '0');
  INSERT INTO public.cashbook_transactions(
    id, date, transaction_date, type, transaction_type, direction, category,
    partner, value, method, payment_method, accounting, status, creator,
    created_by, note, starred, idempotency_key, request_fingerprint, external_reference
  ) VALUES (
    entry_id, entry_date, entry_date, entry_type, 'manual_' || entry_type,
    CASE WHEN entry_type = 'thu' THEN 'in' ELSE 'out' END,
    COALESCE(NULLIF(p_input->>'category', ''), 'Khác'),
    COALESCE(NULLIF(p_input->>'partner', ''), 'Khác'), entry_value,
    entry_method, entry_method, COALESCE((p_input->>'accounting')::boolean, true),
    'completed', actor.display_name, actor.auth_user_id::text,
    COALESCE(p_input->>'note', ''), false, entry_key, request_hash,
    NULLIF(p_input->>'externalReference', '')
  );
  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES ('cashbook_transactions', 'CREATE', entry_id,
    jsonb_build_object('type', entry_type, 'value', entry_value,
      'method', entry_method, 'accounting', COALESCE((p_input->>'accounting')::boolean, true)),
    actor.auth_user_id::text, now());
  RETURN public.p2_cashbook_response(entry_id) || jsonb_build_object(
    'already_recorded', false, 'performed_by', actor.auth_user_id::text
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_cashbook_transaction(
  p_cashbook_id text, p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  entry public.cashbook_transactions%ROWTYPE;
  reversal_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO STRICT entry FROM public.cashbook_transactions
  WHERE id = p_cashbook_id FOR UPDATE;
  IF entry.transaction_type IN ('customer_payment', 'customer_payment_reversal')
     OR entry.customer_id IS NOT NULL THEN
    RAISE EXCEPTION 'Customer receipt must be cancelled by rpc_cancel_customer_payment';
  END IF;
  IF entry.reversal_of_id IS NOT NULL THEN RAISE EXCEPTION 'A reversal entry cannot be cancelled'; END IF;
  reversal_id := 'VOID-' || entry.id;
  IF entry.status IN ('cancelled', 'canceled', 'Đã hủy', 'Da huy') THEN
    RETURN public.p2_cashbook_response(entry.id) || jsonb_build_object('already_cancelled', true);
  END IF;

  UPDATE public.cashbook_transactions
  SET status = 'cancelled', cancelled_at = now(), cancelled_by = actor.auth_user_id::text,
      cancellation_reason = COALESCE(NULLIF(p_reason, ''), 'Hủy phiếu sổ quỹ'),
      updated_by = actor.auth_user_id::text
  WHERE id = entry.id;
  INSERT INTO public.cashbook_transactions(
    id, date, transaction_date, type, transaction_type, direction, category,
    partner, value, method, payment_method, accounting, status, creator,
    created_by, note, starred, reversal_of_id
  ) VALUES (
    reversal_id, now(), now(), CASE WHEN entry.type = 'thu' THEN 'chi' ELSE 'thu' END,
    'cashbook_reversal', CASE WHEN entry.direction = 'in' THEN 'out' ELSE 'in' END,
    'Đảo ' || COALESCE(entry.category, 'giao dịch'), entry.partner, entry.value,
    entry.method, entry.payment_method, false, 'cancelled', actor.display_name,
    actor.auth_user_id::text, COALESCE(NULLIF(p_reason, ''), 'Đảo giao dịch ' || entry.id),
    false, entry.id
  ) ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('cashbook_transactions', 'CANCEL', entry.id, to_jsonb(entry),
    jsonb_build_object('reversal_id', reversal_id, 'reason', p_reason),
    actor.auth_user_id::text, now());
  RETURN public.p2_cashbook_response(entry.id) || jsonb_build_object(
    'already_cancelled', false, 'reversal_id', reversal_id,
    'performed_by', actor.auth_user_id::text
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_set_cashbook_starred(p_cashbook_id text, p_starred boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.cashbook_transactions
  SET starred = COALESCE(p_starred, false), updated_by = actor.auth_user_id::text
  WHERE id = p_cashbook_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Cashbook transaction not found'; END IF;
  RETURN public.p2_cashbook_response(p_cashbook_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_set_cashbook_starting_balances(
  p_cash numeric, p_bank numeric, p_wallet numeric
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; old_row public.starting_balances%ROWTYPE;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF COALESCE(p_cash, 0) < 0 OR COALESCE(p_bank, 0) < 0 OR COALESCE(p_wallet, 0) < 0 THEN
    RAISE EXCEPTION 'Starting balances cannot be negative';
  END IF;
  SELECT * INTO old_row FROM public.starting_balances WHERE id = 'current_balances' FOR UPDATE;
  INSERT INTO public.starting_balances(id, cash, bank, wallet, updated_at, updated_by)
  VALUES ('current_balances', round(COALESCE(p_cash, 0)), round(COALESCE(p_bank, 0)),
    round(COALESCE(p_wallet, 0)), now(), actor.auth_user_id::text)
  ON CONFLICT (id) DO UPDATE SET cash = EXCLUDED.cash, bank = EXCLUDED.bank,
    wallet = EXCLUDED.wallet, updated_at = now(), updated_by = actor.auth_user_id::text;
  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('starting_balances', 'SET', 'current_balances', to_jsonb(old_row),
    jsonb_build_object('cash', round(COALESCE(p_cash, 0)),
      'bank', round(COALESCE(p_bank, 0)), 'wallet', round(COALESCE(p_wallet, 0))),
    actor.auth_user_id::text, now());
  RETURN jsonb_build_object('success', true, 'cash', round(COALESCE(p_cash, 0)),
    'bank', round(COALESCE(p_bank, 0)), 'wallet', round(COALESCE(p_wallet, 0)),
    'performed_by', actor.auth_user_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_order(p_order_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
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
  IF p_reason IS NULL OR length(btrim(p_reason)) < 3 THEN
    RAISE EXCEPTION 'A cancellation reason is required';
  END IF;
  SELECT * INTO STRICT sale FROM public.orders WHERE id = p_order_id FOR UPDATE;
  IF sale.status IN ('cancelled', 'canceled') THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true,
      'order_id', sale.id, 'status', sale.status,
      'new_debt', CASE WHEN sale.customer_id IS NULL THEN NULL
        ELSE (SELECT debt FROM public.customers WHERE id = sale.customer_id) END);
  END IF;
  IF sale.status <> 'settled' THEN
    RAISE EXCEPTION 'Only a settled order without returns can be cancelled in Phase 2';
  END IF;
  IF EXISTS (SELECT 1 FROM public.sales_returns
    WHERE sale_id = sale.id AND status NOT IN ('cancelled', 'canceled')) THEN
    RAISE EXCEPTION 'Order has sales returns; cancellation must wait for the Phase 3 reversal flow';
  END IF;
  IF EXISTS (SELECT 1 FROM public.payments
    WHERE order_id = sale.id AND status = 'completed') THEN
    RAISE EXCEPTION 'Cancel linked order payments before cancelling the order';
  END IF;

  IF sale.customer_id IS NOT NULL THEN
    SELECT * INTO STRICT charge
    FROM public.customer_debt_transactions
    WHERE order_id = sale.id AND transaction_type = 'order'
    ORDER BY transaction_date LIMIT 1;
    IF EXISTS (
      SELECT 1 FROM public.customer_debt_transactions payment
      WHERE payment.customer_id = sale.customer_id
        AND payment.transaction_type = 'payment'
        AND payment.transaction_date >= charge.transaction_date
        AND NOT EXISTS (SELECT 1 FROM public.customer_debt_transactions reversed
          WHERE reversed.reversal_of_id = payment.id)
    ) THEN
      RAISE EXCEPTION 'Customer receipts after this order are not allocated by order; cancel those receipts first';
    END IF;
    SELECT * INTO STRICT customer_row
    FROM public.customers WHERE id = sale.customer_id FOR UPDATE;
    IF COALESCE(customer_row.debt, 0) < charge.debt_change THEN
      RAISE EXCEPTION 'Cancelling this order would create an unsupported customer credit balance';
    END IF;
    IF COALESCE(customer_row.total_transaction, 0) < COALESCE(sale.total_payable, 0)
       OR COALESCE(customer_row.net_revenue, 0) < COALESCE(sale.total_payable, 0) THEN
      RAISE EXCEPTION 'Customer revenue aggregates are inconsistent; cancellation stopped for review';
    END IF;
    new_balance := customer_row.debt - charge.debt_change;
    reversal_id := 'DTX-ORDER-VOID-' || charge.id;
    INSERT INTO public.customer_debt_transactions(
      id, customer_id, transaction_type, amount, debt_change, balance_before,
      balance_after, order_id, reversal_of_id, description, created_by, transaction_date
    ) VALUES (
      reversal_id, sale.customer_id, 'order_cancel', ABS(charge.debt_change),
      -charge.debt_change, customer_row.debt, new_balance, sale.id, charge.id,
      'Hủy đơn ' || sale.id || ': ' || btrim(p_reason), actor.auth_user_id::text, now()
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
  VALUES ('orders', 'CANCEL', sale.id, to_jsonb(sale),
    jsonb_build_object('status', 'cancelled', 'reason', btrim(p_reason),
      'debt_reversal_id', reversal_id, 'new_debt', new_balance),
    actor.auth_user_id::text, now());
  RETURN jsonb_build_object('success', true, 'already_cancelled', false,
    'order_id', sale.id, 'status', 'cancelled', 'customer_id', sale.customer_id,
    'new_debt', new_balance, 'debt_change', CASE WHEN sale.customer_id IS NULL THEN 0 ELSE -charge.debt_change END,
    'cancelled_by', actor.auth_user_id::text, 'cancelled_at', now(),
    'cancellation_reason', btrim(p_reason));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_adjust_customer_debt(
  p_customer_id text, p_new_debt numeric, p_description text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; customer_row public.customers%ROWTYPE; ledger_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF p_new_debt IS NULL OR p_new_debt < 0 THEN RAISE EXCEPTION 'Debt cannot be negative'; END IF;
  IF p_description IS NULL OR length(btrim(p_description)) < 3 THEN
    RAISE EXCEPTION 'A debt adjustment reason is required';
  END IF;
  SELECT * INTO STRICT customer_row FROM public.customers WHERE id = p_customer_id FOR UPDATE;
  IF round(customer_row.debt) = round(p_new_debt) THEN
    RETURN jsonb_build_object('success', true, 'already_at_balance', true,
      'new_debt', round(customer_row.debt), 'debt_change', 0);
  END IF;
  ledger_id := 'DTX-ADJ-' || gen_random_uuid()::text;
  INSERT INTO public.customer_debt_transactions(
    id, customer_id, transaction_type, amount, debt_change, balance_before,
    balance_after, description, created_by, transaction_date
  ) VALUES (
    ledger_id, customer_row.id, 'adjust', ABS(round(p_new_debt) - round(customer_row.debt)),
    round(p_new_debt) - round(customer_row.debt), round(customer_row.debt), round(p_new_debt),
    btrim(p_description), actor.auth_user_id::text, now()
  );
  UPDATE public.customers SET debt = round(p_new_debt), updated_at = now(),
    updated_by = actor.auth_user_id::text WHERE id = customer_row.id;
  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('customers', 'ADJUST_DEBT', customer_row.id,
    jsonb_build_object('debt', round(customer_row.debt)),
    jsonb_build_object('debt', round(p_new_debt), 'ledger_id', ledger_id,
      'reason', btrim(p_description)), actor.auth_user_id::text, now());
  RETURN jsonb_build_object('success', true, 'ledger_id', ledger_id,
    'new_debt', round(p_new_debt), 'debt_change', round(p_new_debt) - round(customer_row.debt),
    'performed_by', actor.auth_user_id::text);
END;
$$;

-- API users read financial history but cannot mutate it directly.
REVOKE INSERT, UPDATE, DELETE ON TABLE public.payments FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.customer_debt_transactions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.cashbook_transactions FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.starting_balances FROM authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.orders, public.order_items FROM authenticated;

REVOKE ALL ON FUNCTION public.p2_reject_api_financial_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p2_guard_customer_debt() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p2_cashbook_response(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_record_customer_payment(text, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_record_customer_payment(text, numeric, text, text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_customer_payment(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_create_cashbook_transaction(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_cashbook_transaction(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_set_cashbook_starred(text, boolean) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_set_cashbook_starting_balances(numeric, numeric, numeric) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_order(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_adjust_customer_debt(text, numeric, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.rpc_record_customer_payment(text, numeric, text, text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_customer_payment(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_cashbook_transaction(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_cashbook_transaction(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_cashbook_starred(text, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_cashbook_starting_balances(numeric, numeric, numeric) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_order(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_customer_debt(text, numeric, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0007', 'Payments, append-only debt ledger, cashbook and order reversal transactions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
