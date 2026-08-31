BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_my_backup_inventory()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE active_organization_id uuid:=public.current_organization_id();
DECLARE organization_slug text;
DECLARE table_name text;
DECLARE row_total bigint;
DECLARE counts jsonb:='{}'::jsonb;
DECLARE backup_tables constant text[]:=ARRAY[
  'products','customers','orders','order_items','draft_orders','pricelists',
  'price_list_items','brands','payments','cashbook_transactions','starting_balances',
  'customer_debt_transactions','sales_returns','sales_return_items','suppliers',
  'purchases','purchase_items','purchase_payments','supplier_debt_transactions'
];
BEGIN
  IF active_organization_id IS NULL OR NOT public.has_organization_role(
    active_organization_id,ARRAY['owner','admin']
  ) THEN
    RAISE EXCEPTION '403: workspace Owner or Admin required' USING ERRCODE='42501';
  END IF;
  SELECT organization.slug INTO organization_slug FROM public.organizations organization
  WHERE organization.id=active_organization_id;
  FOREACH table_name IN ARRAY backup_tables LOOP
    EXECUTE format('SELECT count(*) FROM public.%I WHERE organization_id=$1',table_name)
      INTO row_total USING active_organization_id;
    counts:=counts||jsonb_build_object(table_name,row_total);
  END LOOP;
  SELECT count(DISTINCT membership.profile_id) INTO row_total
  FROM public.organization_memberships membership
  WHERE membership.organization_id=active_organization_id;
  counts:=counts||jsonb_build_object('profiles',row_total);
  RETURN jsonb_build_object(
    'schemaVersion','saas-tenant-v1',
    'organizationId',active_organization_id,
    'organizationSlug',organization_slug,
    'latestMigration',(SELECT max(version) FROM public.schema_migrations),
    'generatedAt',now(),
    'tableCounts',counts
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_my_backup_inventory() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_my_backup_inventory() TO authenticated;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0076','Add tenant-derived backup inventory for verifiable SaaS exports')
ON CONFLICT(version) DO NOTHING;
COMMIT;
