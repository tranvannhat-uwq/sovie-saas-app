-- Run only on isolated Supabase staging after migration 0068.
BEGIN;

CREATE TEMP TABLE subscription_results (
  test_name text PRIMARY KEY, passed boolean NOT NULL, details text
);
GRANT ALL ON TABLE pg_temp.subscription_results TO authenticated, service_role;

INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES (
  '00000000-0000-0000-0000-000000000000',
  '68000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
  'subscription-owner@test.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
);
INSERT INTO public.organizations (id, slug, name, status, created_by)
VALUES ('68000000-0000-4000-8000-100000000001', 'subscription-test',
  'Subscription Test', 'active', '68000000-0000-4000-8000-000000000001');
INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
) VALUES ('68000000-0000-4000-8000-100000000001',
  '68000000-0000-4000-8000-000000000001', 'owner', 'active', true, now());
INSERT INTO public.organization_subscriptions (
  organization_id, plan_id, status, current_period_start, current_period_end
) VALUES ('68000000-0000-4000-8000-100000000001', 'starter', 'active', now(), now() + interval '30 days');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000001', true);
INSERT INTO subscription_results
SELECT 'active_subscription_allows_business_writes',
  public.organization_write_access_allowed('68000000-0000-4000-8000-100000000001'), NULL;
INSERT INTO public.companies (organization_id, id, code, name)
VALUES ('68000000-0000-4000-8000-100000000001',
  'subscription-company-active', 'SUB-ACTIVE', 'Subscription Active Write');
INSERT INTO subscription_results
SELECT 'active_subscription_passes_real_table_write_guard', count(*) = 1,
  format('rows=%s', count(*))
FROM public.companies WHERE organization_id = '68000000-0000-4000-8000-100000000001'
  AND id = 'subscription-company-active';
INSERT INTO subscription_results
SELECT 'browser_cannot_apply_subscription_events',
  NOT has_function_privilege('authenticated',
    'public.rpc_apply_subscription_state(text,uuid,text,text,text,timestamptz,timestamptz,text,text,text,text)', 'EXECUTE'), NULL;

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT public.rpc_apply_subscription_state(
  'subscription-test-past-due', '68000000-0000-4000-8000-100000000001',
  'starter', 'past_due', 'system', now() - interval '30 days', now(), NULL, NULL, NULL, 'hash-1'
);
RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000001', true);
INSERT INTO subscription_results
SELECT 'past_due_has_seven_day_write_grace',
  public.organization_write_access_allowed('68000000-0000-4000-8000-100000000001')
    AND payload->>'accessMode' = 'grace', payload::text
FROM (SELECT public.rpc_my_subscription_access() payload) access;

RESET ROLE;
SET LOCAL ROLE service_role;
SELECT public.rpc_apply_subscription_state(
  'subscription-test-paused', '68000000-0000-4000-8000-100000000001',
  'starter', 'paused', 'system', now(), now() + interval '30 days', NULL, NULL, NULL, 'hash-2'
);
CREATE TEMP TABLE duplicate_event AS
SELECT public.rpc_apply_subscription_state(
  'subscription-test-paused', '68000000-0000-4000-8000-100000000001',
  'starter', 'paused', 'system', now(), now() + interval '30 days', NULL, NULL, NULL, 'hash-2'
) payload;
INSERT INTO subscription_results
SELECT 'provider_events_are_idempotent', payload->>'duplicate' = 'true', payload::text
FROM duplicate_event;

RESET ROLE;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '68000000-0000-4000-8000-000000000001', true);
INSERT INTO subscription_results
SELECT 'paused_subscription_is_read_only',
  NOT public.organization_write_access_allowed('68000000-0000-4000-8000-100000000001')
    AND payload->>'accessMode' = 'read_only', payload::text
FROM (SELECT public.rpc_my_subscription_access() payload) access;
DO $$
BEGIN
  BEGIN
    INSERT INTO public.companies (organization_id, id, code, name)
    VALUES ('68000000-0000-4000-8000-100000000001',
      'subscription-company-denied', 'SUB-DENIED', 'Subscription Denied Write');
    INSERT INTO subscription_results VALUES (
      'paused_subscription_blocks_real_table_write', false, 'write unexpectedly succeeded'
    );
  EXCEPTION WHEN insufficient_privilege THEN
    INSERT INTO subscription_results VALUES (
      'paused_subscription_blocks_real_table_write', true, SQLERRM
    );
  END;
END;
$$;

RESET ROLE;
DO $$
DECLARE failed text;
BEGIN
  SELECT string_agg(test_name || ': ' || COALESCE(details, ''), E'\n')
  INTO failed FROM subscription_results WHERE NOT passed;
  IF failed IS NOT NULL THEN
    RAISE EXCEPTION E'Subscription access tests failed:\n%', failed;
  END IF;
END;
$$;
TABLE subscription_results;
ROLLBACK;
