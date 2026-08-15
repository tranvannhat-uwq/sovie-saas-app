BEGIN;

-- A customer receipt can be amended several times. Its cashbook row contains
-- the final effective value, while the original immutable payment ledger keeps
-- the first value. Cancellation must reverse the current voucher value rather
-- than the original ledger value.
DO $migration$
DECLARE
  current_definition text;
  old_delta_statement text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_cancel_cashbook_entry(text,text)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0050 stopped: rpc_cancel_cashbook_entry(text,text) is missing';
  END IF;

  IF current_definition NOT LIKE '%0050: reverse the current effective voucher value%' THEN
    old_delta_statement := substring(
      current_definition
      FROM 'debt_delta[[:space:]]*:=[[:space:]]*CASE WHEN original_customer_ledger[.]id IS NULL[^;]+END;'
    );
    IF old_delta_statement IS NULL THEN
      RAISE EXCEPTION 'Migration 0050 stopped: legacy customer receipt cancellation formula was not found';
    END IF;

    current_definition := replace(
      current_definition,
      old_delta_statement,
      E'-- 0050: reverse the current effective voucher value after all amendments.\n'
        || E'    debt_delta := round(COALESCE(entry.value, 0));'
    );
    EXECUTE current_definition;
  END IF;
END
$migration$;

