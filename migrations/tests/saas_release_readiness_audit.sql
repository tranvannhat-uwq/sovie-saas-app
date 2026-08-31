BEGIN;
CREATE TEMP TABLE release_audit(check_name text,passed boolean,details text);

INSERT INTO release_audit SELECT 'migration_chain_0056_0079_complete',
 count(*)=24 AND min(version)='0056' AND max(version)='0079',
 count(*)||' migrations, latest='||max(version)
FROM public.schema_migrations WHERE version BETWEEN '0056' AND '0079';

DO $$DECLARE table_name text;missing bigint;total_missing bigint:=0;BEGIN
 FOREACH table_name IN ARRAY ARRAY[
  'companies','customers','brands','product_groups','products','pricelists','price_list_items',
  'orders','draft_orders','order_items','cashbook_transactions','payments','sales_returns',
  'sales_return_items','customer_debt_transactions','finished_goods_stock','raw_materials',
  'semi_finished','recipes','production_logs','commission_transactions',
  'customer_assignments','commission_rules','starting_balances','suppliers','purchases',
  'purchase_items','purchase_payments','supplier_debt_transactions','kpi_targets','payroll_periods',
  'payroll_adjustments','payroll_entries'
 ] LOOP
  EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL',table_name) INTO missing;
  total_missing:=total_missing+missing;
 END LOOP;
 INSERT INTO release_audit VALUES('tenant_business_rows_have_organization',total_missing=0,total_missing||' rows missing organization_id; platform audit bootstrap excluded');
END$$;

INSERT INTO release_audit SELECT 'null_tenant_rows_are_platform_audit_only',
 (SELECT count(*) FROM public.activity_logs WHERE organization_id IS NULL)=0,
 (SELECT count(*) FROM public.audit_logs WHERE organization_id IS NULL)||' legacy/platform audit rows intentionally outside tenant business data';

INSERT INTO release_audit SELECT 'sensitive_rpcs_not_callable_by_anon',
 NOT has_function_privilege('anon','public.rpc_upsert_organization_branch(uuid,text,text,text,text,text,text,boolean,boolean)','EXECUTE')
 AND NOT has_function_privilege('anon','public.rpc_my_backup_inventory()','EXECUTE')
 AND NOT has_function_privilege('anon','public.rpc_request_organization_archive(text,text,text)','EXECUTE'),
 'branch, backup and archive request RPCs checked';

INSERT INTO release_audit SELECT 'service_completion_rpcs_not_callable_by_browser',
 NOT has_function_privilege('authenticated','public.rpc_apply_organization_archive(uuid,text)','EXECUTE')
 AND NOT has_function_privilege('authenticated','public.rpc_apply_signed_billing_event(text,timestamptz,uuid,text,text,text,text,text,numeric,text,timestamptz,timestamptz,uuid,text,text,text)','EXECUTE'),
 'archive and billing completion RPCs checked';

INSERT INTO release_audit SELECT 'commercial_plans_remain_private_until_pricing',
 count(*)=2 AND bool_and(NOT is_public) AND bool_and(is_active),
 string_agg(id||':public='||is_public,', ')
FROM public.saas_plans WHERE id IN('pro','business');

DO $$DECLARE failed text;BEGIN
 SELECT string_agg(check_name||': '||details,E'\n') INTO failed FROM release_audit WHERE NOT passed;
 IF failed IS NOT NULL THEN RAISE EXCEPTION E'Release readiness audit failed:\n%',failed; END IF;
END$$;
TABLE release_audit;
ROLLBACK;
