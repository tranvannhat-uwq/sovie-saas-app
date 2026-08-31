BEGIN;

-- Platform staff is deliberately separate from tenant memberships. A tenant
-- Owner/Admin must never gain cross-organization visibility through its
-- workspace role, email address or profile role.
CREATE TABLE public.platform_staff (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('platform_owner','support','billing','analyst')),
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_staff ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_staff FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.is_platform_staff(p_roles text[] DEFAULT NULL)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.platform_staff staff
    WHERE staff.auth_user_id = auth.uid()
      AND staff.is_active
      AND (p_roles IS NULL OR staff.role = ANY(p_roles))
  )
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
      'attentionOrganizations', count(*) FILTER (
        WHERE organization.status IN ('past_due','suspended','cancelled')
      )
    ),
    'organizations', COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', organization.id,
        'name', organization.name,
        'slug', organization.slug,
        'status', organization.status,
        'createdAt', organization.created_at,
        'trialEndsAt', organization.trial_ends_at,
        'ownerName', owner_profile.display_name,
        'ownerEmail', owner_profile.email,
        'memberCount', COALESCE(member_summary.member_count, 0),
        'activeMemberCount', COALESCE(member_summary.active_member_count, 0),
        'planId', subscription.plan_id,
        'planName', plan.name,
        'subscriptionStatus', subscription.status,
        'currentPeriodEnd', subscription.current_period_end,
        'domain', primary_domain.hostname,
        'domainStatus', primary_domain.status,
        'sslStatus', primary_domain.ssl_status
      ) ORDER BY organization.created_at DESC
    ), '[]'::jsonb)
  ) INTO result
  FROM public.organizations organization
  LEFT JOIN LATERAL (
    SELECT candidate.*
    FROM public.organization_subscriptions candidate
    WHERE candidate.organization_id = organization.id
    ORDER BY candidate.updated_at DESC, candidate.created_at DESC
    LIMIT 1
  ) subscription ON true
  LEFT JOIN public.saas_plans plan ON plan.id = subscription.plan_id
  LEFT JOIN LATERAL (
    SELECT profile.display_name, auth_user.email
    FROM public.organization_memberships membership
    LEFT JOIN public.profiles profile ON profile.auth_user_id = membership.auth_user_id
    LEFT JOIN auth.users auth_user ON auth_user.id = membership.auth_user_id
    WHERE membership.organization_id = organization.id
      AND membership.role = 'owner'
      AND membership.status = 'active'
    ORDER BY membership.joined_at NULLS LAST, membership.created_at
    LIMIT 1
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
    ORDER BY domain.is_primary DESC, domain.domain_type, domain.created_at
    LIMIT 1
  ) primary_domain ON true;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.is_platform_staff(text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_platform_customer_accounts() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_platform_staff(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_platform_customer_accounts() TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0080', 'Add isolated platform staff role and customer account console')
ON CONFLICT (version) DO NOTHING;

COMMIT;
