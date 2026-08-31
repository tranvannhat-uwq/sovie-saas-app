BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_validate_organization_slug(p_slug text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE normalized_slug text := lower(btrim(COALESCE(p_slug, '')));
DECLARE normalized_hostname text := normalized_slug || '.sovie.vn';
DECLARE reserved_slugs constant text[] := ARRAY[
  'www','app','api','admin','auth','dashboard','billing','support','status',
  'mail','cdn','static','assets','docs','help','system','platform','sovie'
];
DECLARE valid_format boolean;
DECLARE reserved boolean;
DECLARE slug_in_use boolean;
DECLARE hostname_in_use boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;

  valid_format := normalized_slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$';
  reserved := normalized_slug = ANY(reserved_slugs);
  SELECT EXISTS (
    SELECT 1 FROM public.organizations organization
    WHERE lower(organization.slug) = normalized_slug
  ) INTO slug_in_use;
  SELECT EXISTS (
    SELECT 1 FROM public.organization_domains domain
    WHERE lower(domain.hostname) = normalized_hostname
  ) INTO hostname_in_use;

  RETURN jsonb_build_object(
    'slug', normalized_slug,
    'hostname', normalized_hostname,
    'validFormat', valid_format,
    'reserved', reserved,
    'slugInUse', slug_in_use,
    'hostnameInUse', hostname_in_use,
    'available', valid_format AND NOT reserved AND NOT slug_in_use AND NOT hostname_in_use
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.provision_organization_capabilities(
  p_organization_id uuid, p_slug text, p_name text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  default_branch_id uuid;
  normalized_hostname text := lower(btrim(p_slug)) || '.sovie.vn';
BEGIN
  INSERT INTO public.organization_settings (organization_id)
  VALUES (p_organization_id) ON CONFLICT (organization_id) DO NOTHING;

  INSERT INTO public.organization_branches (
    organization_id, code, name, is_default
  ) VALUES (p_organization_id, 'MAIN', COALESCE(NULLIF(btrim(p_name), ''), 'Chi nhánh chính'), true)
  ON CONFLICT (organization_id, (lower(code))) DO NOTHING;

  SELECT id INTO default_branch_id
  FROM public.organization_branches
  WHERE organization_id = p_organization_id AND lower(code) = 'main'
  LIMIT 1;
  IF default_branch_id IS NULL THEN
    RAISE EXCEPTION 'Default branch provisioning failed' USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.organization_warehouses (
    organization_id, branch_id, code, name, is_default
  ) VALUES (p_organization_id, default_branch_id, 'MAIN', 'Kho chính', true)
  ON CONFLICT (organization_id, (lower(code))) DO NOTHING;

  IF EXISTS (
    SELECT 1 FROM public.organization_domains domain
    WHERE lower(domain.hostname) = normalized_hostname
      AND domain.organization_id <> p_organization_id
  ) THEN
    RAISE EXCEPTION 'Workspace hostname is already in use' USING ERRCODE = '23505';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_domains domain
    WHERE lower(domain.hostname) = normalized_hostname
      AND domain.organization_id = p_organization_id
  ) THEN
    INSERT INTO public.organization_domains (
      organization_id, hostname, domain_type, status, is_primary, ssl_status
    ) VALUES (
      p_organization_id, normalized_hostname,
      'sovie_subdomain', 'active', true, 'active'
    );
  END IF;

  INSERT INTO public.organization_modules (organization_id, module_key, enabled)
  SELECT p_organization_id, module.module_key, module.enabled
  FROM (VALUES
    ('sales', true), ('customers', true), ('catalog', true),
    ('pricing', true), ('cashbook', true), ('purchasing', true),
    ('reports', true), ('inventory', false), ('manufacturing', false),
    ('payroll', false)
  ) AS module(module_key, enabled)
  ON CONFLICT (organization_id, module_key) DO NOTHING;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_settings setting
    WHERE setting.organization_id = p_organization_id
  ) OR NOT EXISTS (
    SELECT 1 FROM public.organization_warehouses warehouse
    WHERE warehouse.organization_id = p_organization_id
      AND warehouse.branch_id = default_branch_id
      AND lower(warehouse.code) = 'main' AND warehouse.is_default
  ) OR NOT EXISTS (
    SELECT 1 FROM public.organization_domains domain
    WHERE domain.organization_id = p_organization_id
      AND lower(domain.hostname) = normalized_hostname
      AND domain.domain_type = 'sovie_subdomain'
      AND domain.status = 'active' AND domain.ssl_status = 'active' AND domain.is_primary
  ) OR (
    SELECT count(*) FROM public.organization_modules module
    WHERE module.organization_id = p_organization_id
  ) < 10 THEN
    RAISE EXCEPTION 'Workspace capability provisioning is incomplete' USING ERRCODE = 'P0001';
  END IF;
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
  normalized_hostname text := normalized_slug || '.sovie.vn';
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
  IF EXISTS (
    SELECT 1 FROM public.organizations organization WHERE lower(organization.slug) = normalized_slug
  ) OR EXISTS (
    SELECT 1 FROM public.organization_domains domain WHERE lower(domain.hostname) = normalized_hostname
  ) THEN
    RAISE EXCEPTION 'Organization slug is already in use' USING ERRCODE = '23505';
  END IF;
  IF p_trial_days IS NULL OR p_trial_days < 1 OR p_trial_days > 60 THEN
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
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace settings provisioning failed' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.organization_domains domain
    WHERE domain.organization_id = created_organization.id
      AND lower(domain.hostname) = normalized_hostname
      AND domain.domain_type = 'sovie_subdomain'
      AND domain.status = 'active' AND domain.ssl_status = 'active' AND domain.is_primary
  ) THEN
    RAISE EXCEPTION 'Workspace domain provisioning failed' USING ERRCODE = 'P0001';
  END IF;

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
      'slug', normalized_slug,
      'hostname', normalized_hostname
    )
  );

  IF membership_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.organization_subscriptions subscription
    WHERE subscription.organization_id = created_organization.id
      AND subscription.plan_id = normalized_plan_id
      AND subscription.status = 'trialing'
  ) THEN
    RAISE EXCEPTION 'Workspace membership or subscription provisioning failed' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'organizationId', created_organization.id,
    'name', created_organization.name,
    'slug', created_organization.slug,
    'hostname', normalized_hostname,
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

REVOKE ALL ON FUNCTION public.provision_organization_capabilities(uuid,text,text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_validate_organization_slug(text),
  public.rpc_platform_provision_customer(uuid,text,text,text,integer,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_validate_organization_slug(text),
  public.rpc_platform_provision_customer(uuid,text,text,text,integer,text,text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0098', 'Harden platform customer preflight, domain provisioning and integrity checks')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

COMMIT;
