BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_validate_organization_slug(p_slug text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE normalized_slug text := lower(btrim(COALESCE(p_slug, '')));
DECLARE reserved_slugs constant text[] := ARRAY[
  'www','app','api','admin','auth','dashboard','billing','support','status',
  'mail','cdn','static','assets','docs','help','system','platform','sovie'
];
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'slug', normalized_slug,
    'validFormat', normalized_slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$',
    'reserved', normalized_slug = ANY(reserved_slugs),
    'available', normalized_slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'
      AND NOT normalized_slug = ANY(reserved_slugs)
      AND NOT EXISTS (
        SELECT 1 FROM public.organizations organization
        WHERE lower(organization.slug) = normalized_slug
      )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_organization(
  p_name text,
  p_slug text,
  p_business_type text,
  p_industry_key text
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  normalized_name text := btrim(COALESCE(p_name, ''));
  normalized_slug text := lower(btrim(COALESCE(p_slug, '')));
  normalized_business_type text := lower(btrim(COALESCE(p_business_type, 'general_trade')));
  normalized_industry_key text := lower(btrim(COALESCE(p_industry_key, 'general')));
  reserved_slugs constant text[] := ARRAY[
    'www','app','api','admin','auth','dashboard','billing','support','status',
    'mail','cdn','static','assets','docs','help','system','platform','sovie'
  ];
  created_organization public.organizations%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;

  -- First-workspace onboarding deliberately does not require an existing
  -- membership. The Auth-linked active profile remains mandatory.
  SELECT * INTO actor FROM public.profiles profile
  WHERE profile.auth_user_id = auth.uid() AND profile.is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION '403: active profile required' USING ERRCODE = '42501';
  END IF;

  IF char_length(normalized_name) < 2 OR char_length(normalized_name) > 120 THEN
    RAISE EXCEPTION 'Organization name must contain 2 to 120 characters'
      USING ERRCODE = '22023';
  END IF;
  IF normalized_slug !~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$' THEN
    RAISE EXCEPTION 'Organization slug must contain 3 to 64 lowercase letters, numbers or hyphens'
      USING ERRCODE = '22023';
  END IF;
  IF normalized_slug = ANY(reserved_slugs) THEN
    RAISE EXCEPTION 'Organization slug is reserved' USING ERRCODE = '22023';
  END IF;
  IF normalized_business_type NOT IN (
    'general_trade','retail','wholesale','distribution','services','manufacturing'
  ) THEN
    RAISE EXCEPTION 'Unsupported business type' USING ERRCODE = '22023';
  END IF;
  IF normalized_industry_key !~ '^[a-z0-9][a-z0-9_-]{1,62}$' THEN
    RAISE EXCEPTION 'Invalid industry key' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.organizations (slug, name, status, created_by, trial_ends_at)
  VALUES (normalized_slug, normalized_name, 'trialing', auth.uid(),
    now() + interval '14 days')
  RETURNING * INTO created_organization;

  -- Capability/catalog triggers have initialized the rows by this point.
  UPDATE public.organization_settings
  SET business_type = normalized_business_type,
      industry_key = normalized_industry_key,
      updated_at = now()
  WHERE organization_id = created_organization.id;

  UPDATE public.organization_memberships
  SET is_default = false, updated_at = now()
  WHERE auth_user_id = auth.uid() AND is_default = true;

  INSERT INTO public.organization_memberships (
    organization_id, auth_user_id, role, status, is_default, joined_at
  ) VALUES (
    created_organization.id, auth.uid(), 'owner', 'active', true, now()
  );

  INSERT INTO public.organization_subscriptions (
    organization_id, plan_id, status, current_period_start, current_period_end
  ) VALUES (
    created_organization.id, 'starter', 'trialing', now(),
    created_organization.trial_ends_at
  );

  RETURN jsonb_build_object(
    'id', created_organization.id,
    'slug', created_organization.slug,
    'name', created_organization.name,
    'role', 'owner',
    'businessType', normalized_business_type,
    'industryKey', normalized_industry_key,
    'subscriptionStatus', 'trialing',
    'trialEndsAt', created_organization.trial_ends_at
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Organization slug is already in use' USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_create_organization(p_name text, p_slug text)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.rpc_create_organization(
    p_name, p_slug, 'general_trade', 'general'
  )
$$;

REVOKE ALL ON FUNCTION public.rpc_validate_organization_slug(text),
  public.rpc_create_organization(text,text,text,text),
  public.rpc_create_organization(text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_validate_organization_slug(text),
  public.rpc_create_organization(text,text,text,text),
  public.rpc_create_organization(text,text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0063', 'Enable first-workspace onboarding, reserved slug validation and typed business setup')
ON CONFLICT (version) DO NOTHING;

COMMIT;
