-- Run only on isolated Supabase staging after migration 0058.
BEGIN;

CREATE TEMP TABLE tenant_boundary_results (
  test_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text
);
GRANT ALL ON TABLE pg_temp.tenant_boundary_results TO authenticated;

INSERT INTO tenant_boundary_results
SELECT 'all_business_tables_have_restrictive_tenant_policy',
  count(*) = 35 AND bool_and(permissive = 'RESTRICTIVE'),
  format('policies=%s', count(*))
FROM pg_policies
WHERE schemaname = 'public'
  AND policyname = 'tenant_organization_boundary';

INSERT INTO tenant_boundary_results
SELECT 'business_unique_constraints_are_tenant_scoped',
  count(*) = 11,
  format('scoped_unique_constraints=%s', count(*))
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
  AND contype = 'u'
  AND conname IN (
    'activity_logs_organization_operation_target_key',
    'companies_organization_code_key',
    'customers_organization_code_key',
    'kpi_targets_organization_employee_period_type_key',
    'payroll_adjustments_organization_period_employee_type_key',
    'payroll_entries_organization_period_employee_key',
    'products_organization_code_brand_key',
    'purchase_items_organization_purchase_line_key',
    'purchases_organization_code_key',
    'raw_materials_organization_code_key',
    'semi_finished_organization_code_key'
  );

INSERT INTO tenant_boundary_results
SELECT 'existing_business_relationships_are_composite_and_validated',
  count(*) = 9 AND bool_and(convalidated AND cardinality(conkey) = 2),
  format('composite_fks=%s', count(*))
FROM pg_constraint
WHERE connamespace = 'public'::regnamespace
  AND contype = 'f'
  AND conname IN (
    'payroll_adjustments_organization_period_fkey',
    'payroll_entries_organization_period_fkey',
    'purchase_items_organization_purchase_fkey',
    'purchase_payments_organization_purchase_fkey',
    'purchase_payments_organization_supplier_fkey',
    'purchases_organization_supplier_fkey',
    'supplier_debt_transactions_organization_payment_fkey',
    'supplier_debt_transactions_organization_purchase_fkey',
    'supplier_debt_transactions_organization_supplier_fkey'
  );

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('00000000-0000-0000-0000-000000000000', '58000000-0000-4000-8000-000000000001',
    'authenticated', 'authenticated', 'boundary-a@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '58000000-0000-4000-8000-000000000002',
    'authenticated', 'authenticated', 'boundary-b@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now())
ON CONFLICT (id) DO NOTHING;

UPDATE public.profiles SET role = 'admin', is_active = true
WHERE auth_user_id IN (
  '58000000-0000-4000-8000-000000000001'::uuid,
  '58000000-0000-4000-8000-000000000002'::uuid
);

INSERT INTO public.organizations (id, slug, name, status) VALUES
  ('58000000-0000-4000-8000-000000000011', 'boundary-test-a', 'Boundary Test A', 'active'),
  ('58000000-0000-4000-8000-000000000012', 'boundary-test-b', 'Boundary Test B', 'active');
INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES
  ('58000000-0000-4000-8000-000000000011', '58000000-0000-4000-8000-000000000001', 'owner', 'active', true, now()),
  ('58000000-0000-4000-8000-000000000012', '58000000-0000-4000-8000-000000000002', 'owner', 'active', true, now());

INSERT INTO public.companies (id, organization_id, code, name) VALUES
  ('boundary-company-a', '58000000-0000-4000-8000-000000000011', 'SAME-CODE', 'Company A'),
  ('boundary-company-b', '58000000-0000-4000-8000-000000000012', 'SAME-CODE', 'Company B');

INSERT INTO tenant_boundary_results VALUES (
  'duplicate_business_code_is_allowed_across_tenants', true,
  'same company code inserted for two organizations'
);

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '58000000-0000-4000-8000-000000000001', true);
INSERT INTO tenant_boundary_results
SELECT 'tenant_a_direct_read_cannot_see_tenant_b',
  count(*) = 1 AND bool_and(id = 'boundary-company-a'),
  format('visible_rows=%s', count(*))
FROM public.companies
WHERE id IN ('boundary-company-a', 'boundary-company-b');
RESET ROLE;

DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM tenant_boundary_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'SaaS relational-boundary tests failed:\n%', failed;
  END IF;
END;
$$;

TABLE tenant_boundary_results;
ROLLBACK;