ALTER FUNCTION public.rpc_cancel_cashbook_entry(text, text) SECURITY DEFINER;
ALTER FUNCTION public.rpc_cancel_cashbook_entry(text, text) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.rpc_cancel_cashbook_entry(text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_cashbook_entry(text, text) TO authenticated;

-- Repair the one confirmed affected voucher without rewriting append-only
-- history. Every expected identity and amount is checked before the correction.
DO $repair$
DECLARE
  target_customer public.customers%ROWTYPE;
  target_voucher public.cashbook_transactions%ROWTYPE;
  cancellation public.customer_debt_transactions%ROWTYPE;
  correction_id constant text := 'DTX-FIX-0050-PT-20260810-00000146';
  target_customer_count integer;
  target_voucher_count integer;
  cancellation_count integer;
  excess_debt numeric;
  corrected_debt numeric;
BEGIN
  IF EXISTS (SELECT 1 FROM public.customer_debt_transactions WHERE id = correction_id) THEN
    RETURN;
  END IF;

  SELECT count(*) INTO target_customer_count
  FROM public.customers customer
  WHERE customer.code = 'KH000003';

  SELECT count(*) INTO target_voucher_count
  FROM public.cashbook_transactions voucher
  WHERE voucher.id = 'PT-20260810-00000146';

  SELECT count(*) INTO cancellation_count
  FROM public.customer_debt_transactions ledger
  WHERE ledger.id = 'DTX-P13-VOID-PT-20260810-00000146'
    AND ledger.transaction_type = 'payment_cancel';

  -- Clean staging projects do not contain this production-specific incident.
  -- Skip only when the complete target set is absent. A partial set remains an
  -- error because it can indicate an unexpected or incomplete data restore.
  IF target_customer_count = 0
     AND target_voucher_count = 0
     AND cancellation_count = 0 THEN
    RAISE NOTICE 'Migration 0050: confirmed KH000003 repair target is absent; skipping data repair';
    RETURN;
  END IF;
  IF target_customer_count <> 1
     OR target_voucher_count <> 1
     OR cancellation_count <> 1 THEN
    RAISE EXCEPTION 'Migration 0050 stopped: confirmed repair target is incomplete (customer %, voucher %, cancellation %)',
      target_customer_count, target_voucher_count, cancellation_count;
  END IF;

  SELECT customer.* INTO STRICT target_customer
  FROM public.customers customer
  WHERE customer.code = 'KH000003'
  FOR UPDATE;

  SELECT voucher.* INTO STRICT target_voucher
  FROM public.cashbook_transactions voucher
  WHERE voucher.id = 'PT-20260810-00000146'
  FOR UPDATE;

  SELECT ledger.* INTO STRICT cancellation
  FROM public.customer_debt_transactions ledger
  WHERE ledger.id = 'DTX-P13-VOID-PT-20260810-00000146'
    AND ledger.transaction_type = 'payment_cancel'
  FOR UPDATE;

  IF target_voucher.customer_id IS DISTINCT FROM target_customer.id
     OR cancellation.customer_id IS DISTINCT FROM target_customer.id THEN
    RAISE EXCEPTION 'Migration 0050 stopped: confirmed voucher/customer relationship changed';
  END IF;
  IF round(COALESCE(target_voucher.value, 0)) <> 5000
     OR round(COALESCE(cancellation.debt_change, 0)) <> 10000000
     OR round(COALESCE(target_customer.debt, 0)) <> 20587100 THEN
    RAISE EXCEPTION 'Migration 0050 stopped: confirmed debt values changed; manual review is required';
  END IF;

  excess_debt := round(cancellation.debt_change) - round(target_voucher.value);
  corrected_debt := round(target_customer.debt) - excess_debt;
  IF excess_debt <> 9995000 OR corrected_debt <> 10592100 THEN
    RAISE EXCEPTION 'Migration 0050 stopped: correction does not match the confirmed balance';
  END IF;

  INSERT INTO public.customer_debt_transactions(
    id, customer_id, transaction_type, amount, debt_change, balance_before,
    balance_after, cashbook_transaction_id, amends_ledger_id, description,
    created_by, transaction_date
  ) VALUES (
    correction_id, target_customer.id, 'adjust', excess_debt, -excess_debt,
    round(target_customer.debt), corrected_debt, target_voucher.id, cancellation.id,
    'Hiệu chỉnh hủy phiếu thu đã sửa: chỉ hoàn giá trị hiệu lực 5.000đ',
    'migration-0050', now()
  );

  UPDATE public.customers
  SET debt = corrected_debt,
      updated_at = now(),
      updated_by = 'migration-0050'
  WHERE id = target_customer.id;

  INSERT INTO public.audit_logs(
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'customers', 'DEBT_REPAIR', target_customer.id,
    jsonb_build_object('debt', target_customer.debt, 'voucher_id', target_voucher.id,
      'cancellation_ledger_id', cancellation.id),
    jsonb_build_object('debt', corrected_debt, 'correction_ledger_id', correction_id,
      'excess_reversed', excess_debt),
    'migration-0050', now()
  );
END
$repair$;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'rpc_cancel_cashbook_entry'
      AND pg_get_function_identity_arguments(procedure.oid) = 'p_cashbook_id text, p_reason text'
      AND procedure.prosrc LIKE '%0050: reverse the current effective voucher value%'
      AND procedure.prosrc LIKE '%debt_delta := round(COALESCE(entry.value, 0));%'
      AND procedure.prosecdef
  ) OR NOT (
    EXISTS (
      SELECT 1
      FROM public.customers customer
      JOIN public.customer_debt_transactions correction
        ON correction.customer_id = customer.id
       AND correction.id = 'DTX-FIX-0050-PT-20260810-00000146'
      WHERE customer.code = 'KH000003'
        AND round(customer.debt) = 10592100
        AND round(correction.debt_change) = -9995000
        AND round(correction.balance_after) = 10592100
    ) OR (
      NOT EXISTS (SELECT 1 FROM public.customers WHERE code = 'KH000003')
      AND NOT EXISTS (SELECT 1 FROM public.cashbook_transactions WHERE id = 'PT-20260810-00000146')
      AND NOT EXISTS (
        SELECT 1 FROM public.customer_debt_transactions
        WHERE id = 'DTX-P13-VOID-PT-20260810-00000146'
          AND transaction_type = 'payment_cancel'
      )
    )
  ) THEN
    RAISE EXCEPTION 'Migration 0050 stopped: cancellation fix or confirmed debt repair was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0050', 'Cancel amended customer receipts at their effective value and repair KH000003')
ON CONFLICT (version) DO NOTHING;

COMMIT;
