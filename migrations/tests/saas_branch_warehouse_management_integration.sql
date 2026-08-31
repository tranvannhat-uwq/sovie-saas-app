-- Run only on isolated Supabase staging after migration 0075.
BEGIN;
CREATE TEMP TABLE location_results(test_name text PRIMARY KEY,passed boolean NOT NULL,details text);
GRANT ALL ON TABLE pg_temp.location_results TO authenticated;

INSERT INTO public.saas_plans(id,name,description,limits,is_public,is_active)
VALUES('location-test','Location Test','Integration only',
  '{"users":5,"branches":2,"warehouses":2,"monthly_orders":500,"custom_domains":0}'::jsonb,false,true);
INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
SELECT '00000000-0000-0000-0000-000000000000',id,'authenticated','authenticated',email,'','{}','{}',now(),now()
FROM(VALUES
 ('75000000-0000-4000-8000-000000000001'::uuid,'location-owner-a@test.invalid'),
 ('75000000-0000-4000-8000-000000000002'::uuid,'location-admin-a@test.invalid'),
 ('75000000-0000-4000-8000-000000000003'::uuid,'location-owner-b@test.invalid')
)users(id,email);
INSERT INTO public.organizations(id,slug,name,status,created_by)VALUES
 ('75000000-0000-4000-8000-100000000001','location-a','Location A','active','75000000-0000-4000-8000-000000000001'),
 ('75000000-0000-4000-8000-100000000002','location-b','Location B','active','75000000-0000-4000-8000-000000000003');
INSERT INTO public.organization_memberships(organization_id,auth_user_id,role,status,is_default,joined_at)VALUES
 ('75000000-0000-4000-8000-100000000001','75000000-0000-4000-8000-000000000001','owner','active',true,now()),
 ('75000000-0000-4000-8000-100000000001','75000000-0000-4000-8000-000000000002','admin','active',true,now()),
 ('75000000-0000-4000-8000-100000000002','75000000-0000-4000-8000-000000000003','owner','active',true,now());
INSERT INTO public.organization_subscriptions(organization_id,plan_id,status,current_period_end)VALUES
 ('75000000-0000-4000-8000-100000000001','location-test','active',now()+interval '30 days'),
 ('75000000-0000-4000-8000-100000000002','location-test','active',now()+interval '30 days');

INSERT INTO location_results SELECT 'plan_catalog_has_baseline_quotas',
 (SELECT limits->>'branches'='5' AND limits->>'monthly_orders'='5000' FROM public.saas_plans WHERE id='pro')
 AND (SELECT limits->>'warehouses'='20' AND limits->>'custom_domains'='1' FROM public.saas_plans WHERE id='business'),
 'pro/business catalog';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','75000000-0000-4000-8000-000000000001',true);
CREATE TEMP TABLE added_branch AS SELECT public.rpc_upsert_organization_branch(
 NULL,'HN2','Chi nhanh Ha Noi 2','Ha Noi',NULL,NULL,NULL,false,true)payload;
INSERT INTO location_results SELECT 'owner_adds_branch_within_quota',
 payload->>'code'='HN2' AND (payload->>'limit')::integer=2,payload::text FROM added_branch;
DO $$BEGIN
 BEGIN
  PERFORM public.rpc_upsert_organization_branch(NULL,'HN3','Chi nhanh Ha Noi 3','',NULL,NULL,NULL,false,true);
  INSERT INTO location_results VALUES('third_active_branch_is_blocked',false,'unexpected success');
 EXCEPTION WHEN raise_exception THEN
  INSERT INTO location_results VALUES('third_active_branch_is_blocked',SQLERRM='Active branch limit reached (2 branches)',SQLERRM);
 END;
END$$;

CREATE TEMP TABLE added_warehouse AS SELECT public.rpc_upsert_organization_warehouse(
 NULL,(SELECT(payload->>'id')::uuid FROM added_branch),'KHO2','Kho Ha Noi 2','Ha Noi',false,true)payload;
