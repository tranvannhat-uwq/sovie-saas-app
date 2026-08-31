BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0087') THEN
    RAISE EXCEPTION 'Migration 0088 requires migration 0087';
  END IF;
END;
$prerequisite$;

-- SECURITY INVOKER is PostgreSQL's default and is omitted by
-- pg_get_functiondef(), so migration 0087's text replacement could not change
-- the six functions that originally relied on the default. Make the execution
-- mode explicit while retaining the NOBYPASSRLS saas_rpc_executor owner.
ALTER FUNCTION public.rpc_mobile_admin_dashboard(jsonb) SECURITY DEFINER;
ALTER FUNCTION public.rpc_mobile_orders_paginated(text, text, int, int) SECURITY DEFINER;
ALTER FUNCTION public.rpc_mobile_order_detail(text, text) SECURITY DEFINER;
ALTER FUNCTION public.rpc_mobile_customers_paginated(text, int, int) SECURITY DEFINER;
ALTER FUNCTION public.rpc_mobile_customer_detail(text) SECURITY DEFINER;
ALTER FUNCTION public.rpc_mobile_customer_debts(text, int, int) SECURITY DEFINER;
ALTER FUNCTION public.rpc_mobile_customer_debt_transactions(text, int, int) SECURITY DEFINER;
ALTER FUNCTION public.rpc_mobile_employees(text, int, int, timestamptz, timestamptz) SECURITY DEFINER;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0088', 'Enforce SECURITY DEFINER on every mobile Admin read model')
ON CONFLICT (version) DO NOTHING;

COMMIT;
