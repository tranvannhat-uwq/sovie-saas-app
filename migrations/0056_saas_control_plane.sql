BEGIN;

-- SaaS control plane. Existing business rows remain in one legacy
-- organization until a later migration has tenant-scoped every business table.
CREATE TABLE IF NOT EXISTS public.saas_plans (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  price_monthly numeric(14, 2) NOT NULL DEFAULT 0 CHECK (price_monthly >= 0),
  currency text NOT NULL DEFAULT 'VND',
  limits jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_public boolean NOT NULL DEFAULT true,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'active', 'past_due', 'suspended', 'cancelled')),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  trial_ends_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT organizations_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$')
);
CREATE UNIQUE INDEX IF NOT EXISTS organizations_slug_lower_uidx
  ON public.organizations (lower(slug));

CREATE TABLE IF NOT EXISTS public.organization_memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'sale'
    CHECK (role IN ('owner', 'admin', 'accounting', 'sale')),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('invited', 'active', 'suspended')),
  is_default boolean NOT NULL DEFAULT false,
  invited_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  joined_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, auth_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_memberships_one_default_uidx
  ON public.organization_memberships (auth_user_id)
  WHERE is_default = true AND status = 'active';
CREATE INDEX IF NOT EXISTS organization_memberships_user_idx
  ON public.organization_memberships (auth_user_id, status);

CREATE TABLE IF NOT EXISTS public.organization_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_id text NOT NULL REFERENCES public.saas_plans(id),
  status text NOT NULL DEFAULT 'trialing'
    CHECK (status IN ('trialing', 'active', 'past_due', 'paused', 'cancelled')),
  provider text,
  provider_customer_id text,
  provider_subscription_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_subscriptions_one_current_uidx
  ON public.organization_subscriptions (organization_id)
  WHERE status IN ('trialing', 'active', 'past_due', 'paused');
CREATE UNIQUE INDEX IF NOT EXISTS organization_subscriptions_provider_uidx
  ON public.organization_subscriptions (provider, provider_subscription_id)
  WHERE provider IS NOT NULL AND provider_subscription_id IS NOT NULL;

INSERT INTO public.saas_plans (id, name, description, price_monthly, limits)
VALUES ('starter', 'Starter', 'Goi dung thu mac dinh cho workspace moi', 0,
  '{"users":5,"monthly_orders":500}'::jsonb)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organizations (id, slug, name, status, trial_ends_at)
VALUES ('00000000-0000-4000-8000-000000000001'::uuid,
  'legacy-weblendon', 'Weblendon Legacy', 'active', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.organization_memberships (
  organization_id, auth_user_id, role, status, is_default, joined_at
)
SELECT
  '00000000-0000-4000-8000-000000000001'::uuid,
  profile.auth_user_id,
  CASE profile.role WHEN 'admin' THEN 'owner'
    WHEN 'accounting' THEN 'accounting' ELSE 'sale' END,
  'active', true, now()
FROM public.profiles profile
WHERE profile.auth_user_id IS NOT NULL
ON CONFLICT (organization_id, auth_user_id) DO NOTHING;

INSERT INTO public.organization_subscriptions (organization_id, plan_id, status)
VALUES ('00000000-0000-4000-8000-000000000001'::uuid, 'starter', 'active')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION public.can_access_organization(p_organization_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships membership
    WHERE membership.organization_id = p_organization_id
      AND membership.auth_user_id = auth.uid()
      AND membership.status = 'active'
  )
$$;

CREATE OR REPLACE FUNCTION public.has_organization_role(
  p_organization_id uuid, p_roles text[]
) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships membership
    WHERE membership.organization_id = p_organization_id
      AND membership.auth_user_id = auth.uid()
      AND membership.status = 'active'
      AND membership.role = ANY(p_roles)
  )
$$;

