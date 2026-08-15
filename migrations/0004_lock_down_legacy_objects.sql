BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_cancel_customer_payment(
  p_cashbook_id text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  v_customer_id text; v_status text; v_amount numeric; v_original_change numeric;
  v_before numeric; v_after numeric; v_reversal_id text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN
    RAISE EXCEPTION '403: accounting role required' USING ERRCODE = '42501';
  END IF;
  IF p_cashbook_id IS NULL OR p_cashbook_id = '' THEN
    RAISE EXCEPTION 'Cashbook transaction ID cannot be null';
  END IF;
  SELECT customer_id, status, COALESCE(value, 0)
    INTO STRICT v_customer_id, v_status, v_amount
  FROM public.cashbook_transactions WHERE id = p_cashbook_id FOR UPDATE;
  IF v_customer_id IS NULL OR v_customer_id = '' THEN
    RAISE EXCEPTION 'Receipt is not linked to a customer';
  END IF;
  SELECT debt_change INTO STRICT v_original_change
  FROM public.customer_debt_transactions
  WHERE cashbook_transaction_id = p_cashbook_id AND transaction_type = 'payment'
  ORDER BY transaction_date LIMIT 1;
  SELECT COALESCE(debt, 0) INTO STRICT v_before
  FROM public.customers WHERE id = v_customer_id FOR UPDATE;
  v_reversal_id := 'dtx-void-' || p_cashbook_id;
  IF v_status IN ('cancelled', 'canceled', 'Da huy')
     OR EXISTS (SELECT 1 FROM public.customer_debt_transactions WHERE id = v_reversal_id) THEN
    RETURN jsonb_build_object('success', true, 'already_cancelled', true,
      'customer_id', v_customer_id, 'new_debt', v_before);
  END IF;
  v_after := v_before - v_original_change;
  INSERT INTO public.customer_debt_transactions (
    id, customer_id, transaction_type, amount, debt_change, balance_before,
    balance_after, cashbook_transaction_id, description, created_by, transaction_date
  ) VALUES (
    v_reversal_id, v_customer_id, 'adjust', v_amount, -v_original_change,
    v_before, v_after, p_cashbook_id, 'Cancel receipt ' || p_cashbook_id,
    actor.auth_user_id::text, now()
  );
  UPDATE public.customers SET debt = v_after, updated_at = now() WHERE id = v_customer_id;
  UPDATE public.cashbook_transactions SET status = 'cancelled' WHERE id = p_cashbook_id;
  IF to_regclass('public.commission_transactions') IS NOT NULL THEN
    UPDATE public.commission_transactions SET status = 'cancelled'
    WHERE cashbook_transaction_id = p_cashbook_id;
  END IF;
  RETURN jsonb_build_object('success', true, 'customer_id', v_customer_id,
    'new_debt', v_after, 'debt_change', -v_original_change,
    'performed_by', actor.auth_user_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_customers_paginated(
  p_search text DEFAULT '', p_managed_by text DEFAULT NULL,
  p_limit int DEFAULT 50, p_offset int DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_total bigint; v_data jsonb; safe_limit int := LEAST(GREATEST(p_limit, 1), 500);
BEGIN
  PERFORM public.require_authenticated_profile();
  SELECT count(*) INTO v_total FROM public.customers
  WHERE (p_search = '' OR code ILIKE '%' || p_search || '%' OR name ILIKE '%' || p_search || '%' OR phone ILIKE '%' || p_search || '%')
    AND (p_managed_by IS NULL OR p_managed_by = 'all' OR managed_by = p_managed_by);
  SELECT jsonb_agg(to_jsonb(customer_page)) INTO v_data FROM (
    SELECT * FROM public.customers
    WHERE (p_search = '' OR code ILIKE '%' || p_search || '%' OR name ILIKE '%' || p_search || '%' OR phone ILIKE '%' || p_search || '%')
      AND (p_managed_by IS NULL OR p_managed_by = 'all' OR managed_by = p_managed_by)
    ORDER BY created_at DESC LIMIT safe_limit OFFSET GREATEST(p_offset, 0)
  ) customer_page;
  RETURN jsonb_build_object('total', v_total, 'limit', safe_limit,
    'offset', GREATEST(p_offset, 0), 'data', COALESCE(v_data, '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_orders_paginated(
  p_search text DEFAULT '', p_status text DEFAULT NULL, p_customer_id text DEFAULT NULL,
  p_limit int DEFAULT 50, p_offset int DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, public AS $$
DECLARE v_total bigint; v_data jsonb; safe_limit int := LEAST(GREATEST(p_limit, 1), 500);
BEGIN
  PERFORM public.require_authenticated_profile();
  SELECT count(*) INTO v_total FROM public.orders
  WHERE (p_search = '' OR id ILIKE '%' || p_search || '%' OR customer_name ILIKE '%' || p_search || '%')
    AND (p_status IS NULL OR p_status = 'all' OR status = p_status)
    AND (p_customer_id IS NULL OR customer_id = p_customer_id);
  SELECT jsonb_agg(to_jsonb(order_page)) INTO v_data FROM (
    SELECT * FROM public.orders
    WHERE (p_search = '' OR id ILIKE '%' || p_search || '%' OR customer_name ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status = 'all' OR status = p_status)
      AND (p_customer_id IS NULL OR customer_id = p_customer_id)
    ORDER BY order_date DESC, created_at DESC LIMIT safe_limit OFFSET GREATEST(p_offset, 0)
  ) order_page;
  RETURN jsonb_build_object('total', v_total, 'limit', safe_limit,
    'offset', GREATEST(p_offset, 0), 'data', COALESCE(v_data, '[]'::jsonb));
END;
$$;

CREATE OR REPLACE FUNCTION public.p0_force_actor_column()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
      RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;
  NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], auth.uid()::text));
  RETURN NEW;
END;
$$;

DO $migration$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'customers', 'products', 'pricelists', 'orders', 'draft_orders', 'payments', 'cashbook_transactions',
    'customer_debt_transactions', 'sales_returns', 'production_logs'
  ] LOOP
    IF to_regclass('public.' || target) IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = target AND column_name = 'created_by'
       ) THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS p0_force_created_by ON public.%I', target);
    EXECUTE format(
      'CREATE TRIGGER p0_force_created_by BEFORE INSERT ON public.%I FOR EACH ROW EXECUTE FUNCTION public.p0_force_actor_column(''created_by'')',
      target
    );
  END LOOP;
