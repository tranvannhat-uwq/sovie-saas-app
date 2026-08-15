BEGIN;

-- Keep manual corrections compatible with the signed balance convention added
-- in 0019: positive means receivable, negative means customer advance credit.
CREATE OR REPLACE FUNCTION public.rpc_adjust_customer_debt(
  p_customer_id text, p_new_debt numeric, p_description text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  ledger_id text;
  normalized_debt numeric;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF p_customer_id IS NULL OR btrim(p_customer_id) = '' OR p_new_debt IS NULL
     OR p_new_debt::text IN ('NaN', 'Infinity', '-Infinity') THEN
    RAISE EXCEPTION 'Customer and a finite debt balance are required';
  END IF;
  IF p_description IS NULL OR length(btrim(p_description)) < 3 THEN
    RAISE EXCEPTION 'A debt adjustment reason is required';
  END IF;

  normalized_debt := round(p_new_debt);
  SELECT * INTO STRICT customer_row
  FROM public.customers
  WHERE id = p_customer_id
  FOR UPDATE;

  IF round(COALESCE(customer_row.debt, 0)) = normalized_debt THEN
    RETURN jsonb_build_object('success', true, 'already_at_balance', true,
      'new_debt', normalized_debt, 'debt_change', 0);
  END IF;

  ledger_id := 'DTX-ADJ-' || gen_random_uuid()::text;
  INSERT INTO public.customer_debt_transactions(
    id, customer_id, transaction_type, amount, debt_change, balance_before,
    balance_after, description, created_by, transaction_date
  ) VALUES (
    ledger_id, customer_row.id, 'adjust', ABS(normalized_debt - round(COALESCE(customer_row.debt, 0))),
    normalized_debt - round(COALESCE(customer_row.debt, 0)), round(COALESCE(customer_row.debt, 0)), normalized_debt,
    btrim(p_description), actor.auth_user_id::text, now()
  );

  UPDATE public.customers
  SET debt = normalized_debt, updated_at = now(), updated_by = actor.auth_user_id::text
  WHERE id = customer_row.id;

  INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
  VALUES ('customers', 'ADJUST_DEBT', customer_row.id,
    jsonb_build_object('debt', round(COALESCE(customer_row.debt, 0))),
    jsonb_build_object('debt', normalized_debt, 'ledger_id', ledger_id,
      'reason', btrim(p_description)), actor.auth_user_id::text, now());

  RETURN jsonb_build_object('success', true, 'ledger_id', ledger_id,
    'new_debt', normalized_debt,
    'debt_change', normalized_debt - round(COALESCE(customer_row.debt, 0)),
    'performed_by', actor.auth_user_id::text);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_adjust_customer_debt(text, numeric, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_customer_debt(text, numeric, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0020', 'Allow audited customer debt corrections including advance credit')
ON CONFLICT (version) DO NOTHING;

COMMIT;
