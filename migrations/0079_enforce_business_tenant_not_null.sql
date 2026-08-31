BEGIN;

DO $tenant_not_null$
DECLARE table_name text;missing_rows bigint;
DECLARE business_tables constant text[]:=ARRAY[
  'companies','customers','brands','product_groups','products','pricelists','price_list_items',
  'orders','draft_orders','order_items','cashbook_transactions','payments','sales_returns',
  'sales_return_items','customer_debt_transactions','finished_goods_stock','raw_materials',
  'semi_finished','recipes','production_logs','commission_transactions','customer_assignments',
  'commission_rules','starting_balances','suppliers','purchases','purchase_items',
  'purchase_payments','supplier_debt_transactions','kpi_targets','payroll_periods',
  'payroll_adjustments','payroll_entries'
];
BEGIN
  FOREACH table_name IN ARRAY business_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id IS NULL',table_name)
      INTO missing_rows;
    IF missing_rows<>0 THEN
      RAISE EXCEPTION 'Cannot enforce tenant NOT NULL on public.%: % rows missing organization_id',table_name,missing_rows;
    END IF;
    EXECUTE format('ALTER TABLE public.%I ALTER COLUMN organization_id SET NOT NULL',table_name);
  END LOOP;
END;
$tenant_not_null$;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0079','Enforce organization_id NOT NULL on tenant business tables')
ON CONFLICT(version) DO NOTHING;
COMMIT;
