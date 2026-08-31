BEGIN;

CREATE TABLE public.platform_customer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  organization_id uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  event_type text NOT NULL CHECK (event_type IN ('customer_provisioned')),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX platform_customer_events_organization_idx
  ON public.platform_customer_events (organization_id, created_at DESC);
CREATE INDEX platform_customer_events_actor_idx
  ON public.platform_customer_events (actor_auth_user_id, created_at DESC);

ALTER TABLE public.platform_customer_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_customer_events FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_platform_active_plans()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.is_platform_staff(ARRAY['platform_owner','billing']) THEN
    RAISE EXCEPTION '403: platform billing access required' USING ERRCODE = '42501';
  END IF;

  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', plan.id,
      'name', plan.name,
      'description', plan.description,
      'priceMonthly', plan.price_monthly,
      'currency', plan.currency,
      'limits', plan.limits
    ) ORDER BY plan.price_monthly, plan.id)
    FROM public.saas_plans plan
    WHERE plan.is_active
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_platform_provision_customer(
  p_owner_auth_user_id uuid,
  p_name text,
  p_slug text,
  p_plan_id text DEFAULT 'starter',
  p_trial_days integer DEFAULT 14,
  p_business_type text DEFAULT 'general_trade',
  p_industry_key text DEFAULT 'general'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := auth.uid();
  normalized_name text := btrim(COALESCE(p_name, ''));
  normalized_slug text := lower(btrim(COALESCE(p_slug, '')));
  normalized_plan_id text := lower(btrim(COALESCE(p_plan_id, 'starter')));
  normalized_business_type text := lower(btrim(COALESCE(p_business_type, 'general_trade')));
  normalized_industry_key text := lower(btrim(COALESCE(p_industry_key, 'general')));
  reserved_slugs constant text[] := ARRAY[
    'www','app','api','admin','auth','dashboard','billing','support','status',
    'mail','cdn','static','assets','docs','help','system','platform','sovie'
  ];
  created_organization public.organizations%ROWTYPE;
  owner_profile public.profiles%ROWTYPE;
  membership_id uuid;
BEGIN
  IF actor_id IS NULL OR NOT public.is_platform_staff(ARRAY['platform_owner']) THEN
    RAISE EXCEPTION '403: platform owner required' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO owner_profile
  FROM public.profiles profile
  WHERE profile.auth_user_id = p_owner_auth_user_id AND profile.is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active Auth-linked owner profile required' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.platform_staff staff
    WHERE staff.auth_user_id = p_owner_auth_user_id AND staff.is_active
  ) THEN
    RAISE EXCEPTION 'Platform staff cannot own a customer organization' USING ERRCODE = '22023';
  END IF;

  IF char_length(normalized_name) < 2 OR char_length(normalized_name) > 120 THEN
    RAISE EXCEPTION 'Organization name must contain 2 to 120 characters' USING ERRCODE = '22023';
  END IF;
  IF normalized_slug !~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'
    OR normalized_slug = ANY(reserved_slugs) THEN
    RAISE EXCEPTION 'Invalid or reserved organization slug' USING ERRCODE = '22023';
  END IF;
  IF p_trial_days < 1 OR p_trial_days > 60 THEN
    RAISE EXCEPTION 'Trial period must contain 1 to 60 days' USING ERRCODE = '22023';
  END IF;
  IF normalized_business_type NOT IN (
    'general_trade','retail','wholesale','distribution','services','manufacturing'
  ) THEN
    RAISE EXCEPTION 'Unsupported business type' USING ERRCODE = '22023';
  END IF;
  IF normalized_industry_key !~ '^[a-z0-9][a-z0-9_-]{1,62}$' THEN
    RAISE EXCEPTION 'Invalid industry key' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.saas_plans plan
    WHERE plan.id = normalized_plan_id AND plan.is_active
  ) THEN
    RAISE EXCEPTION 'Active SaaS plan required' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.organizations (slug, name, status, created_by, trial_ends_at)
  VALUES (normalized_slug, normalized_name, 'trialing', actor_id,
    now() + make_interval(days => p_trial_days))
  RETURNING * INTO created_organization;

  UPDATE public.organization_settings
  SET business_type = normalized_business_type,
      industry_key = normalized_industry_key,
      updated_at = now()
  WHERE organization_id = created_organization.id;

  INSERT INTO public.organization_memberships (
    organization_id, auth_user_id, role, status, is_default,
    invited_by, joined_at, updated_at
  ) VALUES (
    created_organization.id, p_owner_auth_user_id, 'owner', 'invited', false,
    actor_id, NULL, now()
  ) RETURNING id INTO membership_id;

  INSERT INTO public.organization_subscriptions (
    organization_id, plan_id, status, current_period_start, current_period_end
  ) VALUES (
    created_organization.id, normalized_plan_id, 'trialing', now(),
    created_organization.trial_ends_at
  );

  INSERT INTO public.platform_customer_events (
    actor_auth_user_id, organization_id, event_type, payload
  ) VALUES (
    actor_id, created_organization.id, 'customer_provisioned',
    jsonb_build_object(
      'ownerAuthUserId', p_owner_auth_user_id,
      'ownerEmail', owner_profile.username,
      'planId', normalized_plan_id,
      'trialDays', p_trial_days,
      'slug', normalized_slug
    )
  );

  RETURN jsonb_build_object(
    'organizationId', created_organization.id,
    'name', created_organization.name,
    'slug', created_organization.slug,
    'planId', normalized_plan_id,
    'trialEndsAt', created_organization.trial_ends_at,
    'ownerAuthUserId', p_owner_auth_user_id,
    'ownerMembershipId', membership_id,
    'ownerStatus', 'invited'
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Organization slug is already in use' USING ERRCODE = '23505';
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
      'currentPeriodEnd', subscription.current_period_end,
      'domain', primary_domain.hostname, 'domainStatus', primary_domain.status,
      'sslStatus', primary_domain.ssl_status
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
  ) primary_domain ON true;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_platform_active_plans(),
  public.rpc_platform_provision_customer(uuid,text,text,text,integer,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_platform_active_plans(),
  public.rpc_platform_provision_customer(uuid,text,text,text,integer,text,text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0081', 'Add platform-owned customer provisioning and audit trail')
ON CONFLICT (version) DO NOTHING;

COMMIT;
