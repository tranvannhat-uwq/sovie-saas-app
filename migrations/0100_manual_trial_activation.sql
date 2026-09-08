BEGIN;

ALTER TABLE public.platform_customer_events
  DROP CONSTRAINT IF EXISTS platform_customer_events_event_type_check;
ALTER TABLE public.platform_customer_events
  ADD CONSTRAINT platform_customer_events_event_type_check CHECK (event_type IN (
    'customer_provisioned', 'plan_changed', 'trial_extended', 'customer_activated',
    'customer_suspended', 'customer_reactivated', 'customer_cancelled',
    'plan_catalog_updated', 'billing_configuration_updated'
  ));

CREATE OR REPLACE FUNCTION public.rpc_platform_manage_customer(
  p_organization_id uuid,
  p_action text,
  p_plan_id text DEFAULT NULL,
  p_trial_days integer DEFAULT NULL,
  p_reason text DEFAULT '',
  p_confirmation_slug text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := auth.uid();
  normalized_action text := lower(btrim(COALESCE(p_action, '')));
  normalized_plan_id text := lower(btrim(COALESCE(p_plan_id, '')));
  normalized_reason text := left(btrim(COALESCE(p_reason, '')), 500);
  organization public.organizations%ROWTYPE;
  subscription public.organization_subscriptions%ROWTYPE;
  previous_plan_id text;
  previous_status text;
  resulting_status text;
  resulting_period_end timestamptz;
  event_type text;
  event_id uuid := gen_random_uuid();
BEGIN
  IF actor_id IS NULL OR NOT public.is_platform_staff(ARRAY['platform_owner']) THEN
    RAISE EXCEPTION '403: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF normalized_action NOT IN ('activate', 'change_plan', 'extend_trial', 'suspend', 'reactivate', 'cancel') THEN
    RAISE EXCEPTION 'Unsupported customer lifecycle action' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO organization
  FROM public.organizations candidate
  WHERE candidate.id = p_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer organization not found' USING ERRCODE = 'P0002';
  END IF;
  IF organization.status = 'archived' THEN
    RAISE EXCEPTION 'Archived customer organizations cannot be changed' USING ERRCODE = '55000';
  END IF;

  SELECT * INTO subscription
  FROM public.organization_subscriptions candidate
  WHERE candidate.organization_id = p_organization_id
  ORDER BY candidate.updated_at DESC, candidate.created_at DESC
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Customer subscription not found' USING ERRCODE = 'P0002';
  END IF;

  previous_plan_id := subscription.plan_id;
  previous_status := subscription.status;
  resulting_status := subscription.status;
  resulting_period_end := subscription.current_period_end;

  IF normalized_action IN ('activate', 'suspend', 'cancel') AND char_length(normalized_reason) < 3 THEN
    RAISE EXCEPTION 'A reason of at least 3 characters is required' USING ERRCODE = '22023';
  END IF;

  CASE normalized_action
    WHEN 'activate' THEN
      IF subscription.status <> 'trialing' OR organization.status <> 'trialing' THEN
        RAISE EXCEPTION 'Only trialing customers can be activated manually' USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.saas_plans plan
        WHERE plan.id = normalized_plan_id AND plan.is_active
      ) THEN
        RAISE EXCEPTION 'Active SaaS plan required' USING ERRCODE = '22023';
      END IF;
      IF p_trial_days IS NULL OR p_trial_days < 1 OR p_trial_days > 3650 THEN
        RAISE EXCEPTION 'Service period must contain 1 to 3650 days' USING ERRCODE = '22023';
      END IF;
      resulting_status := 'active';
      resulting_period_end := now() + make_interval(days => p_trial_days);
      UPDATE public.organization_subscriptions
      SET plan_id = normalized_plan_id,
          status = 'active',
          current_period_start = now(),
          current_period_end = resulting_period_end,
          grace_ends_at = NULL,
          read_only_ends_at = NULL,
          updated_at = now()
      WHERE id = subscription.id;
      UPDATE public.organizations
      SET status = 'active', trial_ends_at = NULL, updated_at = now()
      WHERE id = organization.id;
      event_type := 'customer_activated';

    WHEN 'change_plan' THEN
      IF subscription.status = 'cancelled' OR organization.status = 'cancelled' THEN
        RAISE EXCEPTION 'Cancelled customers cannot change plan' USING ERRCODE = '55000';
      END IF;
      IF NOT EXISTS (
        SELECT 1 FROM public.saas_plans plan
        WHERE plan.id = normalized_plan_id AND plan.is_active
      ) THEN
        RAISE EXCEPTION 'Active SaaS plan required' USING ERRCODE = '22023';
      END IF;
      UPDATE public.organization_subscriptions
      SET plan_id = normalized_plan_id, updated_at = now()
      WHERE id = subscription.id;
      event_type := 'plan_changed';

    WHEN 'extend_trial' THEN
      IF subscription.status <> 'trialing' OR organization.status <> 'trialing' THEN
        RAISE EXCEPTION 'Only trialing customers can receive a trial extension' USING ERRCODE = '55000';
      END IF;
      IF p_trial_days IS NULL OR p_trial_days < 1 OR p_trial_days > 60 THEN
        RAISE EXCEPTION 'Trial extension must contain 1 to 60 days' USING ERRCODE = '22023';
      END IF;
      resulting_period_end := greatest(
        COALESCE(subscription.current_period_end, organization.trial_ends_at, now()), now()
      ) + make_interval(days => p_trial_days);
      UPDATE public.organization_subscriptions
      SET current_period_end = resulting_period_end, updated_at = now()
      WHERE id = subscription.id;
      UPDATE public.organizations
      SET trial_ends_at = resulting_period_end, updated_at = now()
      WHERE id = organization.id;
      event_type := 'trial_extended';

    WHEN 'suspend' THEN
      IF subscription.status = 'cancelled' OR organization.status = 'cancelled' THEN
        RAISE EXCEPTION 'Cancelled customers cannot be suspended' USING ERRCODE = '55000';
      END IF;
      resulting_status := 'paused';
      UPDATE public.organization_subscriptions
      SET status = 'paused', grace_ends_at = NULL, read_only_ends_at = NULL, updated_at = now()
      WHERE id = subscription.id;
      UPDATE public.organizations SET status = 'suspended', updated_at = now()
      WHERE id = organization.id;
      event_type := 'customer_suspended';

    WHEN 'reactivate' THEN
      IF subscription.status <> 'paused' OR organization.status <> 'suspended' THEN
        RAISE EXCEPTION 'Only suspended customers can be reactivated' USING ERRCODE = '55000';
      END IF;
      resulting_status := 'active';
      UPDATE public.organization_subscriptions
      SET status = 'active', grace_ends_at = NULL, read_only_ends_at = NULL, updated_at = now()
      WHERE id = subscription.id;
      UPDATE public.organizations SET status = 'active', updated_at = now()
      WHERE id = organization.id;
      event_type := 'customer_reactivated';

    WHEN 'cancel' THEN
      IF lower(btrim(COALESCE(p_confirmation_slug, ''))) <> lower(organization.slug) THEN
        RAISE EXCEPTION 'Type the exact customer slug to confirm cancellation' USING ERRCODE = '22023';
      END IF;
      IF subscription.status = 'cancelled' OR organization.status = 'cancelled' THEN
        RAISE EXCEPTION 'Customer is already cancelled' USING ERRCODE = '55000';
      END IF;
      resulting_status := 'cancelled';
      resulting_period_end := COALESCE(subscription.current_period_end, now());
      UPDATE public.organization_subscriptions
      SET status = 'cancelled', cancel_at_period_end = false,
          read_only_ends_at = now() + interval '30 days', grace_ends_at = NULL,
          updated_at = now()
      WHERE id = subscription.id;
      UPDATE public.organizations SET status = 'cancelled', updated_at = now()
      WHERE id = organization.id;
      event_type := 'customer_cancelled';
  END CASE;

  INSERT INTO public.subscription_state_events (
    organization_id, event_key, source, from_status, to_status, plan_id, payload_hash
  ) VALUES (
    organization.id, 'platform:' || normalized_action || ':' || event_id::text,
    'manual', previous_status, resulting_status,
    CASE WHEN normalized_action IN ('activate', 'change_plan') THEN normalized_plan_id ELSE subscription.plan_id END,
    md5(jsonb_build_object('reason', normalized_reason, 'actor', actor_id, 'plan', normalized_plan_id, 'days', p_trial_days)::text)
  );

  INSERT INTO public.platform_customer_events (
    id, actor_auth_user_id, organization_id, event_type, payload
  ) VALUES (
    event_id, actor_id, organization.id, event_type,
    jsonb_build_object(
      'action', normalized_action,
      'reason', normalized_reason,
      'previousPlanId', previous_plan_id,
      'planId', CASE WHEN normalized_action IN ('activate', 'change_plan') THEN normalized_plan_id ELSE subscription.plan_id END,
      'previousStatus', previous_status,
      'status', resulting_status,
      'serviceDays', CASE WHEN normalized_action = 'activate' THEN p_trial_days ELSE NULL END,
      'trialDays', CASE WHEN normalized_action = 'extend_trial' THEN p_trial_days ELSE NULL END,
      'currentPeriodEnd', resulting_period_end
    )
  );

  RETURN jsonb_build_object(
    'organizationId', organization.id,
    'action', normalized_action,
    'planId', CASE WHEN normalized_action IN ('activate', 'change_plan') THEN normalized_plan_id ELSE subscription.plan_id END,
    'status', resulting_status,
    'organizationStatus', CASE resulting_status WHEN 'paused' THEN 'suspended' ELSE resulting_status END,
    'currentPeriodEnd', resulting_period_end,
    'eventId', event_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_platform_manage_customer(uuid, text, text, integer, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_platform_manage_customer(uuid, text, text, integer, text, text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0100', 'Allow audited platform-owner activation of trial subscriptions')
ON CONFLICT (version) DO NOTHING;

COMMIT;
