BEGIN;

-- Imported baselines are tracked separately so retrying an Excel import
-- replaces its prior contribution and preserves later operational activity.
ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS imported_debt_baseline numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imported_total_transaction_baseline numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imported_total_return_baseline numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imported_net_revenue_baseline numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS imported_last_order_at_baseline timestamptz,
  ADD COLUMN IF NOT EXISTS imported_created_at_baseline timestamptz,
  ADD COLUMN IF NOT EXISTS financial_baseline_imported_at timestamptz;

-- Direct browser writes remain blocked for operational and imported values.
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
      OR COALESCE(NEW.imported_debt_baseline, 0) <> 0
      OR COALESCE(NEW.imported_total_transaction_baseline, 0) <> 0
      OR COALESCE(NEW.imported_total_return_baseline, 0) <> 0
      OR COALESCE(NEW.imported_net_revenue_baseline, 0) <> 0
      OR NEW.imported_last_order_at_baseline IS NOT NULL
      OR NEW.imported_created_at_baseline IS NOT NULL
      OR NEW.financial_baseline_imported_at IS NOT NULL
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
      OR NEW.imported_debt_baseline IS DISTINCT FROM OLD.imported_debt_baseline
      OR NEW.imported_total_transaction_baseline IS DISTINCT FROM OLD.imported_total_transaction_baseline
      OR NEW.imported_total_return_baseline IS DISTINCT FROM OLD.imported_total_return_baseline
      OR NEW.imported_net_revenue_baseline IS DISTINCT FROM OLD.imported_net_revenue_baseline
      OR NEW.imported_last_order_at_baseline IS DISTINCT FROM OLD.imported_last_order_at_baseline
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.imported_created_at_baseline IS DISTINCT FROM OLD.imported_created_at_baseline
      OR NEW.financial_baseline_imported_at IS DISTINCT FROM OLD.financial_baseline_imported_at
    ) THEN
      RAISE EXCEPTION 'Customer financial balances can only change through a reviewed financial RPC'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p2_customer_debt_update_guard ON public.customers;
CREATE TRIGGER p2_customer_debt_update_guard
BEFORE UPDATE OF debt, total_transaction, total_return, net_revenue,
  last_order_at, last_payment_at, imported_debt_baseline,
  imported_total_transaction_baseline, imported_total_return_baseline,
  imported_net_revenue_baseline, imported_last_order_at_baseline, created_at,
  imported_created_at_baseline,
  financial_baseline_imported_at
ON public.customers
FOR EACH ROW EXECUTE FUNCTION public.p2_guard_customer_debt();

