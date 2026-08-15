BEGIN;

-- Phase 4: suppliers, purchases, supplier debt and payment vouchers.
-- This migration intentionally has no inventory or production dependency.

ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS opening_debt numeric NOT NULL DEFAULT 0;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS total_purchase numeric NOT NULL DEFAULT 0;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS total_paid numeric NOT NULL DEFAULT 0;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.suppliers ADD COLUMN IF NOT EXISTS updated_by text;

-- Existing supplier debt is preserved as the opening balance. No business row
-- is deleted or rewritten into a purchase during this upgrade.
UPDATE public.suppliers
SET opening_debt = debt
WHERE opening_debt = 0
  AND total_purchase = 0
  AND total_paid = 0
  AND debt <> 0;

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.suppliers
    WHERE opening_debt < 0 OR total_purchase < 0 OR total_paid < 0 OR debt < 0
  ) THEN
    RAISE EXCEPTION 'Migration 0009 stopped: negative legacy supplier balances require review';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.suppliers
    WHERE NULLIF(btrim(code), '') IS NOT NULL
    GROUP BY lower(btrim(code)) HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Migration 0009 stopped: duplicate supplier codes require review';
  END IF;
END
$migration$;

CREATE UNIQUE INDEX IF NOT EXISTS suppliers_code_ci_uidx
  ON public.suppliers(lower(btrim(code)))
  WHERE NULLIF(btrim(code), '') IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.purchases (
  id text PRIMARY KEY,
  code text NOT NULL UNIQUE,
  supplier_id text NOT NULL REFERENCES public.suppliers(id),
  invoice_number text,
  purchase_date timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'completed',
  total_amount numeric NOT NULL DEFAULT 0,
  paid_amount numeric NOT NULL DEFAULT 0,
  balance_due numeric NOT NULL DEFAULT 0,
  payment_method text NOT NULL DEFAULT 'cash',
  notes text,
  idempotency_key text,
  request_fingerprint text,
  created_by text NOT NULL,
  updated_by text,
  cancelled_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancellation_reason text
);

CREATE TABLE IF NOT EXISTS public.purchase_items (
  id text PRIMARY KEY,
  purchase_id text NOT NULL REFERENCES public.purchases(id),
  line_number integer NOT NULL,
  item_code text NOT NULL,
  item_name text NOT NULL,
  unit text NOT NULL DEFAULT '',
  quantity numeric NOT NULL,
  unit_price numeric NOT NULL,
  line_total numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_id, line_number)
);

CREATE TABLE IF NOT EXISTS public.purchase_payments (
  id text PRIMARY KEY,
  purchase_id text REFERENCES public.purchases(id),
  supplier_id text NOT NULL REFERENCES public.suppliers(id),
  amount numeric NOT NULL,
  payment_method text NOT NULL DEFAULT 'cash',
  cashbook_transaction_id text,
  status text NOT NULL DEFAULT 'completed',
  notes text,
  idempotency_key text,
  request_fingerprint text,
  created_by text NOT NULL,
  cancelled_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  cancellation_reason text
);

