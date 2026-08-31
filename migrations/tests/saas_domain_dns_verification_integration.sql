-- Run only on isolated Supabase staging after migration 0073.
BEGIN;
CREATE TEMP TABLE dns_results (test_name text PRIMARY KEY,passed boolean NOT NULL,details text);
GRANT ALL ON TABLE pg_temp.dns_results TO authenticated,service_role;
INSERT INTO public.saas_plans(id,name,description,limits,is_public,is_active)
VALUES('dns-test','DNS Test','Integration only','{"users":5,"custom_domains":1}'::jsonb,false,true);
INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
SELECT '00000000-0000-0000-0000-000000000000',id,'authenticated','authenticated',email,'','{}','{}',now(),now()
FROM (VALUES
 ('73000000-0000-4000-8000-000000000001'::uuid,'dns-owner-a@test.invalid'),
 ('73000000-0000-4000-8000-000000000002'::uuid,'dns-owner-b@test.invalid')
) users(id,email);
INSERT INTO public.organizations(id,slug,name,status,created_by) VALUES
 ('73000000-0000-4000-8000-100000000001','dns-a','DNS A','active','73000000-0000-4000-8000-000000000001'),
 ('73000000-0000-4000-8000-100000000002','dns-b','DNS B','active','73000000-0000-4000-8000-000000000002');
INSERT INTO public.organization_memberships(organization_id,auth_user_id,role,status,is_default,joined_at) VALUES
 ('73000000-0000-4000-8000-100000000001','73000000-0000-4000-8000-000000000001','owner','active',true,now()),
 ('73000000-0000-4000-8000-100000000002','73000000-0000-4000-8000-000000000002','owner','active',true,now());
INSERT INTO public.organization_subscriptions(organization_id,plan_id,status,current_period_end) VALUES
 ('73000000-0000-4000-8000-100000000001','dns-test','active',now()+interval '30 days'),
 ('73000000-0000-4000-8000-100000000002','dns-test','active',now()+interval '30 days');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000001',true);
CREATE TEMP TABLE dns_domain AS SELECT public.rpc_request_custom_domain('dns-check.example.test') payload;
CREATE TEMP TABLE dns_attempt AS SELECT public.rpc_begin_domain_dns_verification(
  (SELECT (payload->>'domainId')::uuid FROM dns_domain)) payload;
GRANT SELECT ON TABLE pg_temp.dns_attempt,pg_temp.dns_domain TO service_role;
INSERT INTO dns_results SELECT 'owner_begins_tenant_attempt',
  payload->>'hostname'='dns-check.example.test' AND length(payload->'verification'->>'value')>=32,payload::text FROM dns_attempt;

DO $$ BEGIN
  BEGIN
    PERFORM public.rpc_begin_domain_dns_verification((SELECT (payload->>'domainId')::uuid FROM dns_domain));
    INSERT INTO dns_results VALUES('dns_check_is_rate_limited',false,'unexpected success');
  EXCEPTION WHEN raise_exception THEN
    INSERT INTO dns_results VALUES('dns_check_is_rate_limited',SQLERRM='Please wait one minute before checking DNS again',SQLERRM);
  END;
END $$;

SELECT set_config('request.jwt.claim.sub','73000000-0000-4000-8000-000000000002',true);
DO $$ BEGIN
  BEGIN
    PERFORM public.rpc_begin_domain_dns_verification((SELECT (payload->>'domainId')::uuid FROM dns_domain));
    INSERT INTO dns_results VALUES('other_tenant_cannot_begin_attempt',false,'unexpected success');
  EXCEPTION WHEN no_data_found THEN
    INSERT INTO dns_results VALUES('other_tenant_cannot_begin_attempt',true,SQLERRM);
  END;
END $$;

DO $$ BEGIN
  BEGIN
    PERFORM public.rpc_finish_domain_dns_verification(
      (SELECT (payload->>'attemptId')::uuid FROM dns_attempt),true,'browser-hash',false);
    INSERT INTO dns_results VALUES('browser_cannot_finish_attempt',false,'unexpected success');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO dns_results VALUES('browser_cannot_finish_attempt',true,SQLERRM);
  END;
END $$;

RESET ROLE;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE dns_finished AS SELECT public.rpc_finish_domain_dns_verification(
  (SELECT (payload->>'attemptId')::uuid FROM dns_attempt),true,'dns-evidence-hash',false) payload;
INSERT INTO dns_results SELECT 'service_records_dns_evidence',
  (payload->>'dnsVerified')::boolean AND payload->>'status'='verified',payload::text FROM dns_finished;
INSERT INTO dns_results SELECT 'dns_verification_never_self_activates_ssl',
  status='verified' AND ssl_status='pending',status||'/'||ssl_status
FROM public.organization_domains WHERE id=(SELECT (payload->>'domainId')::uuid FROM dns_domain);
INSERT INTO dns_results SELECT 'completed_attempt_is_idempotent',
  (public.rpc_finish_domain_dns_verification(
    (SELECT (payload->>'attemptId')::uuid FROM dns_attempt),true,'dns-evidence-hash',false
  )->>'duplicate')::boolean,'duplicate returned';

RESET ROLE;
DO $$ DECLARE failed text; BEGIN
 SELECT string_agg(test_name||': '||COALESCE(details,''),E'\n') INTO failed FROM dns_results WHERE NOT passed;
 IF failed IS NOT NULL THEN RAISE EXCEPTION E'DNS verification tests failed:\n%',failed; END IF;
END $$;
TABLE dns_results;
ROLLBACK;
