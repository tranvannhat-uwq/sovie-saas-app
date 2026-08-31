-- Run only on isolated Supabase staging after migration 0072.
BEGIN;
CREATE TEMP TABLE signed_billing_results (test_name text PRIMARY KEY, passed boolean NOT NULL, details text);
GRANT ALL ON TABLE pg_temp.signed_billing_results TO authenticated, service_role;

INSERT INTO public.saas_plans (id,name,description,price_monthly,limits,is_public,is_active)
VALUES ('signed-billing-test','Signed Billing Test','Integration only',299000,
  '{"users":15,"monthly_orders":5000}'::jsonb,false,true);
INSERT INTO auth.users (instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
VALUES ('00000000-0000-0000-0000-000000000000','72000000-0000-4000-8000-000000000001',
  'authenticated','authenticated','signed-owner@test.invalid','','{}','{}',now(),now());
INSERT INTO public.organizations (id,slug,name,status,created_by)
VALUES ('72000000-0000-4000-8000-100000000001','signed-billing','Signed Billing','active',
  '72000000-0000-4000-8000-000000000001');
INSERT INTO public.organization_memberships (organization_id,auth_user_id,role,status,is_default,joined_at)
VALUES ('72000000-0000-4000-8000-100000000001','72000000-0000-4000-8000-000000000001','owner','active',true,now());
INSERT INTO public.organization_subscriptions (organization_id,plan_id,status,current_period_start,current_period_end)
VALUES ('72000000-0000-4000-8000-100000000001','starter','active',now(),now()+interval '30 days');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','72000000-0000-4000-8000-000000000001',true);
DO $$ BEGIN
  BEGIN
    PERFORM public.rpc_apply_signed_billing_event(
      'browser-denied',now(),'72000000-0000-4000-8000-100000000001','payos','invoice_paid',
      'signed-billing-test','signed-invoice-1','SINV-1',299000,'VND',now(),now()+interval '30 days',NULL,NULL,'hash','v1');
    INSERT INTO signed_billing_results VALUES ('browser_cannot_apply_signed_event',false,'unexpected success');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO signed_billing_results VALUES ('browser_cannot_apply_signed_event',true,SQLERRM);
  END;
END $$;

RESET ROLE;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE latest_event_time AS SELECT date_trunc('second',now()) event_at;
SELECT public.rpc_apply_signed_billing_event(
  'signed-paid-newest',(SELECT event_at FROM latest_event_time),
  '72000000-0000-4000-8000-100000000001','payos','invoice_paid','signed-billing-test',
  'signed-invoice-1','SINV-1',299000,'VND',now(),now()+interval '30 days',NULL,
  'https://billing.example.test/signed-invoice-1','hash-new','v1');
INSERT INTO signed_billing_results SELECT 'newest_signed_event_is_applied',
  invoice.status='paid' AND subscription.status='active' AND subscription.plan_id='signed-billing-test',
  invoice.status||'/'||subscription.status
FROM public.billing_invoices invoice
JOIN public.organization_subscriptions subscription USING (organization_id)
WHERE invoice.provider='payos' AND invoice.provider_invoice_id='signed-invoice-1'
ORDER BY subscription.updated_at DESC LIMIT 1;

CREATE TEMP TABLE stale_result AS SELECT public.rpc_apply_signed_billing_event(
  'signed-failed-stale',(SELECT event_at - interval '10 minutes' FROM latest_event_time),
  '72000000-0000-4000-8000-100000000001','payos','invoice_failed','signed-billing-test',
  'signed-invoice-1','SINV-1',299000,'VND',NULL,NULL,NULL,NULL,'hash-stale','v1') payload;
INSERT INTO signed_billing_results SELECT 'stale_event_is_recorded_but_ignored',
  payload->>'ignoredReason'='stale_event'
    AND NOT (payload->>'invoiceApplied')::boolean
    AND NOT (payload->>'subscriptionApplied')::boolean,payload::text FROM stale_result;
INSERT INTO signed_billing_results SELECT 'stale_failure_cannot_regress_paid_state',
  invoice.status='paid' AND subscription.status='active',invoice.status||'/'||subscription.status
FROM public.billing_invoices invoice
JOIN public.organization_subscriptions subscription USING (organization_id)
WHERE invoice.provider='payos' AND invoice.provider_invoice_id='signed-invoice-1'
ORDER BY subscription.updated_at DESC LIMIT 1;

INSERT INTO signed_billing_results SELECT 'duplicate_signed_event_is_idempotent',
  (public.rpc_apply_signed_billing_event(
    'signed-paid-newest',(SELECT event_at FROM latest_event_time),
    '72000000-0000-4000-8000-100000000001','payos','invoice_paid','signed-billing-test',
    'signed-invoice-1','SINV-1',299000,'VND',NULL,NULL,NULL,NULL,'hash-new','v1'
  )->>'duplicate')::boolean,'duplicate returned';

DO $$ BEGIN
  BEGIN
    PERFORM public.rpc_apply_signed_billing_event(
      'signed-future',now()+interval '10 minutes','72000000-0000-4000-8000-100000000001',
      'payos','invoice_paid','signed-billing-test','signed-invoice-2','SINV-2',299000,'VND',
      NULL,NULL,NULL,NULL,'hash-future','v1');
    INSERT INTO signed_billing_results VALUES ('future_event_is_rejected',false,'unexpected success');
  EXCEPTION WHEN invalid_parameter_value THEN
    INSERT INTO signed_billing_results VALUES ('future_event_is_rejected',true,SQLERRM);
  END;
END $$;

INSERT INTO signed_billing_results SELECT 'unsigned_service_rpc_is_retired',
  NOT has_function_privilege('service_role',
    'public.rpc_apply_billing_event(text,uuid,text,text,text,text,text,numeric,text,timestamptz,timestamptz,uuid,text,text)',
    'EXECUTE'),'legacy service execute revoked';

RESET ROLE;
DO $$ DECLARE failed text; BEGIN
  SELECT string_agg(test_name||': '||COALESCE(details,''),E'\n') INTO failed
  FROM signed_billing_results WHERE NOT passed;
  IF failed IS NOT NULL THEN RAISE EXCEPTION E'Signed billing tests failed:\n%',failed; END IF;
END $$;
TABLE signed_billing_results;
ROLLBACK;
