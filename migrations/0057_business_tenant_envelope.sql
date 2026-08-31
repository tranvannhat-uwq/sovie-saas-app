BEGIN;

-- Phase 2A: add and backfill the tenant envelope without changing existing
-- RLS policies or SECURITY DEFINER RPC behavior yet. Isolation is complete
-- only after the follow-up migration scopes every relationship, RPC and policy.
CREATE OR REPLACE FUNCTION public.enforce_business_row_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'organization_id is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.organization_id IS NULL THEN
    IF active_organization_id IS NULL THEN
      RAISE EXCEPTION 'organization_id is required'
        USING ERRCODE = '23502';
    END IF;
    NEW.organization_id := active_organization_id;
  END IF;

  -- Authenticated browser callers can never select a tenant in their payload.
  -- Trusted SQL/service operations have no auth.uid() and must be explicit.
  IF auth.uid() IS NOT NULL
     AND (active_organization_id IS NULL
       OR NEW.organization_id <> active_organization_id) THEN
    RAISE EXCEPTION 'cross-organization write rejected'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_business_row_organization()
  FROM PUBLIC, anon, authenticated;

-- draft_orders was created with LIKE ... INCLUDING DEFAULTS and has no primary
-- key. It is already part of the Realtime publication, so PostgreSQL requires
-- a replica identity before the tenant backfill can update its rows.
ALTER TABLE public.draft_orders REPLICA IDENTITY FULL;

DO $tenant_envelope$
DECLARE
  table_name text;
  business_tables constant text[] := ARRAY[
    'companies', 'customers', 'brands', 'product_groups', 'products',
    'pricelists', 'price_list_items', 'orders', 'draft_orders', 'order_items',
    'cashbook_transactions', 'payments', 'sales_returns', 'sales_return_items',
    'customer_debt_transactions', 'finished_goods_stock', 'raw_materials',
    'semi_finished', 'recipes', 'production_logs', 'audit_logs',
    'commission_transactions', 'customer_assignments', 'commission_rules',
    'starting_balances', 'suppliers', 'purchases', 'purchase_items',
    'purchase_payments', 'supplier_debt_transactions', 'kpi_targets',
    'payroll_periods', 'payroll_adjustments', 'payroll_entries', 'activity_logs'
  ];
  legacy_organization_id constant uuid :=
    '00000000-0000-4000-8000-000000000001'::uuid;
  missing_rows bigint;
BEGIN
  FOREACH table_name IN ARRAY business_tables LOOP
    IF to_regclass(format('public.%I', table_name)) IS NULL THEN
      RAISE EXCEPTION 'Required business table public.% is missing', table_name;
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I ADD COLUMN IF NOT EXISTS organization_id uuid',
      table_name
    );

    EXECUTE format(
      'UPDATE public.%I SET organization_id = $1 WHERE organization_id IS NULL',
      table_name
    ) USING legacy_organization_id;

    EXECUTE format(
      'SELECT count(*) FROM public.%I WHERE organization_id IS NULL',
      table_name
    ) INTO missing_rows;
    IF missing_rows <> 0 THEN
      RAISE EXCEPTION 'Tenant backfill left % rows unassigned in public.%',
        missing_rows, table_name;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM pg_constraint
      WHERE conrelid = format('public.%I', table_name)::regclass
        AND conname = table_name || '_organization_id_fkey'
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT NOT VALID',
        table_name,
        table_name || '_organization_id_fkey'
      );
    END IF;

    EXECUTE format(
      'ALTER TABLE public.%I VALIDATE CONSTRAINT %I',
      table_name,
      table_name || '_organization_id_fkey'
    );
    EXECUTE format(
      'ALTER TABLE public.%I ALTER COLUMN organization_id SET DEFAULT public.current_organization_id()',
      table_name
    );
    EXECUTE format(
      'CREATE INDEX IF NOT EXISTS %I ON public.%I (organization_id)',
      table_name || '_organization_id_idx',
      table_name
    );
    EXECUTE format(
      'DROP TRIGGER IF EXISTS %I ON public.%I',
      table_name || '_organization_guard',
      table_name
    );
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.enforce_business_row_organization()',
      table_name || '_organization_guard',
      table_name
    );
  END LOOP;
END;
$tenant_envelope$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0057', 'Add and backfill organization tenant envelope on every business table')
ON CONFLICT (version) DO NOTHING;

COMMIT;
