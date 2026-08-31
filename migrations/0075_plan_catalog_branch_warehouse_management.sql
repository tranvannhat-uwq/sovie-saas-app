BEGIN;

UPDATE public.saas_plans
SET limits = limits || '{"users":5,"branches":1,"warehouses":1,"monthly_orders":500,"custom_domains":0}'::jsonb,
    updated_at = now()
WHERE id = 'starter';

INSERT INTO public.saas_plans (
  id,name,description,price_monthly,currency,limits,is_public,is_active
) VALUES
  ('pro','Pro','Goi cho doanh nghiep vua',0,'VND',
    '{"users":20,"branches":5,"warehouses":5,"monthly_orders":5000,"custom_domains":0}'::jsonb,
    false,true),
  ('business','Business','Goi cho chuoi va doanh nghiep lon',0,'VND',
    '{"users":100,"branches":20,"warehouses":20,"monthly_orders":25000,"custom_domains":1}'::jsonb,
    false,true)
ON CONFLICT (id) DO UPDATE SET
  name=EXCLUDED.name,description=EXCLUDED.description,currency=EXCLUDED.currency,
  limits=EXCLUDED.limits,is_active=true,updated_at=now();

CREATE OR REPLACE FUNCTION public.rpc_upsert_organization_branch(
  p_branch_id uuid DEFAULT NULL,
  p_code text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_address text DEFAULT '',
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_tax_code text DEFAULT NULL,
  p_is_default boolean DEFAULT false,
  p_is_active boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE active_organization_id uuid:=public.current_organization_id();
DECLARE normalized_code text:=upper(btrim(COALESCE(p_code,'')));
DECLARE normalized_name text:=btrim(COALESCE(p_name,''));
DECLARE branch_limit integer;
DECLARE active_count integer;
DECLARE branch public.organization_branches%ROWTYPE;
DECLARE current_branch public.organization_branches%ROWTYPE;
DECLARE make_default boolean:=COALESCE(p_is_default,false);
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id,ARRAY['owner','admin']) THEN
    RAISE EXCEPTION '403: workspace Owner or Admin required' USING ERRCODE='42501';
  END IF;
  IF NOT public.organization_write_access_allowed(active_organization_id) THEN
    RAISE EXCEPTION 'Workspace is read-only for the current subscription' USING ERRCODE='42501';
  END IF;
  IF normalized_code !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'
    OR char_length(normalized_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Valid branch code and name required' USING ERRCODE='22023';
  END IF;
  IF make_default AND NOT COALESCE(p_is_active,true) THEN
    RAISE EXCEPTION 'Default branch must be active' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.organizations organization
  WHERE organization.id=active_organization_id FOR UPDATE;
  IF p_branch_id IS NOT NULL THEN
    SELECT * INTO current_branch FROM public.organization_branches candidate
    WHERE candidate.id=p_branch_id AND candidate.organization_id=active_organization_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Branch not found in this workspace' USING ERRCODE='P0002'; END IF;
    IF current_branch.is_default AND (NOT make_default OR NOT COALESCE(p_is_active,true)) THEN
      RAISE EXCEPTION 'Set another active branch as default before changing this branch' USING ERRCODE='22023';
    END IF;
  END IF;
  SELECT COALESCE((plan.limits->>'branches')::integer,1) INTO branch_limit
  FROM public.organization_subscriptions subscription
  JOIN public.saas_plans plan ON plan.id=subscription.plan_id
  WHERE subscription.organization_id=active_organization_id
  ORDER BY subscription.updated_at DESC,subscription.created_at DESC LIMIT 1;
  branch_limit:=COALESCE(branch_limit,1);
  IF COALESCE(p_is_active,true) AND (p_branch_id IS NULL OR NOT current_branch.is_active) THEN
    SELECT count(*) INTO active_count FROM public.organization_branches candidate
    WHERE candidate.organization_id=active_organization_id AND candidate.is_active;
    IF branch_limit>=0 AND active_count>=branch_limit THEN
      RAISE EXCEPTION 'Active branch limit reached (% branches)',branch_limit USING ERRCODE='P0001';
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.organization_branches candidate
    WHERE candidate.organization_id=active_organization_id AND candidate.is_default AND candidate.is_active) THEN
    make_default:=COALESCE(p_is_active,true);
  END IF;
  IF make_default THEN
    UPDATE public.organization_branches SET is_default=false,updated_at=now()
    WHERE organization_id=active_organization_id AND is_default
      AND (p_branch_id IS NULL OR id<>p_branch_id);
  END IF;
  IF p_branch_id IS NULL THEN
    INSERT INTO public.organization_branches(
      organization_id,code,name,address,phone,email,tax_code,is_default,is_active
    ) VALUES(active_organization_id,normalized_code,normalized_name,btrim(COALESCE(p_address,'')),
      NULLIF(btrim(COALESCE(p_phone,'')),''),NULLIF(lower(btrim(COALESCE(p_email,''))),''),
      NULLIF(btrim(COALESCE(p_tax_code,'')),''),make_default,COALESCE(p_is_active,true))
    RETURNING * INTO branch;
  ELSE
    UPDATE public.organization_branches SET code=normalized_code,name=normalized_name,
      address=btrim(COALESCE(p_address,'')),phone=NULLIF(btrim(COALESCE(p_phone,'')),''),
      email=NULLIF(lower(btrim(COALESCE(p_email,''))),''),tax_code=NULLIF(btrim(COALESCE(p_tax_code,'')),''),
      is_default=make_default,is_active=COALESCE(p_is_active,true),updated_at=now()
    WHERE id=p_branch_id RETURNING * INTO branch;
  END IF;
  RETURN jsonb_build_object('id',branch.id,'code',branch.code,'name',branch.name,
    'isDefault',branch.is_default,'isActive',branch.is_active,'limit',branch_limit);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Branch code already exists in this workspace' USING ERRCODE='23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_upsert_organization_warehouse(
  p_warehouse_id uuid DEFAULT NULL,
  p_branch_id uuid DEFAULT NULL,
  p_code text DEFAULT NULL,
  p_name text DEFAULT NULL,
  p_address text DEFAULT '',
  p_is_default boolean DEFAULT false,
  p_is_active boolean DEFAULT true
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE active_organization_id uuid:=public.current_organization_id();
DECLARE normalized_code text:=upper(btrim(COALESCE(p_code,'')));
DECLARE normalized_name text:=btrim(COALESCE(p_name,''));
DECLARE warehouse_limit integer;
DECLARE active_count integer;
DECLARE warehouse public.organization_warehouses%ROWTYPE;
DECLARE current_warehouse public.organization_warehouses%ROWTYPE;
DECLARE make_default boolean:=COALESCE(p_is_default,false);
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id,ARRAY['owner','admin']) THEN
    RAISE EXCEPTION '403: workspace Owner or Admin required' USING ERRCODE='42501';
  END IF;
  IF NOT public.organization_write_access_allowed(active_organization_id) THEN
    RAISE EXCEPTION 'Workspace is read-only for the current subscription' USING ERRCODE='42501';
  END IF;
  IF normalized_code !~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'
    OR char_length(normalized_name) NOT BETWEEN 2 AND 120 THEN
    RAISE EXCEPTION 'Valid warehouse code and name required' USING ERRCODE='22023';
  END IF;
  IF make_default AND NOT COALESCE(p_is_active,true) THEN
    RAISE EXCEPTION 'Default warehouse must be active' USING ERRCODE='22023';
  END IF;
  PERFORM 1 FROM public.organizations organization
  WHERE organization.id=active_organization_id FOR UPDATE;
  IF p_branch_id IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM public.organization_branches branch
    WHERE branch.id=p_branch_id AND branch.organization_id=active_organization_id AND branch.is_active
  ) THEN
    RAISE EXCEPTION 'Active branch not found in this workspace' USING ERRCODE='P0002';
  END IF;
  IF p_warehouse_id IS NOT NULL THEN
    SELECT * INTO current_warehouse FROM public.organization_warehouses candidate
    WHERE candidate.id=p_warehouse_id AND candidate.organization_id=active_organization_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Warehouse not found in this workspace' USING ERRCODE='P0002'; END IF;
    IF current_warehouse.is_default AND (NOT make_default OR NOT COALESCE(p_is_active,true)) THEN
      RAISE EXCEPTION 'Set another active warehouse as default before changing this warehouse' USING ERRCODE='22023';
    END IF;
  END IF;
  SELECT COALESCE((plan.limits->>'warehouses')::integer,1) INTO warehouse_limit
  FROM public.organization_subscriptions subscription
  JOIN public.saas_plans plan ON plan.id=subscription.plan_id
  WHERE subscription.organization_id=active_organization_id
  ORDER BY subscription.updated_at DESC,subscription.created_at DESC LIMIT 1;
  warehouse_limit:=COALESCE(warehouse_limit,1);
  IF COALESCE(p_is_active,true) AND (p_warehouse_id IS NULL OR NOT current_warehouse.is_active) THEN
    SELECT count(*) INTO active_count FROM public.organization_warehouses candidate
    WHERE candidate.organization_id=active_organization_id AND candidate.is_active;
    IF warehouse_limit>=0 AND active_count>=warehouse_limit THEN
      RAISE EXCEPTION 'Active warehouse limit reached (% warehouses)',warehouse_limit USING ERRCODE='P0001';
    END IF;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.organization_warehouses candidate
    WHERE candidate.organization_id=active_organization_id AND candidate.is_default AND candidate.is_active) THEN
    make_default:=COALESCE(p_is_active,true);
  END IF;
  IF make_default THEN
    UPDATE public.organization_warehouses SET is_default=false,updated_at=now()
    WHERE organization_id=active_organization_id AND is_default
      AND (p_warehouse_id IS NULL OR id<>p_warehouse_id);
  END IF;
  IF p_warehouse_id IS NULL THEN
    INSERT INTO public.organization_warehouses(
      organization_id,branch_id,code,name,address,is_default,is_active
    ) VALUES(active_organization_id,p_branch_id,normalized_code,normalized_name,
      btrim(COALESCE(p_address,'')),make_default,COALESCE(p_is_active,true))
    RETURNING * INTO warehouse;
  ELSE
    UPDATE public.organization_warehouses SET branch_id=p_branch_id,code=normalized_code,
      name=normalized_name,address=btrim(COALESCE(p_address,'')),is_default=make_default,
      is_active=COALESCE(p_is_active,true),updated_at=now()
    WHERE id=p_warehouse_id RETURNING * INTO warehouse;
  END IF;
  RETURN jsonb_build_object('id',warehouse.id,'code',warehouse.code,'name',warehouse.name,
    'branchId',warehouse.branch_id,'isDefault',warehouse.is_default,
    'isActive',warehouse.is_active,'limit',warehouse_limit);
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Warehouse code already exists in this workspace' USING ERRCODE='23505';
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_upsert_organization_branch(uuid,text,text,text,text,text,text,boolean,boolean),
  public.rpc_upsert_organization_warehouse(uuid,uuid,text,text,text,boolean,boolean)
  FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_upsert_organization_branch(uuid,text,text,text,text,text,text,boolean,boolean),
  public.rpc_upsert_organization_warehouse(uuid,uuid,text,text,text,boolean,boolean)
  TO authenticated;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0075','Add SaaS plan catalog and quota-enforced branch and warehouse management')
ON CONFLICT(version) DO NOTHING;
COMMIT;
