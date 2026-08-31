BEGIN;

ALTER TABLE public.platform_customer_events
  DROP CONSTRAINT IF EXISTS platform_customer_events_event_type_check;
ALTER TABLE public.platform_customer_events
  ADD CONSTRAINT platform_customer_events_event_type_check CHECK (event_type IN (
    'customer_provisioned','plan_changed','trial_extended',
    'customer_suspended','customer_reactivated','customer_cancelled'
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
  IF normalized_action NOT IN ('change_plan','extend_trial','suspend','reactivate','cancel') THEN
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

  IF normalized_action IN ('suspend','cancel') AND char_length(normalized_reason) < 3 THEN
    RAISE EXCEPTION 'A reason of at least 3 characters is required' USING ERRCODE = '22023';
  END IF;

  CASE normalized_action
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
    CASE WHEN normalized_action = 'change_plan' THEN normalized_plan_id ELSE subscription.plan_id END,
    md5(jsonb_build_object('reason', normalized_reason, 'actor', actor_id)::text)
  );

  INSERT INTO public.platform_customer_events (
    id, actor_auth_user_id, organization_id, event_type, payload
  ) VALUES (
    event_id, actor_id, organization.id, event_type,
    jsonb_build_object(
      'action', normalized_action,
      'reason', normalized_reason,
      'previousPlanId', previous_plan_id,
      'planId', CASE WHEN normalized_action = 'change_plan' THEN normalized_plan_id ELSE subscription.plan_id END,
      'previousStatus', previous_status,
      'status', resulting_status,
      'trialDays', p_trial_days,
      'currentPeriodEnd', resulting_period_end
    )
  );

  RETURN jsonb_build_object(
    'organizationId', organization.id,
    'action', normalized_action,
    'planId', CASE WHEN normalized_action = 'change_plan' THEN normalized_plan_id ELSE subscription.plan_id END,
    'status', resulting_status,
    'organizationStatus', CASE resulting_status WHEN 'paused' THEN 'suspended' ELSE resulting_status END,
    'currentPeriodEnd', resulting_period_end,
    'eventId', event_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_platform_customer_accounts()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor_role text;
DECLARE result jsonb;
BEGIN
  SELECT staff.role INTO actor_role
  FROM public.platform_staff staff
  WHERE staff.auth_user_id = auth.uid() AND staff.is_active;
  IF actor_role IS NULL THEN
    RAISE EXCEPTION '403: platform staff required' USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'platformRole', actor_role,
    'summary', jsonb_build_object(
      'totalOrganizations', count(*),
      'activeOrganizations', count(*) FILTER (WHERE organization.status = 'active'),
      'trialOrganizations', count(*) FILTER (WHERE organization.status = 'trialing'),
      'attentionOrganizations', count(*) FILTER (WHERE organization.status IN ('past_due','suspended','cancelled'))
    ),
    'organizations', COALESCE(jsonb_agg(jsonb_build_object(
      'id', organization.id, 'name', organization.name, 'slug', organization.slug,
      'status', organization.status, 'createdAt', organization.created_at,
      'trialEndsAt', organization.trial_ends_at,
      'ownerName', owner_profile.display_name, 'ownerEmail', owner_profile.email,
      'ownerMembershipStatus', owner_profile.membership_status,
      'memberCount', COALESCE(member_summary.member_count, 0),
      'activeMemberCount', COALESCE(member_summary.active_member_count, 0),
      'planId', subscription.plan_id, 'planName', plan.name,
      'subscriptionStatus', subscription.status,
      'currentPeriodStart', subscription.current_period_start,
      'currentPeriodEnd', subscription.current_period_end,
      'graceEndsAt', subscription.grace_ends_at,
      'readOnlyEndsAt', subscription.read_only_ends_at,
      'domain', primary_domain.hostname, 'domainStatus', primary_domain.status,
      'sslStatus', primary_domain.ssl_status,
      'lastLifecycleAt', lifecycle_event.created_at,
      'lastLifecycleEvent', lifecycle_event.event_type
    ) ORDER BY organization.created_at DESC), '[]'::jsonb)
  ) INTO result
  FROM public.organizations organization
  LEFT JOIN LATERAL (
    SELECT candidate.* FROM public.organization_subscriptions candidate
    WHERE candidate.organization_id = organization.id
    ORDER BY candidate.updated_at DESC, candidate.created_at DESC LIMIT 1
  ) subscription ON true
  LEFT JOIN public.saas_plans plan ON plan.id = subscription.plan_id
  LEFT JOIN LATERAL (
    SELECT profile.display_name, auth_user.email, membership.status AS membership_status
    FROM public.organization_memberships membership
    LEFT JOIN public.profiles profile ON profile.auth_user_id = membership.auth_user_id
    LEFT JOIN auth.users auth_user ON auth_user.id = membership.auth_user_id
    WHERE membership.organization_id = organization.id AND membership.role = 'owner'
      AND membership.status IN ('active','invited')
    ORDER BY CASE membership.status WHEN 'active' THEN 0 ELSE 1 END,
      membership.joined_at NULLS LAST, membership.created_at LIMIT 1
  ) owner_profile ON true
  LEFT JOIN LATERAL (
    SELECT count(*)::integer AS member_count,
      count(*) FILTER (WHERE membership.status = 'active')::integer AS active_member_count
    FROM public.organization_memberships membership
    WHERE membership.organization_id = organization.id
  ) member_summary ON true
  LEFT JOIN LATERAL (
    SELECT domain.hostname, domain.status, domain.ssl_status
    FROM public.organization_domains domain
    WHERE domain.organization_id = organization.id AND domain.status <> 'disabled'
    ORDER BY domain.is_primary DESC, domain.domain_type, domain.created_at LIMIT 1
  ) primary_domain ON true
  LEFT JOIN LATERAL (
    SELECT event.event_type, event.created_at
    FROM public.platform_customer_events event
    WHERE event.organization_id = organization.id
    ORDER BY event.created_at DESC LIMIT 1
  ) lifecycle_event ON true;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_platform_manage_customer(uuid,text,text,integer,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_platform_manage_customer(uuid,text,text,integer,text,text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0082', 'Add platform customer subscription lifecycle management and audit')
ON CONFLICT (version) DO NOTHING;

COMMIT;
