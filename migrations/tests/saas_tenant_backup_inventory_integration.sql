BEGIN;
CREATE TEMP TABLE backup_inventory_results(test_name text,passed boolean,details text);
GRANT ALL ON TABLE pg_temp.backup_inventory_results TO authenticated,anon;

INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
SELECT '00000000-0000-0000-0000-000000000000',id,'authenticated','authenticated',email,'','{}','{}',now(),now()
FROM(VALUES
 ('76000000-0000-4000-8000-000000000001'::uuid,'backup-owner@example.test'),
 ('76000000-0000-4000-8000-000000000002'::uuid,'backup-admin@example.test'),
 ('76000000-0000-4000-8000-000000000003'::uuid,'backup-sale@example.test')
)users(id,email);
INSERT INTO public.organizations(id,name,slug,status,created_by)
VALUES
 ('76000000-0000-4000-8000-100000000001','Backup Tenant A','backup-tenant-a','active','76000000-0000-4000-8000-000000000001'),
 ('76000000-0000-4000-8000-100000000002','Backup Tenant B','backup-tenant-b','active','76000000-0000-4000-8000-000000000002');
INSERT INTO public.organization_memberships(organization_id,auth_user_id,role,status,is_default,joined_at)
VALUES
 ('76000000-0000-4000-8000-100000000001','76000000-0000-4000-8000-000000000001','owner','active',true,now()),
 ('76000000-0000-4000-8000-100000000001','76000000-0000-4000-8000-000000000002','admin','active',false,now()),
 ('76000000-0000-4000-8000-100000000001','76000000-0000-4000-8000-000000000003','sale','active',false,now()),
 ('76000000-0000-4000-8000-100000000002','76000000-0000-4000-8000-000000000002','owner','active',true,now());

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','76000000-0000-4000-8000-000000000001',true);
DO $$DECLARE result jsonb;BEGIN
 result:=public.rpc_my_backup_inventory();
 INSERT INTO backup_inventory_results VALUES('owner_reads_tenant_inventory',
   result->>'organizationId'='76000000-0000-4000-8000-100000000001'
   AND result->>'organizationSlug'='backup-tenant-a'
   AND result->>'schemaVersion'='saas-tenant-v1',result::text);
END$$;

SELECT set_config('request.jwt.claim.sub','76000000-0000-4000-8000-000000000002',true);
SELECT public.rpc_set_default_organization('76000000-0000-4000-8000-100000000001');
DO $$DECLARE result jsonb;BEGIN
 result:=public.rpc_my_backup_inventory();
 INSERT INTO backup_inventory_results VALUES('admin_reads_selected_tenant_only',
   result->>'organizationId'='76000000-0000-4000-8000-100000000001'
   AND (result->'tableCounts'->>'profiles')::int=3,result::text);
END$$;

SELECT public.rpc_set_default_organization('76000000-0000-4000-8000-100000000002');
DO $$DECLARE result jsonb;BEGIN
 result:=public.rpc_my_backup_inventory();
 INSERT INTO backup_inventory_results VALUES('switch_changes_inventory_scope',
   result->>'organizationId'='76000000-0000-4000-8000-100000000002'
   AND (result->'tableCounts'->>'profiles')::int=1,result::text);
END$$;

SELECT set_config('request.jwt.claim.sub','76000000-0000-4000-8000-000000000003',true);
DO $$BEGIN
 PERFORM public.rpc_my_backup_inventory();
 INSERT INTO backup_inventory_results VALUES('sale_is_denied',false,'unexpected success');
EXCEPTION WHEN insufficient_privilege THEN
 INSERT INTO backup_inventory_results VALUES('sale_is_denied',true,SQLERRM);
END$$;

RESET ROLE;
SET LOCAL ROLE anon;
DO $$BEGIN
 PERFORM public.rpc_my_backup_inventory();
 INSERT INTO backup_inventory_results VALUES('anon_is_denied',false,'unexpected success');
EXCEPTION WHEN insufficient_privilege THEN
 INSERT INTO backup_inventory_results VALUES('anon_is_denied',true,SQLERRM);
END$$;
RESET ROLE;

DO $$DECLARE failed text;BEGIN
 SELECT string_agg(test_name||': '||COALESCE(details,''),E'\n') INTO failed
 FROM backup_inventory_results WHERE NOT passed;
 IF failed IS NOT NULL THEN RAISE EXCEPTION E'Tenant backup tests failed:\n%',failed; END IF;
END$$;
TABLE backup_inventory_results;
ROLLBACK;
