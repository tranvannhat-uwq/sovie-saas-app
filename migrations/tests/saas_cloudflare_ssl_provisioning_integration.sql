-- Run only on isolated Supabase staging after migration 0074.
BEGIN;
CREATE TEMP TABLE cf_results(test_name text PRIMARY KEY,passed boolean NOT NULL,details text);
GRANT ALL ON TABLE pg_temp.cf_results TO authenticated,service_role;
INSERT INTO public.saas_plans(id,name,description,limits,is_public,is_active)
VALUES('cf-test','Cloudflare Test','Integration only','{"users":5,"custom_domains":1}'::jsonb,false,true);
INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
SELECT '00000000-0000-0000-0000-000000000000',id,'authenticated','authenticated',email,'','{}','{}',now(),now()
FROM(VALUES
 ('74000000-0000-4000-8000-000000000001'::uuid,'cf-owner-a@test.invalid'),
 ('74000000-0000-4000-8000-000000000002'::uuid,'cf-owner-b@test.invalid')
)users(id,email);
INSERT INTO public.organizations(id,slug,name,status,created_by)VALUES
 ('74000000-0000-4000-8000-100000000001','cf-a','CF A','active','74000000-0000-4000-8000-000000000001'),
 ('74000000-0000-4000-8000-100000000002','cf-b','CF B','active','74000000-0000-4000-8000-000000000002');
INSERT INTO public.organization_memberships(organization_id,auth_user_id,role,status,is_default,joined_at)VALUES
 ('74000000-0000-4000-8000-100000000001','74000000-0000-4000-8000-000000000001','owner','active',true,now()),
 ('74000000-0000-4000-8000-100000000002','74000000-0000-4000-8000-000000000002','owner','active',true,now());
INSERT INTO public.organization_subscriptions(organization_id,plan_id,status,current_period_end)VALUES
 ('74000000-0000-4000-8000-100000000001','cf-test','active',now()+interval '30 days'),
 ('74000000-0000-4000-8000-100000000002','cf-test','active',now()+interval '30 days');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','74000000-0000-4000-8000-000000000001',true);
CREATE TEMP TABLE cf_domain AS SELECT public.rpc_request_custom_domain('cf-check.example.test')payload;
GRANT SELECT ON TABLE pg_temp.cf_domain TO service_role;
RESET ROLE;SET LOCAL ROLE service_role;
SELECT public.rpc_apply_domain_verification('cf-dns-ready',
 (SELECT(payload->>'domainId')::uuid FROM cf_domain),true,false,'system','dns-ready');

RESET ROLE;SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','74000000-0000-4000-8000-000000000001',true);
CREATE TEMP TABLE cf_create_job AS SELECT public.rpc_begin_domain_ssl_provisioning(
 (SELECT(payload->>'domainId')::uuid FROM cf_domain))payload;
GRANT SELECT ON TABLE pg_temp.cf_create_job TO service_role;
INSERT INTO cf_results SELECT 'owner_queues_create_after_dns_verification',
 payload->>'operation'='create' AND payload->>'hostname'='cf-check.example.test',payload::text FROM cf_create_job;
INSERT INTO cf_results SELECT 'open_job_is_idempotent',
 (public.rpc_begin_domain_ssl_provisioning((SELECT(payload->>'domainId')::uuid FROM cf_domain))->>'duplicate')::boolean,
 'duplicate returned';

SELECT set_config('request.jwt.claim.sub','74000000-0000-4000-8000-000000000002',true);
DO $$BEGIN
 BEGIN
  PERFORM public.rpc_begin_domain_ssl_provisioning((SELECT(payload->>'domainId')::uuid FROM cf_domain));
  INSERT INTO cf_results VALUES('other_tenant_cannot_queue_ssl',false,'unexpected success');
 EXCEPTION WHEN no_data_found THEN INSERT INTO cf_results VALUES('other_tenant_cannot_queue_ssl',true,SQLERRM);END;
END$$;
DO $$BEGIN
 BEGIN
  PERFORM public.rpc_finish_domain_ssl_provisioning(
   (SELECT(payload->>'jobId')::uuid FROM cf_create_job),'browser-finish','cf-host-1','active','active',NULL,NULL);
  INSERT INTO cf_results VALUES('browser_cannot_finish_ssl_job',false,'unexpected success');
 EXCEPTION WHEN insufficient_privilege THEN INSERT INTO cf_results VALUES('browser_cannot_finish_ssl_job',true,SQLERRM);END;
END$$;

RESET ROLE;SET LOCAL ROLE service_role;
CREATE TEMP TABLE cf_waiting AS SELECT public.rpc_finish_domain_ssl_provisioning(
 (SELECT(payload->>'jobId')::uuid FROM cf_create_job),'cf-pending','cf-host-1','pending','pending','pending-hash',NULL)payload;
INSERT INTO cf_results SELECT 'pending_provider_state_keeps_domain_verified',
 domain.status='verified' AND domain.ssl_status='pending' AND job.status='waiting',
 domain.status||'/'||domain.ssl_status||'/'||job.status
FROM public.organization_domains domain JOIN public.domain_provisioning_jobs job ON job.domain_id=domain.id
WHERE job.id=(SELECT(payload->>'jobId')::uuid FROM cf_create_job);

RESET ROLE;SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','74000000-0000-4000-8000-000000000001',true);
CREATE TEMP TABLE cf_sync_job AS SELECT public.rpc_begin_domain_ssl_provisioning(
 (SELECT(payload->>'domainId')::uuid FROM cf_domain))payload;
GRANT SELECT ON TABLE pg_temp.cf_sync_job TO service_role;
INSERT INTO cf_results SELECT 'next_attempt_syncs_provider_hostname',
 payload->>'operation'='sync' AND payload->>'providerHostnameId'='cf-host-1',payload::text FROM cf_sync_job;

RESET ROLE;SET LOCAL ROLE service_role;
CREATE TEMP TABLE cf_active AS SELECT public.rpc_finish_domain_ssl_provisioning(
 (SELECT(payload->>'jobId')::uuid FROM cf_sync_job),'cf-active','cf-host-1','active','active','active-hash',NULL)payload;
INSERT INTO cf_results SELECT 'both_active_statuses_activate_custom_domain',
 (result.payload->>'ready')::boolean AND domain.status='active' AND domain.ssl_status='active',
 result.payload::text||'/'||domain.status||'/'||domain.ssl_status
FROM cf_active result JOIN public.organization_domains domain
 ON domain.id=(SELECT(payload->>'domainId')::uuid FROM cf_domain);

RESET ROLE;
DO $$DECLARE failed text;BEGIN
 SELECT string_agg(test_name||': '||COALESCE(details,''),E'\n')INTO failed FROM cf_results WHERE NOT passed;
 IF failed IS NOT NULL THEN RAISE EXCEPTION E'Cloudflare tests failed:\n%',failed;END IF;
END$$;
TABLE cf_results;
ROLLBACK;