CREATE OR REPLACE FUNCTION public.rpc_import_customer_financial_baselines(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict error
DECLARE
  v_actor public.profiles%ROWTYPE;
  v_item jsonb;
  v_customer_row public.customers%ROWTYPE;
  v_customer_id text;
  v_imported_debt numeric;
  v_imported_total numeric;
  v_imported_returns numeric;
  v_imported_net numeric;
  v_imported_last_order timestamptz;
  v_imported_created timestamptz;
  v_operational_last_order timestamptz;
  v_imported_at timestamptz;
  v_next_debt numeric;
  v_next_total numeric;
  v_next_returns numeric;
  v_next_net numeric;
  v_debt_delta numeric;
  v_ledger_id text;
  v_processed_count integer := 0;
BEGIN
  v_actor := public.require_authenticated_profile();
  IF v_actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_rows) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Customer baseline payload must be a JSON array';
  END IF;
  IF jsonb_array_length(p_rows) < 1 OR jsonb_array_length(p_rows) > 250 THEN
    RAISE EXCEPTION 'Customer baseline payload must contain between 1 and 250 rows';
  END IF;

  FOR v_item IN SELECT payload.value FROM jsonb_array_elements(p_rows) AS payload(value)
  LOOP
    v_customer_id := NULLIF(btrim(v_item->>'id'), '');
    IF v_customer_id IS NULL THEN RAISE EXCEPTION 'Customer baseline row is missing id'; END IF;
    BEGIN
      v_imported_debt := round(NULLIF(v_item->>'debt', '')::numeric);
      v_imported_total := round(NULLIF(v_item->>'totalTransaction', '')::numeric);
      v_imported_returns := round(NULLIF(v_item->>'totalReturn', '')::numeric);
      v_imported_net := round(NULLIF(v_item->>'netRevenue', '')::numeric);
      v_imported_last_order := NULLIF(v_item->>'lastOrderAt', '')::timestamptz;
      v_imported_created := NULLIF(v_item->>'createdAt', '')::timestamptz;
      v_imported_at := COALESCE(NULLIF(v_item->>'importedAt', '')::timestamptz, now());
    EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR numeric_value_out_of_range THEN
      RAISE EXCEPTION 'Invalid financial baseline for customer %', v_customer_id;
    END;

    IF abs(v_imported_debt) > 1000000000000000
       OR abs(v_imported_total) > 1000000000000000
       OR abs(v_imported_returns) > 1000000000000000
       OR abs(v_imported_net) > 1000000000000000 THEN
      RAISE EXCEPTION 'Financial baseline is outside the allowed range for customer %', v_customer_id;
    END IF;

    SELECT customer_source.* INTO STRICT v_customer_row
    FROM public.customers customer_source
    WHERE customer_source.id = v_customer_id
    FOR UPDATE;

    v_imported_debt := COALESCE(v_imported_debt, v_customer_row.imported_debt_baseline, 0);
    v_imported_total := COALESCE(v_imported_total, v_customer_row.imported_total_transaction_baseline, 0);
    v_imported_returns := COALESCE(v_imported_returns, v_customer_row.imported_total_return_baseline, 0);
    v_imported_net := COALESCE(v_imported_net, v_customer_row.imported_net_revenue_baseline,
      v_imported_total - v_imported_returns);
    v_imported_last_order := COALESCE(v_imported_last_order,
      v_customer_row.imported_last_order_at_baseline);
    v_imported_created := COALESCE(v_imported_created,
      v_customer_row.imported_created_at_baseline);

    SELECT max(COALESCE(sale.order_date, sale.confirmed_at, sale.created_at))
    INTO v_operational_last_order
    FROM public.orders sale
    WHERE sale.customer_id = v_customer_id
      AND COALESCE(sale.status, '') NOT IN ('cancelled', 'draft');

    v_debt_delta := v_imported_debt - COALESCE(v_customer_row.imported_debt_baseline, 0);
    v_next_debt := round(COALESCE(v_customer_row.debt, 0) + v_debt_delta);
    v_next_total := round(COALESCE(v_customer_row.total_transaction, 0)
      + v_imported_total - COALESCE(v_customer_row.imported_total_transaction_baseline, 0));
    v_next_returns := round(COALESCE(v_customer_row.total_return, 0)
      + v_imported_returns - COALESCE(v_customer_row.imported_total_return_baseline, 0));
    v_next_net := round(COALESCE(v_customer_row.net_revenue, 0)
      + v_imported_net - COALESCE(v_customer_row.imported_net_revenue_baseline, 0));

    IF v_debt_delta <> 0 THEN
      v_ledger_id := 'DTX-IMPORT-' || gen_random_uuid()::text;
      INSERT INTO public.customer_debt_transactions(
        id, customer_id, transaction_type, amount, debt_change, balance_before,
        balance_after, description, created_by, transaction_date
      ) VALUES (
        v_ledger_id, v_customer_row.id, 'adjust', abs(v_debt_delta), v_debt_delta,
        round(COALESCE(v_customer_row.debt, 0)), v_next_debt,
        'Nhập số dư đầu kỳ từ file khách hàng', v_actor.auth_user_id::text, v_imported_at
      );
    ELSE
      v_ledger_id := NULL;
    END IF;

    UPDATE public.customers
    SET debt = v_next_debt,
        total_transaction = v_next_total,
        total_return = v_next_returns,
        net_revenue = v_next_net,
        last_order_at = CASE
          WHEN v_imported_last_order IS NULL THEN v_operational_last_order
          WHEN v_operational_last_order IS NULL THEN v_imported_last_order
          ELSE GREATEST(v_imported_last_order, v_operational_last_order)
        END,
        created_at = COALESCE(v_imported_created, v_customer_row.created_at),
        imported_debt_baseline = v_imported_debt,
        imported_total_transaction_baseline = v_imported_total,
        imported_total_return_baseline = v_imported_returns,
        imported_net_revenue_baseline = v_imported_net,
        imported_last_order_at_baseline = v_imported_last_order,
        imported_created_at_baseline = v_imported_created,
        financial_baseline_imported_at = v_imported_at,
        updated_at = now(),
        updated_by = v_actor.auth_user_id::text
    WHERE customers.id = v_customer_row.id;

    INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
    VALUES ('customers', 'IMPORT_FINANCIAL_BASELINE', v_customer_row.id,
      jsonb_build_object('debt', v_customer_row.debt, 'total_transaction', v_customer_row.total_transaction,
        'total_return', v_customer_row.total_return, 'net_revenue', v_customer_row.net_revenue,
        'imported_debt_baseline', v_customer_row.imported_debt_baseline,
        'imported_total_transaction_baseline', v_customer_row.imported_total_transaction_baseline,
        'imported_total_return_baseline', v_customer_row.imported_total_return_baseline,
        'imported_net_revenue_baseline', v_customer_row.imported_net_revenue_baseline,
        'created_at', v_customer_row.created_at,
        'imported_created_at_baseline', v_customer_row.imported_created_at_baseline,
        'imported_last_order_at_baseline', v_customer_row.imported_last_order_at_baseline),
      jsonb_build_object('debt', v_next_debt, 'total_transaction', v_next_total,
        'total_return', v_next_returns, 'net_revenue', v_next_net,
        'imported_debt_baseline', v_imported_debt,
        'imported_total_transaction_baseline', v_imported_total,
        'imported_total_return_baseline', v_imported_returns,
        'imported_net_revenue_baseline', v_imported_net,
        'created_at', COALESCE(v_imported_created, v_customer_row.created_at),
        'imported_created_at_baseline', v_imported_created,
        'imported_last_order_at_baseline', v_imported_last_order,
        'ledger_id', v_ledger_id),
      v_actor.auth_user_id::text, now());
    v_processed_count := v_processed_count + 1;
  END LOOP;

  RETURN jsonb_build_object('success', true, 'processed', v_processed_count);
END;
$$;

REVOKE ALL ON FUNCTION public.p2_guard_customer_debt() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_import_customer_financial_baselines(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_import_customer_financial_baselines(jsonb) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0015', 'Idempotent customer opening financial baseline import')
ON CONFLICT (version) DO NOTHING;

COMMIT;
