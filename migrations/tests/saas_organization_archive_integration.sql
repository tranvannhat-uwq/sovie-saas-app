BEGIN;
CREATE TEMP TABLE archive_results(test_name text,passed boolean,details text);
GRANT ALL ON TABLE pg_temp.archive_results TO authenticated,service_role;
INSERT INTO auth.users(instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
SELECT '00000000-0000-0000-0000-000000000000',id,'authenticated','authenticated',email,'','{}','{}',now(),now()
FROM(VALUES
 ('78000000-0000-4000-8000-000000000001'::uuid,'archive-owner@test.invalid'),
 ('78000000-0000-4000-8000-000000000002'::uuid,'archive-admin@test.invalid'),
 ('78000000-0000-4000-8000-000000000003'::uuid,'archive-early@test.invalid')
)users(id,email);
INSERT INTO public.organizations(id,slug,name,status,created_by)VALUES
 ('78000000-0000-4000-8000-100000000001','archive-ready','Archive Ready','cancelled','78000000-0000-4000-8000-000000000001'),
 ('78000000-0000-4000-8000-100000000002','archive-early','Archive Early','cancelled','78000000-0000-4000-8000-000000000003');
INSERT INTO public.organization_memberships(organization_id,auth_user_id,role,status,is_default,joined_at)VALUES
 ('78000000-0000-4000-8000-100000000001','78000000-0000-4000-8000-000000000001','owner','active',true,now()),
 ('78000000-0000-4000-8000-100000000001','78000000-0000-4000-8000-000000000002','admin','active',false,now()),
 ('78000000-0000-4000-8000-100000000002','78000000-0000-4000-8000-000000000003','owner','active',true,now());
INSERT INTO public.organization_subscriptions(organization_id,plan_id,status,read_only_ends_at)VALUES
 ('78000000-0000-4000-8000-100000000001','starter','cancelled',now()-interval '1 day'),
 ('78000000-0000-4000-8000-100000000002','starter','cancelled',now()+interval '29 days');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.role','authenticated',true);
SELECT set_config('request.jwt.claim.sub','78000000-0000-4000-8000-000000000003',true);
DO $$BEGIN
 PERFORM public.rpc_request_organization_archive('archive-early','backup-ref-early','test');
 INSERT INTO archive_results VALUES('early_archive_is_blocked',false,'unexpected success');
EXCEPTION WHEN object_not_in_prerequisite_state THEN
 INSERT INTO archive_results VALUES('early_archive_is_blocked',true,SQLERRM); END$$;

SELECT set_config('request.jwt.claim.sub','78000000-0000-4000-8000-000000000002',true);
DO $$BEGIN
 PERFORM public.rpc_request_organization_archive('archive-ready','backup-ref-admin','test');
 INSERT INTO archive_results VALUES('admin_cannot_request_archive',false,'unexpected success');
EXCEPTION WHEN insufficient_privilege THEN
 INSERT INTO archive_results VALUES('admin_cannot_request_archive',true,SQLERRM); END$$;

SELECT set_config('request.jwt.claim.sub','78000000-0000-4000-8000-000000000001',true);
CREATE TEMP TABLE requested_archive AS SELECT public.rpc_request_organization_archive(
 'archive-ready','sovie-archive-ready-verified.xlsx','Owner confirmed')payload;
GRANT SELECT ON TABLE pg_temp.requested_archive TO service_role;
INSERT INTO archive_results SELECT 'owner_requests_after_retention',
 payload->>'status'='requested' AND NOT(payload->>'duplicate')::boolean,payload::text FROM requested_archive;
INSERT INTO archive_results SELECT 'repeat_request_is_idempotent',
 (public.rpc_request_organization_archive('archive-ready','sovie-archive-ready-verified.xlsx','retry')->>'duplicate')::boolean,'duplicate returned';
DO $$DECLARE request_id uuid;BEGIN
 SELECT (payload->>'requestId')::uuid INTO request_id FROM requested_archive;
 PERFORM public.rpc_apply_organization_archive(request_id,'archive-event-browser');
 INSERT INTO archive_results VALUES('browser_cannot_apply_archive',false,'unexpected success');
EXCEPTION WHEN insufficient_privilege THEN
 INSERT INTO archive_results VALUES('browser_cannot_apply_archive',true,SQLERRM); END$$;

RESET ROLE; SET LOCAL ROLE service_role;
SELECT set_config('request.jwt.claim.role','service_role',true);
CREATE TEMP TABLE applied_archive AS SELECT public.rpc_apply_organization_archive(
 (SELECT(payload->>'requestId')::uuid FROM requested_archive),'archive-event-service-1')payload;
INSERT INTO archive_results SELECT 'service_soft_archives_without_deleting_data',
 payload->>'status'='completed' AND payload->>'dataDeleted'='false'
 AND (SELECT status='archived' FROM public.organizations WHERE id='78000000-0000-4000-8000-100000000001')
 AND NOT EXISTS(SELECT 1 FROM public.organization_memberships WHERE organization_id='78000000-0000-4000-8000-100000000001' AND status='active'),payload::text FROM applied_archive;
INSERT INTO archive_results SELECT 'service_retry_is_idempotent',
 (public.rpc_apply_organization_archive((SELECT(payload->>'requestId')::uuid FROM requested_archive),'archive-event-service-1')->>'duplicate')::boolean,'duplicate returned';
RESET ROLE;

DO $$DECLARE failed text;BEGIN SELECT string_agg(test_name||': '||details,E'\n') INTO failed FROM archive_results WHERE NOT passed;
IF failed IS NOT NULL THEN RAISE EXCEPTION E'Archive tests failed:\n%',failed; END IF; END$$;
TABLE archive_results;
ROLLBACK;
