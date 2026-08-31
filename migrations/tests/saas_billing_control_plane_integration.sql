-- Run only on isolated Supabase staging after migration 0071.
BEGIN;

CREATE TEMP TABLE billing_results (test_name text PRIMARY KEY, passed boolean NOT NULL, details text);
GRANT ALL ON TABLE pg_temp.billing_results TO authenticated, service_role;

INSERT INTO public.saas_plans (id, name, description, price_monthly, limits, is_public, is_active)
VALUES ('billing-test', 'Billing Test', 'Integration-only paid plan', 199000,
  '{"users":10,"monthly_orders":2000,"custom_domains":1}'::jsonb, true, true);

INSERT INTO auth.users (instance_id,id,aud,role,email,encrypted_password,raw_app_meta_data,raw_user_meta_data,created_at,updated_at)
SELECT '00000000-0000-0000-0000-000000000000', identity.id, 'authenticated', 'authenticated',
  identity.email, '', '{}'::jsonb, '{}'::jsonb, now(), now()
FROM (VALUES
  ('71000000-0000-4000-8000-000000000001'::uuid,'billing-owner-a@test.invalid'),
  ('71000000-0000-4000-8000-000000000002'::uuid,'billing-admin-a@test.invalid'),
  ('71000000-0000-4000-8000-000000000003'::uuid,'billing-owner-b@test.invalid')
) identity(id,email);
INSERT INTO public.organizations (id,slug,name,status,created_by) VALUES
  ('71000000-0000-4000-8000-100000000001','billing-a','Billing A','active','71000000-0000-4000-8000-000000000001'),
  ('71000000-0000-4000-8000-100000000002','billing-b','Billing B','active','71000000-0000-4000-8000-000000000003');
INSERT INTO public.organization_memberships (organization_id,auth_user_id,role,status,is_default,joined_at) VALUES
  ('71000000-0000-4000-8000-100000000001','71000000-0000-4000-8000-000000000001','owner','active',true,now()),
  ('71000000-0000-4000-8000-100000000001','71000000-0000-4000-8000-000000000002','admin','active',true,now()),
  ('71000000-0000-4000-8000-100000000002','71000000-0000-4000-8000-000000000003','owner','active',true,now());
INSERT INTO public.organization_subscriptions (organization_id,plan_id,status,current_period_start,current_period_end) VALUES
  ('71000000-0000-4000-8000-100000000001','starter','active',now(),now()+interval '30 days'),
  ('71000000-0000-4000-8000-100000000002','starter','active',now(),now()+interval '30 days');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
CREATE TEMP TABLE requested_checkout AS
SELECT public.rpc_request_plan_change('billing-test','billing-request-0001','monthly') payload;
GRANT SELECT ON TABLE pg_temp.requested_checkout TO service_role;
INSERT INTO billing_results SELECT 'owner_can_request_plan_change',
  payload->>'status'='pending' AND payload->>'planId'='billing-test', payload::text FROM requested_checkout;

INSERT INTO billing_results SELECT 'request_key_is_idempotent',
  (public.rpc_request_plan_change('billing-test','billing-request-0001','monthly')->>'duplicate')::boolean,
  'same request returned';

SELECT set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000002',true);
DO $$ BEGIN
  BEGIN
    PERFORM public.rpc_request_plan_change('billing-test','billing-admin-denied','monthly');
    INSERT INTO billing_results VALUES ('non_owner_cannot_request_plan_change',false,'unexpected success');
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO billing_results VALUES ('non_owner_cannot_request_plan_change',true,SQLERRM);
  END;
END $$;

RESET ROLE;
SET LOCAL ROLE service_role;
CREATE TEMP TABLE paid_event AS SELECT public.rpc_apply_billing_event(
  'billing-paid-0001','71000000-0000-4000-8000-100000000001','payos','invoice_paid',
  'billing-test','invoice-a-001','INV-A-001',199000,'VND',now(),now()+interval '30 days',
  (SELECT (payload->>'requestId')::uuid FROM requested_checkout),
  'https://billing.example.test/invoice-a-001','hash-paid-1'
) payload;
INSERT INTO billing_results SELECT 'service_paid_event_activates_plan_and_invoice',
  payload->>'subscriptionStatus'='active' AND payload->>'invoiceStatus'='paid',payload::text FROM paid_event;
INSERT INTO billing_results SELECT 'webhook_event_is_idempotent',
  (public.rpc_apply_billing_event(
    'billing-paid-0001','71000000-0000-4000-8000-100000000001','payos','invoice_paid',
    'billing-test','invoice-a-001','INV-A-001',199000,'VND',NULL,NULL,NULL,NULL,'hash-paid-1'
  )->>'duplicate')::boolean,'duplicate event returned';

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000001',true);
INSERT INTO billing_results SELECT 'owner_summary_contains_completed_checkout_and_invoice',
  summary->'subscription'->>'plan_id'='billing-test'
    AND summary->'checkoutRequest'->>'status'='completed'
    AND jsonb_array_length(summary->'invoices')=1, summary::text
FROM (SELECT public.rpc_my_billing_summary() summary) data;

SELECT set_config('request.jwt.claim.sub','71000000-0000-4000-8000-000000000003',true);
INSERT INTO billing_results SELECT 'invoice_is_tenant_private', count(*)=0,
  'visible invoices='||count(*) FROM public.billing_invoices;

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT public.rpc_apply_billing_event(
  'billing-failed-0002','71000000-0000-4000-8000-100000000001','payos','invoice_failed',
  'billing-test','invoice-a-002','INV-A-002',199000,'VND',now(),now()+interval '30 days',
  NULL,'https://billing.example.test/invoice-a-002','hash-failed-2'
);
INSERT INTO billing_results SELECT 'failed_invoice_enters_subscription_grace', status='past_due',status
FROM public.organization_subscriptions WHERE organization_id='71000000-0000-4000-8000-100000000001'
ORDER BY updated_at DESC LIMIT 1;

RESET ROLE;
DO $$ DECLARE failed text; BEGIN
  SELECT string_agg(test_name||': '||COALESCE(details,''),E'\n') INTO failed
  FROM billing_results WHERE NOT passed;
  IF failed IS NOT NULL THEN RAISE EXCEPTION E'Billing tests failed:\n%',failed; END IF;
END $$;
TABLE billing_results;
ROLLBACK;