CREATE OR REPLACE FUNCTION public.current_organization_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT membership.organization_id
  FROM public.organization_memberships membership
  WHERE membership.auth_user_id = auth.uid()
    AND membership.status = 'active'
  ORDER BY membership.is_default DESC, membership.created_at ASC
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.rpc_my_saas_context()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
  SELECT jsonb_build_object(
    'activeOrganizationId', public.current_organization_id(),
    'organizations', COALESCE(jsonb_agg(
      jsonb_build_object(
        'id', organization.id, 'slug', organization.slug,
        'name', organization.name, 'status', organization.status,
        'role', membership.role, 'isDefault', membership.is_default,
        'subscription', CASE WHEN subscription.id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'planId', subscription.plan_id, 'status', subscription.status,
            'currentPeriodEnd', subscription.current_period_end,
            'cancelAtPeriodEnd', subscription.cancel_at_period_end
          ) END
      ) ORDER BY membership.is_default DESC, organization.name
    ) FILTER (WHERE organization.id IS NOT NULL), '[]'::jsonb)
  )
  FROM public.organization_memberships membership
  JOIN public.organizations organization ON organization.id = membership.organization_id
  LEFT JOIN public.organization_subscriptions subscription
    ON subscription.organization_id = organization.id
   AND subscription.status IN ('trialing', 'active', 'past_due', 'paused')
  WHERE membership.auth_user_id = auth.uid()
    AND membership.status = 'active'
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_organization(p_name text, p_slug text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  normalized_name text := btrim(COALESCE(p_name, ''));
  normalized_slug text := lower(btrim(COALESCE(p_slug, '')));
  created_organization public.organizations%ROWTYPE;
BEGIN
  actor := public.require_authenticated_profile();
  IF char_length(normalized_name) < 2 OR char_length(normalized_name) > 120 THEN
    RAISE EXCEPTION 'Organization name must contain 2 to 120 characters'
      USING ERRCODE = '22023';
  END IF;
  IF normalized_slug !~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$' THEN
    RAISE EXCEPTION 'Organization slug must contain 3 to 64 lowercase letters, numbers or hyphens'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.organizations (slug, name, status, created_by, trial_ends_at)
  VALUES (normalized_slug, normalized_name, 'trialing', actor.auth_user_id,
    now() + interval '14 days')
  RETURNING * INTO created_organization;

  UPDATE public.organization_memberships
  SET is_default = false, updated_at = now()
  WHERE auth_user_id = actor.auth_user_id AND is_default = true;

  INSERT INTO public.organization_memberships (
    organization_id, auth_user_id, role, status, is_default, joined_at
  ) VALUES (created_organization.id, actor.auth_user_id, 'owner', 'active', true, now());

  INSERT INTO public.organization_subscriptions (
    organization_id, plan_id, status, current_period_start, current_period_end
  ) VALUES (created_organization.id, 'starter', 'trialing', now(),
    created_organization.trial_ends_at);

  RETURN jsonb_build_object(
    'id', created_organization.id, 'slug', created_organization.slug,
    'name', created_organization.name, 'role', 'owner',
    'subscriptionStatus', 'trialing'
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Organization slug is already in use' USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_set_default_organization(p_organization_id uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.can_access_organization(p_organization_id) THEN
    RAISE EXCEPTION '403: organization membership required' USING ERRCODE = '42501';
  END IF;
  UPDATE public.organization_memberships
  SET is_default = false, updated_at = now()
  WHERE auth_user_id = auth.uid() AND is_default = true;
  UPDATE public.organization_memberships
  SET is_default = true, updated_at = now()
  WHERE auth_user_id = auth.uid()
    AND organization_id = p_organization_id AND status = 'active';
  RETURN p_organization_id;
END;
$$;

ALTER TABLE public.saas_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.saas_plans, public.organizations,
  public.organization_memberships, public.organization_subscriptions
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.saas_plans TO authenticated;
GRANT SELECT ON TABLE public.organizations TO authenticated;
GRANT SELECT ON TABLE public.organization_memberships TO authenticated;
GRANT SELECT ON TABLE public.organization_subscriptions TO authenticated;

CREATE POLICY saas_plans_authenticated_read ON public.saas_plans
  FOR SELECT TO authenticated USING (is_active = true);
CREATE POLICY organizations_member_read ON public.organizations
  FOR SELECT TO authenticated USING (public.can_access_organization(id));
CREATE POLICY organization_memberships_member_read ON public.organization_memberships
  FOR SELECT TO authenticated USING (public.can_access_organization(organization_id));
CREATE POLICY organization_subscriptions_member_read ON public.organization_subscriptions
  FOR SELECT TO authenticated USING (public.can_access_organization(organization_id));

REVOKE ALL ON FUNCTION public.can_access_organization(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.has_organization_role(uuid, text[]) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.current_organization_id() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_my_saas_context() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_create_organization(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_set_default_organization(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_access_organization(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.has_organization_role(uuid, text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_organization_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_my_saas_context() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_create_organization(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_default_organization(uuid) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0056', 'Add SaaS organizations, memberships, plans, subscriptions and onboarding RPCs')
ON CONFLICT (version) DO NOTHING;

COMMIT;
