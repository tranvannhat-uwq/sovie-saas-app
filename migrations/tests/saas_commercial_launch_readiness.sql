BEGIN;

CREATE TEMP TABLE commercial_launch_audit (
  check_name text PRIMARY KEY,
  passed boolean NOT NULL,
  details text NOT NULL
);

INSERT INTO commercial_launch_audit
SELECT
  'migration_chain_0056_0097_complete',
  count(*) = 42 AND min(version) = '0056' AND max(version) = '0097',
  count(*) || ' migrations, latest=' || coalesce(max(version), 'none')
FROM public.schema_migrations
WHERE version BETWEEN '0056' AND '0097';

DO $audit$
DECLARE
  v_table_name text;
  nullable_columns integer := 0;
  missing_rows bigint := 0;
  table_missing bigint;
BEGIN
  FOREACH v_table_name IN ARRAY ARRAY[
    'companies','customers','brands','product_groups','products','pricelists','price_list_items',
    'orders','draft_orders','order_items','cashbook_transactions','payments','sales_returns',
    'sales_return_items','customer_debt_transactions','finished_goods_stock','raw_materials',
    'semi_finished','recipes','production_logs','commission_transactions',
    'customer_assignments','commission_rules','starting_balances','suppliers','purchases',
    'purchase_items','purchase_payments','supplier_debt_transactions','kpi_targets','payroll_periods',
    'payroll_adjustments','payroll_entries'
  ] LOOP
    SELECT count(*) INTO nullable_columns
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND information_schema.columns.table_name = v_table_name
      AND column_name = 'organization_id'
      AND is_nullable = 'YES';

    IF nullable_columns > 0 THEN
      EXIT;
    END IF;

    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL', v_table_name)
      INTO table_missing;
    missing_rows := missing_rows + table_missing;
  END LOOP;

  INSERT INTO commercial_launch_audit VALUES (
    'business_tenant_boundary_complete',
    nullable_columns = 0 AND missing_rows = 0,
    nullable_columns || ' nullable organization_id columns; ' || missing_rows || ' unscoped rows'
  );
END;
$audit$;

INSERT INTO commercial_launch_audit
SELECT
  'mobile_rpc_executor_is_non_login_and_rls_bound',
  NOT rolcanlogin AND NOT rolbypassrls,
  'can_login=' || rolcanlogin || ', bypass_rls=' || rolbypassrls
FROM pg_roles
WHERE rolname = 'saas_rpc_executor';

INSERT INTO commercial_launch_audit
SELECT
  'mobile_read_models_are_reviewed_definers',
  count(*) = 10
    AND bool_and(owner_name = 'saas_rpc_executor')
    AND bool_and(prosecdef),
  count(*) || '/10 functions; owners=' || string_agg(DISTINCT owner_name, ',')
FROM (
  SELECT p.proname, r.rolname AS owner_name, p.prosecdef
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_roles r ON r.oid = p.proowner
  WHERE n.nspname = 'public'
    AND p.proname IN (
      'rpc_mobile_admin_dashboard','rpc_mobile_orders_paginated','rpc_mobile_order_detail',
      'rpc_mobile_customers_paginated','rpc_mobile_customer_detail','rpc_mobile_customer_debts',
      'rpc_mobile_customer_debt_transactions','rpc_mobile_employees',
      'rpc_mobile_my_access','require_mobile_admin_reader'
    )
) reviewed_mobile_functions;

INSERT INTO commercial_launch_audit
SELECT
  'mobile_membership_policy_is_scoped',
  count(*) = 1
    AND bool_and(roles::text LIKE '%saas_rpc_executor%')
    AND bool_and(qual LIKE '%request.jwt.claim.sub%')
    AND bool_and(qual LIKE '%current_organization_id%')
    AND bool_and(qual LIKE '%active%'),
  coalesce(string_agg(policyname || ': ' || qual, E'\n'), 'policy missing')