CREATE TABLE IF NOT EXISTS public.supplier_debt_transactions (
  id text PRIMARY KEY,
  supplier_id text NOT NULL REFERENCES public.suppliers(id),
  purchase_id text REFERENCES public.purchases(id),
  payment_id text REFERENCES public.purchase_payments(id),
  transaction_type text NOT NULL,
  amount_change numeric NOT NULL,
  balance_after numeric NOT NULL,
  reversal_of_id text,
  idempotency_key text,
  notes text,
  created_by text NOT NULL,
  transaction_date timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS supplier_id text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS purchase_id text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS purchase_payment_id text;

CREATE SEQUENCE IF NOT EXISTS public.purchase_display_seq;
CREATE INDEX IF NOT EXISTS purchases_supplier_date_idx
  ON public.purchases(supplier_id, purchase_date DESC);
CREATE INDEX IF NOT EXISTS purchase_items_purchase_idx
  ON public.purchase_items(purchase_id, line_number);
CREATE INDEX IF NOT EXISTS purchase_payments_purchase_idx
  ON public.purchase_payments(purchase_id, created_at);
CREATE INDEX IF NOT EXISTS supplier_debt_supplier_date_idx
  ON public.supplier_debt_transactions(supplier_id, transaction_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS purchase_actor_idempotency_uidx
  ON public.purchases(created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_payment_actor_idempotency_uidx
  ON public.purchase_payments(created_by, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS supplier_debt_reversal_once_uidx
  ON public.supplier_debt_transactions(reversal_of_id)
  WHERE reversal_of_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS purchase_payment_cashbook_uidx
  ON public.purchase_payments(cashbook_transaction_id)
  WHERE cashbook_transaction_id IS NOT NULL;

ALTER TABLE public.suppliers DROP CONSTRAINT IF EXISTS suppliers_financial_nonnegative;
ALTER TABLE public.suppliers ADD CONSTRAINT suppliers_financial_nonnegative
  CHECK (opening_debt >= 0 AND total_purchase >= 0 AND total_paid >= 0 AND debt >= 0) NOT VALID;
ALTER TABLE public.suppliers VALIDATE CONSTRAINT suppliers_financial_nonnegative;
ALTER TABLE public.purchases DROP CONSTRAINT IF EXISTS purchases_status_check;
ALTER TABLE public.purchases ADD CONSTRAINT purchases_status_check
  CHECK (status IN ('draft', 'completed', 'cancelled'));
ALTER TABLE public.purchases DROP CONSTRAINT IF EXISTS purchases_amounts_check;
ALTER TABLE public.purchases ADD CONSTRAINT purchases_amounts_check
  CHECK (total_amount >= 0 AND paid_amount >= 0 AND balance_due >= 0 AND paid_amount <= total_amount);
ALTER TABLE public.purchase_items DROP CONSTRAINT IF EXISTS purchase_items_amounts_check;
ALTER TABLE public.purchase_items ADD CONSTRAINT purchase_items_amounts_check
  CHECK (quantity > 0 AND unit_price >= 0 AND line_total >= 0);
ALTER TABLE public.purchase_payments DROP CONSTRAINT IF EXISTS purchase_payments_amount_check;
ALTER TABLE public.purchase_payments ADD CONSTRAINT purchase_payments_amount_check CHECK (amount > 0);

CREATE OR REPLACE FUNCTION public.p4_reject_supplier_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'Supplier financial history can only change through a reviewed RPC'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.p4_guard_supplier_totals()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated') AND (
    NEW.opening_debt IS DISTINCT FROM OLD.opening_debt
    OR NEW.total_purchase IS DISTINCT FROM OLD.total_purchase
    OR NEW.total_paid IS DISTINCT FROM OLD.total_paid
    OR NEW.debt IS DISTINCT FROM OLD.debt
  ) THEN
    RAISE EXCEPTION 'Supplier balances can only change through a reviewed RPC'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p4_supplier_totals_guard ON public.suppliers;
CREATE TRIGGER p4_supplier_totals_guard
BEFORE UPDATE OF opening_debt, total_purchase, total_paid, debt
ON public.suppliers
FOR EACH ROW EXECUTE FUNCTION public.p4_guard_supplier_totals();

DROP TRIGGER IF EXISTS p4_purchases_no_api_mutation ON public.purchases;
CREATE TRIGGER p4_purchases_no_api_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.purchases
FOR EACH ROW EXECUTE FUNCTION public.p4_reject_supplier_financial_mutation();
DROP TRIGGER IF EXISTS p4_purchase_items_no_api_mutation ON public.purchase_items;
CREATE TRIGGER p4_purchase_items_no_api_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_items
FOR EACH ROW EXECUTE FUNCTION public.p4_reject_supplier_financial_mutation();
DROP TRIGGER IF EXISTS p4_purchase_payments_no_api_mutation ON public.purchase_payments;
CREATE TRIGGER p4_purchase_payments_no_api_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.purchase_payments
FOR EACH ROW EXECUTE FUNCTION public.p4_reject_supplier_financial_mutation();
DROP TRIGGER IF EXISTS p4_supplier_debt_no_api_mutation ON public.supplier_debt_transactions;
CREATE TRIGGER p4_supplier_debt_no_api_mutation
BEFORE INSERT OR UPDATE OR DELETE ON public.supplier_debt_transactions
FOR EACH ROW EXECUTE FUNCTION public.p4_reject_supplier_financial_mutation();

CREATE OR REPLACE FUNCTION public.p4_recompute_purchase(p_purchase_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_paid numeric;
BEGIN
  SELECT COALESCE(sum(amount), 0) INTO v_paid
  FROM public.purchase_payments
  WHERE purchase_id = p_purchase_id AND status = 'completed';
  UPDATE public.purchases
  SET paid_amount = CASE WHEN status = 'completed' THEN v_paid ELSE 0 END,
      balance_due = CASE WHEN status = 'completed' THEN GREATEST(total_amount - v_paid, 0) ELSE 0 END,
      updated_at = now()
  WHERE id = p_purchase_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.p4_recompute_supplier(p_supplier_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE v_purchase numeric; v_paid numeric;
BEGIN
  SELECT COALESCE(sum(total_amount), 0) INTO v_purchase
  FROM public.purchases
  WHERE supplier_id = p_supplier_id AND status = 'completed';
  SELECT COALESCE(sum(amount), 0) INTO v_paid
  FROM public.purchase_payments
  WHERE supplier_id = p_supplier_id AND status = 'completed';
  UPDATE public.suppliers
  SET total_purchase = v_purchase,
      total_paid = v_paid,
      debt = opening_debt + v_purchase - v_paid,
      updated_at = now()
  WHERE id = p_supplier_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.p4_supplier_response(p_supplier_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'success', true,
    'supplier', jsonb_build_object(
      'id', supplier.id, 'code', supplier.code, 'name', supplier.name,
      'phone', supplier.phone, 'address', supplier.address,
      'openingDebt', supplier.opening_debt, 'totalPurchase', supplier.total_purchase,
      'totalPaid', supplier.total_paid, 'debt', supplier.debt,
      'notes', supplier.notes, 'isActive', supplier.is_active,
      'createdBy', supplier.created_by, 'updatedBy', supplier.updated_by
    )
  ) FROM public.suppliers supplier WHERE supplier.id = p_supplier_id
$$;

CREATE OR REPLACE FUNCTION public.p4_purchase_response(p_purchase_id text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT jsonb_build_object(
    'success', true,
    'purchase', jsonb_build_object(
      'id', purchase.id, 'code', purchase.code,
      'supplierId', purchase.supplier_id, 'supplierName', supplier.name,
      'supplierCode', supplier.code, 'invoiceNumber', purchase.invoice_number,
      'purchaseDate', purchase.purchase_date, 'status', purchase.status,
      'totalAmount', purchase.total_amount, 'paidAmount', purchase.paid_amount,
      'balanceDue', purchase.balance_due, 'paymentMethod', purchase.payment_method,
      'notes', purchase.notes, 'createdBy', purchase.created_by,
      'cancelledBy', purchase.cancelled_by, 'cancelledAt', purchase.cancelled_at,
      'cancellationReason', purchase.cancellation_reason,
      'items', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', item.id, 'lineNumber', item.line_number, 'code', item.item_code,
          'name', item.item_name, 'unit', item.unit, 'quantity', item.quantity,
          'unitPrice', item.unit_price, 'lineTotal', item.line_total
        ) ORDER BY item.line_number)
        FROM public.purchase_items item WHERE item.purchase_id = purchase.id
      ), '[]'::jsonb),
      'payments', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
          'id', payment.id, 'amount', payment.amount,
          'paymentMethod', payment.payment_method,
          'cashbookTransactionId', payment.cashbook_transaction_id,
          'status', payment.status, 'notes', payment.notes,
          'createdBy', payment.created_by, 'createdAt', payment.created_at,
          'cancelledAt', payment.cancelled_at,
          'cancellationReason', payment.cancellation_reason
        ) ORDER BY payment.created_at)
        FROM public.purchase_payments payment WHERE payment.purchase_id = purchase.id
      ), '[]'::jsonb)
    )
  )
  FROM public.purchases purchase
  JOIN public.suppliers supplier ON supplier.id = purchase.supplier_id
  WHERE purchase.id = p_purchase_id