END
$migration$;

DO $migration$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'customers', 'products', 'pricelists', 'price_list_items', 'orders',
    'draft_orders', 'payments', 'cashbook_transactions',
    'customer_debt_transactions', 'sales_returns', 'production_logs'
  ] LOOP
    IF to_regclass('public.' || target) IS NULL
       OR NOT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = target AND column_name = 'updated_by'
       ) THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS p0_force_updated_by ON public.%I', target);
    EXECUTE format(
      'CREATE TRIGGER p0_force_updated_by BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.p0_force_actor_column(''updated_by'')',
      target
    );
  END LOOP;
END
$migration$;

CREATE OR REPLACE FUNCTION public.p0_force_cancelled_by()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.status IN ('cancelled', 'canceled')
     AND COALESCE(OLD.status, '') NOT IN ('cancelled', 'canceled') THEN
    IF auth.uid() IS NULL THEN
      IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
      END IF;
      RETURN NEW;
    END IF;
    NEW := jsonb_populate_record(NEW, jsonb_build_object(TG_ARGV[0], auth.uid()::text));
  END IF;
  RETURN NEW;
END;
$$;

DO $migration$
DECLARE target text; actor_column text;
BEGIN
  FOREACH target IN ARRAY ARRAY['orders', 'payments', 'sales_returns', 'cashbook_transactions'] LOOP
    IF to_regclass('public.' || target) IS NULL THEN CONTINUE; END IF;
    actor_column := NULL;
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = target AND column_name = 'cancelled_by'
    ) THEN actor_column := 'cancelled_by';
    ELSIF EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = target AND column_name = 'canceled_by'
    ) THEN actor_column := 'canceled_by';
    END IF;
    IF actor_column IS NULL OR NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = target AND column_name = 'status'
    ) THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS p0_force_cancelled_by ON public.%I', target);
    EXECUTE format(
      'CREATE TRIGGER p0_force_cancelled_by BEFORE UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.p0_force_cancelled_by(%L)',
      target, actor_column
    );
  END LOOP;
END
$migration$;

CREATE OR REPLACE FUNCTION public.rpc_log_audit_trail()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor text := COALESCE(auth.uid()::text, 'system');
BEGIN
  IF TG_OP = 'DELETE' THEN
    INSERT INTO public.audit_logs(table_name, action, record_id, old_data, performed_by, created_at)
    VALUES (TG_TABLE_NAME, 'DELETE', to_jsonb(OLD)->>'id', to_jsonb(OLD), actor, now());
    RETURN OLD;
  ELSIF TG_OP = 'UPDATE' THEN
    INSERT INTO public.audit_logs(table_name, action, record_id, old_data, new_data, performed_by, created_at)
    VALUES (TG_TABLE_NAME, 'UPDATE', to_jsonb(NEW)->>'id', to_jsonb(OLD), to_jsonb(NEW), actor, now());
    RETURN NEW;
  END IF;
  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES (TG_TABLE_NAME, 'INSERT', to_jsonb(NEW)->>'id', to_jsonb(NEW), actor, now());
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_customers ON public.customers;
DROP TRIGGER IF EXISTS trg_audit_orders ON public.orders;
DROP TRIGGER IF EXISTS trg_audit_returns ON public.sales_returns;

DO $migration$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'profiles', 'customers', 'products', 'pricelists', 'price_list_items',
    'orders', 'order_items', 'draft_orders', 'payments',
    'customer_debt_transactions', 'cashbook_transactions', 'sales_returns',
    'sales_return_items', 'finished_goods_stock'
  ] LOOP
    IF to_regclass('public.' || target) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS p0_audit_row ON public.%I', target);
    EXECUTE format(
      'CREATE TRIGGER p0_audit_row AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.rpc_log_audit_trail()',
      target
    );
  END LOOP;
END
$migration$;

-- PUBLIC includes anon. Remove inherited execution first, then grant only the
-- reviewed API surface to authenticated users.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

DO $migration$
DECLARE view_name text;
BEGIN
  FOR view_name IN
    SELECT table_name FROM information_schema.views WHERE table_schema = 'public'
  LOOP
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', view_name);
  END LOOP;
END
$migration$;

GRANT EXECUTE ON FUNCTION public.current_profile_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_profile_username() TO authenticated;
GRANT EXECUTE ON FUNCTION public.require_authenticated_profile() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin_or_accounting() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_current_username() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_customer(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_price_list(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_order_price_lists(text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_customer_payment(text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_customer_payment(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_sales_return(text, text, numeric, text, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_sales_return(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_adjust_customer_debt(text, numeric, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_customers_paginated(text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_orders_paginated(text, text, text, int, int) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0004', 'Lock down legacy functions, actor stamping, and read RPCs')
ON CONFLICT (version) DO NOTHING;

COMMIT;