INSERT INTO location_results SELECT 'owner_adds_warehouse_with_tenant_branch',
 payload->>'code'='KHO2' AND payload->>'branchId'=(SELECT payload->>'id' FROM added_branch),payload::text FROM added_warehouse;
DO $$BEGIN
 BEGIN
  PERFORM public.rpc_upsert_organization_warehouse(NULL,NULL,'KHO3','Kho so 3','',false,true);
  INSERT INTO location_results VALUES('third_active_warehouse_is_blocked',false,'unexpected success');
 EXCEPTION WHEN raise_exception THEN
  INSERT INTO location_results VALUES('third_active_warehouse_is_blocked',SQLERRM='Active warehouse limit reached (2 warehouses)',SQLERRM);
 END;
END$$;

SELECT set_config('request.jwt.claim.sub','75000000-0000-4000-8000-000000000002',true);
SELECT public.rpc_upsert_organization_branch((SELECT(payload->>'id')::uuid FROM added_branch),
 'HN2','Chi nhanh Ha Noi 2 - Admin','Ha Noi',NULL,NULL,NULL,false,true);
INSERT INTO location_results SELECT 'workspace_admin_can_update_branch',
 name='Chi nhanh Ha Noi 2 - Admin',name FROM public.organization_branches
WHERE id=(SELECT(payload->>'id')::uuid FROM added_branch);

SELECT set_config('request.jwt.claim.sub','75000000-0000-4000-8000-000000000003',true);
DO $$BEGIN
 BEGIN
  PERFORM public.rpc_upsert_organization_branch((SELECT(payload->>'id')::uuid FROM added_branch),
   'STOLEN','Stolen Branch','',NULL,NULL,NULL,false,true);
  INSERT INTO location_results VALUES('other_tenant_cannot_update_branch',false,'unexpected success');
 EXCEPTION WHEN no_data_found THEN
  INSERT INTO location_results VALUES('other_tenant_cannot_update_branch',true,SQLERRM);
 END;
END$$;
DO $$BEGIN
 BEGIN
  PERFORM public.rpc_upsert_organization_warehouse(NULL,(SELECT(payload->>'id')::uuid FROM added_branch),
   'CROSS','Cross Tenant Warehouse','',false,true);
  INSERT INTO location_results VALUES('cross_tenant_branch_link_is_rejected',false,'unexpected success');
 EXCEPTION WHEN no_data_found THEN
  INSERT INTO location_results VALUES('cross_tenant_branch_link_is_rejected',true,SQLERRM);
 END;
END$$;

SELECT set_config('request.jwt.claim.sub','75000000-0000-4000-8000-000000000001',true);
DO $$DECLARE default_branch public.organization_branches%ROWTYPE;BEGIN
 SELECT * INTO default_branch FROM public.organization_branches
 WHERE organization_id='75000000-0000-4000-8000-100000000001' AND is_default;
 BEGIN
  PERFORM public.rpc_upsert_organization_branch(default_branch.id,default_branch.code,default_branch.name,
   default_branch.address,default_branch.phone,default_branch.email,default_branch.tax_code,false,false);
  INSERT INTO location_results VALUES('default_branch_cannot_be_deactivated_directly',false,'unexpected success');
 EXCEPTION WHEN invalid_parameter_value THEN
  INSERT INTO location_results VALUES('default_branch_cannot_be_deactivated_directly',true,SQLERRM);
 END;
END$$;

RESET ROLE;
DO $$DECLARE failed text;BEGIN
 SELECT string_agg(test_name||': '||COALESCE(details,''),E'\n')INTO failed FROM location_results WHERE NOT passed;
 IF failed IS NOT NULL THEN RAISE EXCEPTION E'Branch/warehouse tests failed:\n%',failed;END IF;
END$$;
TABLE location_results;
ROLLBACK;
