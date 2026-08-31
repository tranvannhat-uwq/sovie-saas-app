BEGIN;

-- Phase 3A: direct-table tenant boundary and relational identity. Existing
-- SECURITY DEFINER business RPCs are audited/recompiled in the next migration.
DO $tenant_unique_keys$
DECLARE
  item record;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('activity_logs', 'activity_logs_organization_operation_target_key',
        'organization_id, operation_key, module, target_type, target_id',
        'activity_logs_one_target_per_operation_uidx'),
      ('companies', 'companies_organization_code_key',
        'organization_id, code', 'companies_code_key'),
      ('customers', 'customers_organization_code_key',
        'organization_id, code', 'customers_code_key'),
      ('kpi_targets', 'kpi_targets_organization_employee_period_type_key',
        'organization_id, employee_id, period, target_type',
        'kpi_targets_employee_id_period_target_type_key'),
      ('payroll_adjustments', 'payroll_adjustments_organization_period_employee_type_key',
        'organization_id, period, employee_id, adjustment_type',
        'payroll_adjustments_period_employee_id_adjustment_type_key'),
      ('payroll_entries', 'payroll_entries_organization_period_employee_key',
        'organization_id, period, employee_id',
        'payroll_entries_period_employee_id_key'),
      ('products', 'products_organization_code_brand_key',
        'organization_id, code, brand', 'products_code_brand_key'),
      ('purchase_items', 'purchase_items_organization_purchase_line_key',
        'organization_id, purchase_id, line_number',
        'purchase_items_purchase_id_line_number_key'),
      ('purchases', 'purchases_organization_code_key',
        'organization_id, code', 'purchases_code_key'),
      ('raw_materials', 'raw_materials_organization_code_key',
        'organization_id, code', 'raw_materials_code_key'),
      ('semi_finished', 'semi_finished_organization_code_key',
        'organization_id, code', 'semi_finished_code_key')
    ) AS definitions(table_name, scoped_name, scoped_columns, global_name)
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = format('public.%I', item.table_name)::regclass
        AND conname = item.scoped_name
    ) THEN
      EXECUTE format(
        'ALTER TABLE public.%I ADD CONSTRAINT %I UNIQUE (%s)',
        item.table_name, item.scoped_name, item.scoped_columns
      );
    END IF;
    EXECUTE format(
      'ALTER TABLE public.%I DROP CONSTRAINT IF EXISTS %I',
      item.table_name, item.global_name
    );
  END LOOP;
END;
$tenant_unique_keys$;

-- Composite parent identities used by tenant-safe foreign keys. Global ids
-- remain stable document identifiers while relationships also require tenant.
ALTER TABLE public.purchases
  ADD CONSTRAINT purchases_organization_id_id_key UNIQUE (organization_id, id);
ALTER TABLE public.suppliers
  ADD CONSTRAINT suppliers_organization_id_id_key UNIQUE (organization_id, id);
ALTER TABLE public.purchase_payments
  ADD CONSTRAINT purchase_payments_organization_id_id_key UNIQUE (organization_id, id);
ALTER TABLE public.payroll_periods
  ADD CONSTRAINT payroll_periods_organization_period_key UNIQUE (organization_id, period);

ALTER TABLE public.payroll_adjustments
  DROP CONSTRAINT payroll_adjustments_period_fkey;
ALTER TABLE public.payroll_adjustments
  ADD CONSTRAINT payroll_adjustments_organization_period_fkey
  FOREIGN KEY (organization_id, period)
  REFERENCES public.payroll_periods (organization_id, period) NOT VALID;

ALTER TABLE public.payroll_entries
  DROP CONSTRAINT payroll_entries_period_fkey;
ALTER TABLE public.payroll_entries
  ADD CONSTRAINT payroll_entries_organization_period_fkey
  FOREIGN KEY (organization_id, period)
  REFERENCES public.payroll_periods (organization_id, period) NOT VALID;

ALTER TABLE public.purchase_items
  DROP CONSTRAINT purchase_items_purchase_id_fkey;
ALTER TABLE public.purchase_items
  ADD CONSTRAINT purchase_items_organization_purchase_fkey
  FOREIGN KEY (organization_id, purchase_id)
  REFERENCES public.purchases (organization_id, id) NOT VALID;

ALTER TABLE public.purchase_payments
  DROP CONSTRAINT purchase_payments_purchase_id_fkey,
  DROP CONSTRAINT purchase_payments_supplier_id_fkey;
ALTER TABLE public.purchase_payments
  ADD CONSTRAINT purchase_payments_organization_purchase_fkey
    FOREIGN KEY (organization_id, purchase_id)
    REFERENCES public.purchases (organization_id, id) NOT VALID,
  ADD CONSTRAINT purchase_payments_organization_supplier_fkey
    FOREIGN KEY (organization_id, supplier_id)
    REFERENCES public.suppliers (organization_id, id) NOT VALID;

ALTER TABLE public.purchases
  DROP CONSTRAINT purchases_supplier_id_fkey;
ALTER TABLE public.purchases
  ADD CONSTRAINT purchases_organization_supplier_fkey
  FOREIGN KEY (organization_id, supplier_id)
  REFERENCES public.suppliers (organization_id, id) NOT VALID;

ALTER TABLE public.supplier_debt_transactions
  DROP CONSTRAINT supplier_debt_transactions_payment_id_fkey,
  DROP CONSTRAINT supplier_debt_transactions_purchase_id_fkey,
  DROP CONSTRAINT supplier_debt_transactions_supplier_id_fkey;
ALTER TABLE public.supplier_debt_transactions
  ADD CONSTRAINT supplier_debt_transactions_organization_payment_fkey
    FOREIGN KEY (organization_id, payment_id)
    REFERENCES public.purchase_payments (organization_id, id) NOT VALID,
  ADD CONSTRAINT supplier_debt_transactions_organization_purchase_fkey
    FOREIGN KEY (organization_id, purchase_id)
    REFERENCES public.purchases (organization_id, id) NOT VALID,
  ADD CONSTRAINT supplier_debt_transactions_organization_supplier_fkey
    FOREIGN KEY (organization_id, supplier_id)
    REFERENCES public.suppliers (organization_id, id) NOT VALID;

DO $validate_tenant_fks$
DECLARE item record;
BEGIN
  FOR item IN
    SELECT conrelid::regclass AS table_name, conname
    FROM pg_constraint
    WHERE connamespace = 'public'::regnamespace
      AND conname LIKE '%\_organization\_%\_fkey' ESCAPE '\'
      AND NOT convalidated
  LOOP
    EXECUTE format('ALTER TABLE %s VALIDATE CONSTRAINT %I', item.table_name, item.conname);
  END LOOP;
END;
$validate_tenant_fks$;

-- Restrictive policies are ANDed with the existing role/assignment policies.
-- They close direct PostgREST/Realtime access across organizations without
-- broadening any existing permission.
DO $tenant_restrictive_rls$
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
BEGIN
  FOREACH table_name IN ARRAY business_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS tenant_organization_boundary ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_organization_boundary ON public.%I AS RESTRICTIVE FOR ALL TO authenticated USING (organization_id = public.current_organization_id()) WITH CHECK (organization_id = public.current_organization_id())',
      table_name
    );
  END LOOP;
END;
$tenant_restrictive_rls$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0058', 'Scope business uniqueness, existing foreign keys and direct-table RLS by organization')
ON CONFLICT (version) DO NOTHING;

COMMIT;