$$;

CREATE OR REPLACE FUNCTION public.rpc_save_supplier(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  existing_supplier public.suppliers%ROWTYPE;
  supplier_id text := NULLIF(btrim(p_input->>'id'), '');
  supplier_code text := upper(NULLIF(btrim(p_input->>'code'), ''));
  supplier_name text := NULLIF(btrim(p_input->>'name'), '');
  opening_amount numeric := round(COALESCE(NULLIF(p_input->>'openingDebt', '')::numeric, 0));
  ledger_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF supplier_code IS NULL OR supplier_name IS NULL THEN
    RAISE EXCEPTION 'Supplier code and name are required';
  END IF;
  IF NULLIF(p_input->>'openingDebt', '') IS NOT NULL
     AND (p_input->>'openingDebt') !~ '^[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION 'Opening supplier debt must be a finite nonnegative number';
  END IF;
  IF opening_amount < 0 THEN RAISE EXCEPTION 'Opening supplier debt cannot be negative'; END IF;

  IF supplier_id IS NOT NULL THEN
    SELECT * INTO existing_supplier FROM public.suppliers WHERE id = supplier_id FOR UPDATE;
  END IF;
  IF FOUND THEN
    UPDATE public.suppliers
    SET code = supplier_code, name = supplier_name,
        phone = COALESCE(p_input->>'phone', ''), address = COALESCE(p_input->>'address', ''),
        notes = COALESCE(p_input->>'notes', ''), is_active = true,
        updated_by = actor.auth_user_id::text, updated_at = now()
    WHERE id = supplier_id;
    INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
    VALUES ('suppliers', 'UPDATE', supplier_id, to_jsonb(existing_supplier),
      jsonb_build_object('code', supplier_code, 'name', supplier_name), actor.auth_user_id::text, now());
  ELSE
    supplier_id := COALESCE(supplier_id, 'SUP-' || replace(gen_random_uuid()::text, '-', ''));
    INSERT INTO public.suppliers(
      id, code, name, phone, address, opening_debt, total_purchase, total_paid,
      debt, notes, is_active, created_by, updated_by, created_at, updated_at
    ) VALUES (
      supplier_id, supplier_code, supplier_name, COALESCE(p_input->>'phone', ''),
      COALESCE(p_input->>'address', ''), opening_amount, 0, 0, opening_amount,
      COALESCE(p_input->>'notes', ''), true, actor.auth_user_id::text,
      actor.auth_user_id::text, now(), now()
    );
    IF opening_amount > 0 THEN
      ledger_id := 'SDL-' || replace(gen_random_uuid()::text, '-', '');
      INSERT INTO public.supplier_debt_transactions(
        id, supplier_id, transaction_type, amount_change, balance_after,
        notes, created_by, transaction_date
      ) VALUES (
        ledger_id, supplier_id, 'opening_balance', opening_amount, opening_amount,
        'Công nợ đầu kỳ nhà cung cấp', actor.auth_user_id::text, now()
      );
    END IF;
    INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
    VALUES ('suppliers', 'CREATE', supplier_id,
      jsonb_build_object('code', supplier_code, 'name', supplier_name,
        'opening_debt', opening_amount), actor.auth_user_id::text, now());
  END IF;
  RETURN public.p4_supplier_response(supplier_id);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION '409: supplier code already exists' USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_deactivate_supplier(p_supplier_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; supplier_row public.suppliers%ROWTYPE;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO STRICT supplier_row FROM public.suppliers WHERE id = p_supplier_id FOR UPDATE;
  IF supplier_row.is_active = false THEN RETURN public.p4_supplier_response(p_supplier_id) || jsonb_build_object('already_inactive', true); END IF;
  IF supplier_row.debt <> 0 THEN RAISE EXCEPTION 'Supplier with outstanding debt cannot be deactivated'; END IF;
  IF NULLIF(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Deactivation reason is required'; END IF;
  UPDATE public.suppliers SET is_active = false, updated_by = actor.auth_user_id::text, updated_at = now()
  WHERE id = p_supplier_id;
  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('suppliers', 'DEACTIVATE', p_supplier_id, to_jsonb(supplier_row),
    jsonb_build_object('is_active', false, 'reason', btrim(p_reason)), actor.auth_user_id::text, now());
  RETURN public.p4_supplier_response(p_supplier_id) || jsonb_build_object('already_inactive', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_purchase(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  supplier_row public.suppliers%ROWTYPE;
  existing_purchase public.purchases%ROWTYPE;
  purchase_id text;
  purchase_code text;
  purchase_key text := NULLIF(btrim(p_input->>'idempotencyKey'), '');
  purchase_method text := lower(COALESCE(NULLIF(p_input->>'paymentMethod', ''), 'cash'));
  purchase_date_value timestamptz;
  normalized_items jsonb;
  request_hash text;
  total_value numeric;
  initial_paid numeric := round(COALESCE(NULLIF(p_input->>'paidAmount', '')::numeric, 0));
  payment_id text;
  cashbook_id text;
  ledger_id text;
  running_balance numeric;
  item_record record;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF purchase_key IS NULL OR length(purchase_key) < 8 OR length(purchase_key) > 128 THEN
    RAISE EXCEPTION 'A stable purchase idempotency key (8..128 chars) is required';
  END IF;
  IF purchase_method NOT IN ('cash', 'bank', 'wallet') THEN
    RAISE EXCEPTION 'Payment method must be cash, bank or wallet';
  END IF;
  IF NULLIF(p_input->>'paidAmount', '') IS NOT NULL
     AND (p_input->>'paidAmount') !~ '^[0-9]+([.][0-9]+)?$' THEN
    RAISE EXCEPTION 'Initial payment must be a finite nonnegative number';
  END IF;
  IF jsonb_typeof(COALESCE(p_input->'items', '[]'::jsonb)) <> 'array'
     OR jsonb_array_length(COALESCE(p_input->'items', '[]'::jsonb)) = 0
     OR jsonb_array_length(COALESCE(p_input->'items', '[]'::jsonb)) > 100 THEN
    RAISE EXCEPTION 'Purchase requires 1..100 item rows';
  END IF;

  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_input->'items') item
    WHERE NULLIF(btrim(item->>'code'), '') IS NULL
       OR NULLIF(btrim(item->>'name'), '') IS NULL
       OR COALESCE(item->>'quantity', '') !~ '^[0-9]+([.][0-9]+)?$'
       OR COALESCE(item->>'unitPrice', '') !~ '^[0-9]+([.][0-9]+)?$'
       OR COALESCE(NULLIF(item->>'quantity', '')::numeric, 0) <= 0
       OR COALESCE(NULLIF(item->>'unitPrice', '')::numeric, -1) < 0
  ) THEN RAISE EXCEPTION 'Every purchase row requires code, name, positive quantity and nonnegative unit price'; END IF;

  SELECT jsonb_agg(jsonb_build_object(
      'code', upper(btrim(item->>'code')), 'name', btrim(item->>'name'),
      'unit', COALESCE(btrim(item->>'unit'), ''),
      'quantity', (item->>'quantity')::numeric,
      'unitPrice', round((item->>'unitPrice')::numeric)
    ) ORDER BY ordinal),
    sum(round((item->>'quantity')::numeric * round((item->>'unitPrice')::numeric)))
  INTO normalized_items, total_value
  FROM jsonb_array_elements(p_input->'items') WITH ORDINALITY payload(item, ordinal);

  IF total_value <= 0 THEN RAISE EXCEPTION 'Purchase total must be positive'; END IF;
  IF initial_paid < 0 OR initial_paid > total_value THEN
    RAISE EXCEPTION 'Initial payment must be between zero and the database-calculated purchase total';
  END IF;
  purchase_date_value := COALESCE(NULLIF(p_input->>'purchaseDate', '')::timestamptz, now());
  request_hash := md5(jsonb_build_object(
    'supplierId', p_input->>'supplierId', 'invoiceNumber', COALESCE(p_input->>'invoiceNumber', ''),
    'purchaseDate', purchase_date_value, 'paidAmount', initial_paid,
    'paymentMethod', purchase_method, 'notes', COALESCE(p_input->>'notes', ''),
    'items', normalized_items
  )::text);

  PERFORM pg_advisory_xact_lock(hashtextextended(actor.auth_user_id::text || ':' || purchase_key, 0));
  SELECT * INTO existing_purchase FROM public.purchases
  WHERE created_by = actor.auth_user_id::text AND idempotency_key = purchase_key;
  IF FOUND THEN
    IF existing_purchase.request_fingerprint <> request_hash THEN
      RAISE EXCEPTION '409: idempotency key was already used with a different purchase payload' USING ERRCODE = '23505';
    END IF;
    RETURN public.p4_purchase_response(existing_purchase.id)
      || public.p4_supplier_response(existing_purchase.supplier_id)
      || jsonb_build_object('already_recorded', true);
  END IF;

  SELECT * INTO STRICT supplier_row FROM public.suppliers
  WHERE id = p_input->>'supplierId' FOR UPDATE;
  IF supplier_row.is_active = false THEN RAISE EXCEPTION 'Supplier is inactive'; END IF;

  purchase_id := 'PUR-' || replace(gen_random_uuid()::text, '-', '');
  purchase_code := 'PM-' || to_char(purchase_date_value, 'YYYYMMDD') || '-' ||
    lpad(nextval('public.purchase_display_seq')::text, 8, '0');
  INSERT INTO public.purchases(
    id, code, supplier_id, invoice_number, purchase_date, status,
    total_amount, paid_amount, balance_due, payment_method, notes,
    idempotency_key, request_fingerprint, created_by, updated_by
  ) VALUES (
    purchase_id, purchase_code, supplier_row.id, NULLIF(btrim(p_input->>'invoiceNumber'), ''),
    purchase_date_value, 'completed', total_value, initial_paid,
    total_value - initial_paid, purchase_method, COALESCE(p_input->>'notes', ''),
    purchase_key, request_hash, actor.auth_user_id::text, actor.auth_user_id::text
  );

  FOR item_record IN
    SELECT item, ordinal FROM jsonb_array_elements(normalized_items) WITH ORDINALITY payload(item, ordinal)
  LOOP
    INSERT INTO public.purchase_items(
      id, purchase_id, line_number, item_code, item_name, unit,
      quantity, unit_price, line_total
    ) VALUES (
      'PIT-' || replace(gen_random_uuid()::text, '-', ''), purchase_id, item_record.ordinal,
      item_record.item->>'code', item_record.item->>'name', item_record.item->>'unit',
      (item_record.item->>'quantity')::numeric, (item_record.item->>'unitPrice')::numeric,
      round((item_record.item->>'quantity')::numeric * (item_record.item->>'unitPrice')::numeric)
    );
  END LOOP;

  running_balance := supplier_row.debt + total_value;
  ledger_id := 'SDL-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.supplier_debt_transactions(
    id, supplier_id, purchase_id, transaction_type, amount_change,
    balance_after, idempotency_key, notes, created_by, transaction_date
  ) VALUES (
    ledger_id, supplier_row.id, purchase_id, 'purchase', total_value,
    running_balance, purchase_key || ':purchase', 'Ghi nhận ' || purchase_code,
    actor.auth_user_id::text, purchase_date_value
  );

  IF initial_paid > 0 THEN
    payment_id := 'SPAY-' || replace(gen_random_uuid()::text, '-', '');
    cashbook_id := 'PC-NCC-' || replace(gen_random_uuid()::text, '-', '');
    INSERT INTO public.purchase_payments(
      id, purchase_id, supplier_id, amount, payment_method,
      cashbook_transaction_id, status, notes, idempotency_key,
      request_fingerprint, created_by, created_at
    ) VALUES (
      payment_id, purchase_id, supplier_row.id, initial_paid, purchase_method,
      cashbook_id, 'completed', 'Thanh toán khi lập ' || purchase_code,
      purchase_key || ':initial-payment', request_hash, actor.auth_user_id::text, purchase_date_value
    );
    running_balance := running_balance - initial_paid;
    INSERT INTO public.supplier_debt_transactions(
      id, supplier_id, purchase_id, payment_id, transaction_type,
      amount_change, balance_after, idempotency_key, notes, created_by, transaction_date
    ) VALUES (
      'SDL-' || replace(gen_random_uuid()::text, '-', ''), supplier_row.id, purchase_id,
      payment_id, 'supplier_payment', -initial_paid, running_balance,
      purchase_key || ':initial-payment', 'Thanh toán ' || purchase_code,
      actor.auth_user_id::text, purchase_date_value
    );
    INSERT INTO public.cashbook_transactions(
      id, date, transaction_date, type, transaction_type, direction, category,
      partner, supplier_id, purchase_id, purchase_payment_id, value,
      method, payment_method, accounting, status, creator, created_by,
      note, starred, idempotency_key, request_fingerprint, external_reference
    ) VALUES (
      cashbook_id, purchase_date_value, purchase_date_value, 'chi', 'supplier_payment', 'out',
      'Thanh toán nhà cung cấp', supplier_row.name, supplier_row.id, purchase_id,
      payment_id, initial_paid, purchase_method, purchase_method, true, 'completed',
      actor.display_name, actor.auth_user_id::text, 'Thanh toán ' || purchase_code,
      false, purchase_key || ':supplier-cashbook', request_hash, purchase_code
    );
  END IF;

  PERFORM public.p4_recompute_purchase(purchase_id);
  PERFORM public.p4_recompute_supplier(supplier_row.id);
  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES ('purchases', 'CREATE', purchase_id,
    jsonb_build_object('supplier_id', supplier_row.id, 'total_amount', total_value,
      'paid_amount', initial_paid, 'idempotency_key', purchase_key),
    actor.auth_user_id::text, now());
  RETURN public.p4_purchase_response(purchase_id)
    || public.p4_supplier_response(supplier_row.id)
    || jsonb_build_object(
    'already_recorded', false, 'performed_by', actor.auth_user_id::text
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_record_supplier_payment(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  supplier_row public.suppliers%ROWTYPE;
  purchase_row public.purchases%ROWTYPE;
  existing_payment public.purchase_payments%ROWTYPE;
  payment_key text := NULLIF(btrim(p_input->>'idempotencyKey'), '');
  payment_method_value text := lower(COALESCE(NULLIF(p_input->>'paymentMethod', ''), 'cash'));
  payment_amount numeric := round(COALESCE(NULLIF(p_input->>'amount', '')::numeric, 0));
  payment_id text;
  cashbook_id text;
  request_hash text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501'; END IF;
  IF payment_key IS NULL OR length(payment_key) < 8 OR length(payment_key) > 128 THEN RAISE EXCEPTION 'A stable payment idempotency key (8..128 chars) is required'; END IF;
  IF payment_method_value NOT IN ('cash', 'bank', 'wallet') THEN RAISE EXCEPTION 'Payment method must be cash, bank or wallet'; END IF;
  IF COALESCE(p_input->>'amount', '') !~ '^[0-9]+([.][0-9]+)?$' THEN RAISE EXCEPTION 'Supplier payment must be a finite positive number'; END IF;
  IF payment_amount <= 0 THEN RAISE EXCEPTION 'Supplier payment amount must be positive'; END IF;

  request_hash := md5(jsonb_build_object(
    'supplierId', p_input->>'supplierId', 'purchaseId', COALESCE(p_input->>'purchaseId', ''),
    'amount', payment_amount, 'paymentMethod', payment_method_value,
    'notes', COALESCE(p_input->>'notes', '')
  )::text);
  PERFORM pg_advisory_xact_lock(hashtextextended(actor.auth_user_id::text || ':' || payment_key, 0));
  SELECT * INTO existing_payment FROM public.purchase_payments
  WHERE created_by = actor.auth_user_id::text AND idempotency_key = payment_key;
  IF FOUND THEN
    IF existing_payment.request_fingerprint <> request_hash THEN RAISE EXCEPTION '409: idempotency key was already used with a different supplier payment' USING ERRCODE = '23505'; END IF;
    RETURN COALESCE(public.p4_purchase_response(existing_payment.purchase_id), jsonb_build_object('success', true))
      || public.p4_supplier_response(existing_payment.supplier_id)
      || jsonb_build_object('success', true, 'already_recorded', true,
      'payment_id', existing_payment.id, 'purchase_id', existing_payment.purchase_id,
      'supplier_id', existing_payment.supplier_id);
  END IF;

  SELECT * INTO STRICT supplier_row FROM public.suppliers WHERE id = p_input->>'supplierId' FOR UPDATE;
  IF supplier_row.is_active = false THEN RAISE EXCEPTION 'Supplier is inactive'; END IF;
  IF payment_amount > supplier_row.debt THEN RAISE EXCEPTION 'Supplier payment exceeds outstanding debt'; END IF;
  IF NULLIF(p_input->>'purchaseId', '') IS NOT NULL THEN
    SELECT * INTO STRICT purchase_row FROM public.purchases
    WHERE id = p_input->>'purchaseId' AND supplier_id = supplier_row.id FOR UPDATE;
    IF purchase_row.status <> 'completed' THEN RAISE EXCEPTION 'Only completed purchases can be paid'; END IF;
    IF payment_amount > purchase_row.balance_due THEN RAISE EXCEPTION 'Supplier payment exceeds purchase balance'; END IF;
  END IF;

  payment_id := 'SPAY-' || replace(gen_random_uuid()::text, '-', '');
  cashbook_id := 'PC-NCC-' || replace(gen_random_uuid()::text, '-', '');
  INSERT INTO public.purchase_payments(
    id, purchase_id, supplier_id, amount, payment_method,
    cashbook_transaction_id, status, notes, idempotency_key,
    request_fingerprint, created_by
  ) VALUES (
    payment_id, NULLIF(p_input->>'purchaseId', ''), supplier_row.id, payment_amount,
    payment_method_value, cashbook_id, 'completed', COALESCE(p_input->>'notes', ''),
    payment_key, request_hash, actor.auth_user_id::text
  );
  INSERT INTO public.supplier_debt_transactions(
    id, supplier_id, purchase_id, payment_id, transaction_type, amount_change,
    balance_after, idempotency_key, notes, created_by, transaction_date
  ) VALUES (
    'SDL-' || replace(gen_random_uuid()::text, '-', ''), supplier_row.id,
    NULLIF(p_input->>'purchaseId', ''), payment_id, 'supplier_payment', -payment_amount,
    supplier_row.debt - payment_amount, payment_key, COALESCE(p_input->>'notes', ''),
    actor.auth_user_id::text, now()
  );
  INSERT INTO public.cashbook_transactions(
    id, date, transaction_date, type, transaction_type, direction, category,
    partner, supplier_id, purchase_id, purchase_payment_id, value,
    method, payment_method, accounting, status, creator, created_by,
    note, starred, idempotency_key, request_fingerprint, external_reference
  ) VALUES (
    cashbook_id, now(), now(), 'chi', 'supplier_payment', 'out', 'Thanh toán nhà cung cấp',
    supplier_row.name, supplier_row.id, NULLIF(p_input->>'purchaseId', ''), payment_id,
    payment_amount, payment_method_value, payment_method_value, true, 'completed',
    actor.display_name, actor.auth_user_id::text, COALESCE(p_input->>'notes', ''),
    false, payment_key || ':cashbook', request_hash, payment_id
  );
  IF NULLIF(p_input->>'purchaseId', '') IS NOT NULL THEN PERFORM public.p4_recompute_purchase(p_input->>'purchaseId'); END IF;
  PERFORM public.p4_recompute_supplier(supplier_row.id);
  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES ('purchase_payments', 'CREATE', payment_id,
    jsonb_build_object('supplier_id', supplier_row.id, 'purchase_id', NULLIF(p_input->>'purchaseId', ''),
      'amount', payment_amount, 'cashbook_id', cashbook_id), actor.auth_user_id::text, now());
  RETURN COALESCE(public.p4_purchase_response(NULLIF(p_input->>'purchaseId', '')), jsonb_build_object('success', true))
    || public.p4_supplier_response(supplier_row.id)
    || jsonb_build_object('success', true, 'already_recorded', false,
    'payment_id', payment_id, 'purchase_id', NULLIF(p_input->>'purchaseId', ''),
    'supplier_id', supplier_row.id, 'cashbook_transaction_id', cashbook_id,
    'new_debt', supplier_row.debt - payment_amount, 'performed_by', actor.auth_user_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_supplier_payment(p_payment_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  payment_row public.purchase_payments%ROWTYPE;
  supplier_row public.suppliers%ROWTYPE;
  cashbook_row public.cashbook_transactions%ROWTYPE;
  original_ledger public.supplier_debt_transactions%ROWTYPE;
  reversal_cashbook_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501'; END IF;
  IF NULLIF(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Cancellation reason is required'; END IF;
  SELECT * INTO STRICT payment_row FROM public.purchase_payments WHERE id = p_payment_id FOR UPDATE;
  IF payment_row.status = 'cancelled' THEN
    RETURN COALESCE(public.p4_purchase_response(payment_row.purchase_id), jsonb_build_object('success', true))
      || public.p4_supplier_response(payment_row.supplier_id)
      || jsonb_build_object('success', true, 'already_cancelled', true,
      'payment_id', payment_row.id, 'purchase_id', payment_row.purchase_id);
  END IF;
  SELECT * INTO STRICT supplier_row FROM public.suppliers WHERE id = payment_row.supplier_id FOR UPDATE;
  SELECT * INTO STRICT original_ledger FROM public.supplier_debt_transactions
  WHERE payment_id = payment_row.id AND transaction_type = 'supplier_payment' AND reversal_of_id IS NULL FOR UPDATE;
  SELECT * INTO STRICT cashbook_row FROM public.cashbook_transactions
  WHERE id = payment_row.cashbook_transaction_id FOR UPDATE;

  UPDATE public.purchase_payments SET status = 'cancelled', cancelled_by = actor.auth_user_id::text,
    cancelled_at = now(), cancellation_reason = btrim(p_reason) WHERE id = payment_row.id;
  UPDATE public.cashbook_transactions SET status = 'cancelled', cancelled_by = actor.auth_user_id::text,
    cancelled_at = now(), cancellation_reason = btrim(p_reason), updated_by = actor.auth_user_id::text
  WHERE id = cashbook_row.id;
  reversal_cashbook_id := 'VOID-' || cashbook_row.id;
  INSERT INTO public.cashbook_transactions(
    id, date, transaction_date, type, transaction_type, direction, category,
    partner, supplier_id, purchase_id, purchase_payment_id, value,
    method, payment_method, accounting, status, creator, created_by,
    note, starred, reversal_of_id
  ) VALUES (
    reversal_cashbook_id, now(), now(), 'thu', 'supplier_payment_reversal', 'in',
    'Đảo thanh toán nhà cung cấp', cashbook_row.partner, payment_row.supplier_id,
    payment_row.purchase_id, payment_row.id, payment_row.amount,
    payment_row.payment_method, payment_row.payment_method, false, 'cancelled',
    actor.display_name, actor.auth_user_id::text, btrim(p_reason), false, cashbook_row.id
  ) ON CONFLICT (id) DO NOTHING;
  INSERT INTO public.supplier_debt_transactions(
    id, supplier_id, purchase_id, payment_id, transaction_type, amount_change,
    balance_after, reversal_of_id, notes, created_by, transaction_date
  ) VALUES (
    'SDL-' || replace(gen_random_uuid()::text, '-', ''), payment_row.supplier_id,
    payment_row.purchase_id, payment_row.id, 'supplier_payment_reversal', payment_row.amount,
    supplier_row.debt + payment_row.amount, original_ledger.id, btrim(p_reason),
    actor.auth_user_id::text, now()
  );
  IF payment_row.purchase_id IS NOT NULL THEN PERFORM public.p4_recompute_purchase(payment_row.purchase_id); END IF;
  PERFORM public.p4_recompute_supplier(payment_row.supplier_id);
  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('purchase_payments', 'CANCEL', payment_row.id, to_jsonb(payment_row),
    jsonb_build_object('cashbook_reversal_id', reversal_cashbook_id,
      'debt_change', payment_row.amount, 'reason', btrim(p_reason)), actor.auth_user_id::text, now());
  RETURN COALESCE(public.p4_purchase_response(payment_row.purchase_id), jsonb_build_object('success', true))
    || public.p4_supplier_response(payment_row.supplier_id)
    || jsonb_build_object('success', true, 'already_cancelled', false,
    'payment_id', payment_row.id, 'purchase_id', payment_row.purchase_id,
    'supplier_id', payment_row.supplier_id, 'performed_by', actor.auth_user_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_cancel_purchase(p_purchase_id text, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  purchase_row public.purchases%ROWTYPE;
  supplier_row public.suppliers%ROWTYPE;
  purchase_ledger public.supplier_debt_transactions%ROWTYPE;
  payment_row public.purchase_payments%ROWTYPE;
  payment_ledger public.supplier_debt_transactions%ROWTYPE;
  cashbook_row public.cashbook_transactions%ROWTYPE;
  running_balance numeric;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501'; END IF;
  IF NULLIF(btrim(p_reason), '') IS NULL THEN RAISE EXCEPTION 'Cancellation reason is required'; END IF;
  SELECT * INTO STRICT purchase_row FROM public.purchases WHERE id = p_purchase_id FOR UPDATE;
  IF purchase_row.status = 'cancelled' THEN
    RETURN public.p4_purchase_response(p_purchase_id)
      || public.p4_supplier_response(purchase_row.supplier_id)
      || jsonb_build_object('already_cancelled', true);
  END IF;
  IF purchase_row.status <> 'completed' THEN RAISE EXCEPTION 'Only completed purchases can be cancelled'; END IF;
  SELECT * INTO STRICT supplier_row FROM public.suppliers WHERE id = purchase_row.supplier_id FOR UPDATE;
  running_balance := supplier_row.debt;

  FOR payment_row IN
    SELECT * FROM public.purchase_payments
    WHERE purchase_id = purchase_row.id AND status = 'completed'
    ORDER BY created_at FOR UPDATE
  LOOP
    SELECT * INTO STRICT payment_ledger FROM public.supplier_debt_transactions
    WHERE payment_id = payment_row.id AND transaction_type = 'supplier_payment'
      AND reversal_of_id IS NULL FOR UPDATE;
    SELECT * INTO STRICT cashbook_row FROM public.cashbook_transactions
    WHERE id = payment_row.cashbook_transaction_id FOR UPDATE;
    UPDATE public.purchase_payments SET status = 'cancelled', cancelled_by = actor.auth_user_id::text,
      cancelled_at = now(), cancellation_reason = btrim(p_reason) WHERE id = payment_row.id;
    UPDATE public.cashbook_transactions SET status = 'cancelled', cancelled_by = actor.auth_user_id::text,
      cancelled_at = now(), cancellation_reason = btrim(p_reason), updated_by = actor.auth_user_id::text
    WHERE id = cashbook_row.id;
    INSERT INTO public.cashbook_transactions(
      id, date, transaction_date, type, transaction_type, direction, category,
      partner, supplier_id, purchase_id, purchase_payment_id, value,
      method, payment_method, accounting, status, creator, created_by,
      note, starred, reversal_of_id
    ) VALUES (
      'VOID-' || cashbook_row.id, now(), now(), 'thu', 'supplier_payment_reversal', 'in',
      'Đảo thanh toán phiếu mua', cashbook_row.partner, payment_row.supplier_id,
      purchase_row.id, payment_row.id, payment_row.amount, payment_row.payment_method,
      payment_row.payment_method, false, 'cancelled', actor.display_name,
      actor.auth_user_id::text, btrim(p_reason), false, cashbook_row.id
    ) ON CONFLICT (id) DO NOTHING;
    running_balance := running_balance + payment_row.amount;
    INSERT INTO public.supplier_debt_transactions(
      id, supplier_id, purchase_id, payment_id, transaction_type, amount_change,
      balance_after, reversal_of_id, notes, created_by, transaction_date
    ) VALUES (
      'SDL-' || replace(gen_random_uuid()::text, '-', ''), purchase_row.supplier_id,
      purchase_row.id, payment_row.id, 'supplier_payment_reversal', payment_row.amount,
      running_balance, payment_ledger.id, btrim(p_reason), actor.auth_user_id::text, now()
    );
  END LOOP;

  SELECT * INTO STRICT purchase_ledger FROM public.supplier_debt_transactions
  WHERE purchase_id = purchase_row.id AND payment_id IS NULL
    AND transaction_type = 'purchase' AND reversal_of_id IS NULL FOR UPDATE;
  running_balance := running_balance - purchase_row.total_amount;
  IF running_balance < 0 THEN
    RAISE EXCEPTION 'Purchase cancellation would make supplier debt negative; review later unallocated payments first';
  END IF;
  INSERT INTO public.supplier_debt_transactions(
    id, supplier_id, purchase_id, transaction_type, amount_change,
    balance_after, reversal_of_id, notes, created_by, transaction_date
  ) VALUES (
    'SDL-' || replace(gen_random_uuid()::text, '-', ''), purchase_row.supplier_id,
    purchase_row.id, 'purchase_reversal', -purchase_row.total_amount,
    running_balance, purchase_ledger.id, btrim(p_reason), actor.auth_user_id::text, now()
  );
  UPDATE public.purchases SET status = 'cancelled', paid_amount = 0, balance_due = 0,
    cancelled_by = actor.auth_user_id::text, cancelled_at = now(),
    cancellation_reason = btrim(p_reason), updated_by = actor.auth_user_id::text,
    updated_at = now() WHERE id = purchase_row.id;
  PERFORM public.p4_recompute_supplier(purchase_row.supplier_id);
  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('purchases', 'CANCEL', purchase_row.id, to_jsonb(purchase_row),
    jsonb_build_object('reason', btrim(p_reason), 'debt_after', running_balance),
    actor.auth_user_id::text, now());
  RETURN public.p4_purchase_response(purchase_row.id)
    || public.p4_supplier_response(purchase_row.supplier_id)
    || jsonb_build_object(
    'already_cancelled', false, 'performed_by', actor.auth_user_id::text
  );
END;
$$;

-- Canonical RLS: supplier financial data is finance-only. Direct writes are
-- disabled even for authenticated users; all mutations go through RPCs above.
DO $migration$
DECLARE target text; policy record;
BEGIN
  FOREACH target IN ARRAY ARRAY['suppliers', 'purchases', 'purchase_items', 'purchase_payments', 'supplier_debt_transactions'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target);
    FOR policy IN SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = target LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy.policyname, target);
    END LOOP;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', target);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', target);
    EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_admin_or_accounting())', target || '_finance_select', target);
  END LOOP;
END
$migration$;

REVOKE ALL ON FUNCTION public.p4_reject_supplier_financial_mutation() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p4_guard_supplier_totals() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p4_recompute_purchase(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p4_recompute_supplier(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p4_supplier_response(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.p4_purchase_response(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_save_supplier(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_deactivate_supplier(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_create_purchase(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_record_supplier_payment(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_supplier_payment(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_cancel_purchase(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_save_supplier(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_deactivate_supplier(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_purchase(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_supplier_payment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_supplier_payment(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_purchase(text, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0009', 'Supplier purchases, debt ledger, payments and cashbook reversals')
ON CONFLICT (version) DO NOTHING;

COMMIT;