FROM pg_policies
WHERE schemaname = 'public'
  AND tablename = 'organization_memberships'
  AND policyname = 'saas_rpc_executor_mobile_membership_read';

INSERT INTO commercial_launch_audit
SELECT
  'customer_brand_relation_is_canonical',
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='customers' AND column_name='assigned_brand_id'
  )
  AND EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='customers_assigned_brand_id_fkey'
  )
  AND to_regclass('public.customers_organization_assigned_brand_idx') IS NOT NULL,
  'column, foreign key and tenant index checked';

INSERT INTO commercial_launch_audit
SELECT
  'workspace_domains_use_sovie_vn',
  count(*) FILTER (WHERE domain_type='sovie_subdomain') > 0
    AND count(*) FILTER (
      WHERE domain_type='sovie_subdomain' AND hostname NOT LIKE '%.sovie.vn'
    ) = 0
    AND count(*) FILTER (WHERE hostname LIKE '%.sovie.io.vn') = 0
    AND count(*) FILTER (
      WHERE domain_type='custom' AND (hostname='sovie.vn' OR hostname LIKE '%.sovie.vn')
    ) = 0,
  count(*) FILTER (WHERE domain_type='sovie_subdomain' AND hostname LIKE '%.sovie.vn')
    || ' managed sovie.vn domains; '
    || count(*) FILTER (WHERE hostname LIKE '%.sovie.io.vn') || ' legacy domains'
FROM public.organization_domains;

INSERT INTO commercial_launch_audit
SELECT
  'domain_provisioning_and_boundary_use_sovie_vn',
  bool_and(definition LIKE '%sovie.vn%')
    AND bool_and(definition NOT LIKE '%sovie.io.vn%')
    AND count(*) = 2,
  count(*) || '/2 domain functions use the canonical suffix'
FROM (
  SELECT pg_get_functiondef(p.oid) AS definition
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname='public'
    AND p.proname IN (
      'provision_organization_capabilities',
      'enforce_sovie_internal_domain_boundary'
    )
) domain_functions;

INSERT INTO commercial_launch_audit
SELECT
  'sensitive_service_rpcs_are_not_browser_callable',
  NOT has_function_privilege(
    'authenticated',
    'public.rpc_apply_organization_archive(uuid,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'public.rpc_apply_signed_billing_event(text,timestamptz,uuid,text,text,text,text,text,numeric,text,timestamptz,timestamptz,uuid,text,text,text)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'anon',
    'public.rpc_request_organization_archive(text,text,text)',
    'EXECUTE'
  ),
  'archive completion, signed billing event and archive request privileges checked';

INSERT INTO commercial_launch_audit
SELECT
  'billing_database_configuration_is_complete',
  provider = 'momo'
    AND tax_mode IN ('exclusive', 'not_subject')
    AND (tax_mode = 'not_subject' OR vat_rate > 0)
    AND nullif(btrim(issuer_name), '') IS NOT NULL
    AND nullif(btrim(issuer_tax_code), '') IS NOT NULL
    AND billing_enabled,
  'provider=' || provider || ', tax_mode=' || tax_mode || ', vat_rate=' || vat_rate
    || ', billing_enabled=' || billing_enabled
FROM public.billing_platform_settings
WHERE singleton = true;

INSERT INTO commercial_launch_audit
SELECT
  'pro_and_business_remain_private',
  count(*) = 2 AND bool_and(NOT is_public) AND bool_and(is_active),
  string_agg(id || ': public=' || is_public || ', monthly=' || price_monthly
    || ', yearly=' || price_yearly, '; ' ORDER BY id)
FROM public.saas_plans
WHERE id IN ('pro','business');

DO $audit$
DECLARE
  failed text;
BEGIN
  SELECT string_agg(check_name || ': ' || details, E'\n')
  INTO failed
  FROM commercial_launch_audit
  WHERE NOT passed;

  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Commercial launch readiness audit failed:\n%', failed;
  END IF;
END;
$audit$;

TABLE commercial_launch_audit;
ROLLBACK;
