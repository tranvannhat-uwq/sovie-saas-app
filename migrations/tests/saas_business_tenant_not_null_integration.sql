BEGIN;
CREATE TEMP TABLE tenant_not_null_results(test_name text,passed boolean,details text);
INSERT INTO tenant_not_null_results SELECT 'all_33_business_columns_are_not_null',
 count(*)=33 AND bool_and(is_nullable='NO'),count(*)||' columns checked'
FROM information_schema.columns WHERE table_schema='public' AND column_name='organization_id'
AND table_name=ANY(ARRAY[
  'companies','customers','brands','product_groups','products','pricelists','price_list_items',
  'orders','draft_orders','order_items','cashbook_transactions','payments','sales_returns',
  'sales_return_items','customer_debt_transactions','finished_goods_stock','raw_materials',
  'semi_finished','recipes','production_logs','commission_transactions','customer_assignments',
  'commission_rules','starting_balances','suppliers','purchases','purchase_items',
  'purchase_payments','supplier_debt_transactions','kpi_targets','payroll_periods',
  'payroll_adjustments','payroll_entries'
]);
INSERT INTO tenant_not_null_results SELECT 'platform_audit_exception_remains_nullable',
 count(*)=2 AND bool_and(is_nullable='YES'),string_agg(table_name||'='||is_nullable,',')
FROM information_schema.columns WHERE table_schema='public' AND column_name='organization_id'
AND table_name IN('audit_logs','activity_logs');
DO $$DECLARE failed text;BEGIN SELECT string_agg(test_name||': '||details,E'\n') INTO failed
FROM tenant_not_null_results WHERE NOT passed;IF failed IS NOT NULL THEN RAISE EXCEPTION E'Tenant NOT NULL tests failed:\n%',failed;END IF;END$$;
TABLE tenant_not_null_results;
ROLLBACK;
