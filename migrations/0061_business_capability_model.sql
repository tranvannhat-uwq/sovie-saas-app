BEGIN;

CREATE TABLE public.organization_settings (
  organization_id uuid PRIMARY KEY REFERENCES public.organizations(id) ON DELETE CASCADE,
  business_type text NOT NULL DEFAULT 'general_trade'
    CHECK (business_type IN ('general_trade','retail','wholesale','distribution','services','manufacturing')),
  industry_key text NOT NULL DEFAULT 'general'
    CHECK (industry_key ~ '^[a-z0-9][a-z0-9_-]{1,62}$'),
  timezone text NOT NULL DEFAULT 'Asia/Bangkok',
  locale text NOT NULL DEFAULT 'vi-VN',
  currency text NOT NULL DEFAULT 'VND',
  tax_mode text NOT NULL DEFAULT 'none'
    CHECK (tax_mode IN ('none','direct','vat')),
  branding jsonb NOT NULL DEFAULT '{}'::jsonb,
  preferences jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE public.organization_branches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  phone text,
  email text,
  tax_code text,
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);
CREATE UNIQUE INDEX organization_branches_code_uidx
  ON public.organization_branches (organization_id, lower(code));
CREATE UNIQUE INDEX organization_branches_one_default_uidx
  ON public.organization_branches (organization_id)
  WHERE is_default AND is_active;

CREATE TABLE public.organization_warehouses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  address text NOT NULL DEFAULT '',
  is_default boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CONSTRAINT organization_warehouses_branch_fkey
    FOREIGN KEY (organization_id, branch_id)
    REFERENCES public.organization_branches (organization_id, id)
    ON DELETE RESTRICT
);
CREATE UNIQUE INDEX organization_warehouses_code_uidx
  ON public.organization_warehouses (organization_id, lower(code));
CREATE UNIQUE INDEX organization_warehouses_one_default_uidx
  ON public.organization_warehouses (organization_id)
  WHERE is_default AND is_active;

CREATE TABLE public.organization_domains (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  hostname text NOT NULL CHECK (
    hostname = lower(hostname)
    AND hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
  ),
  domain_type text NOT NULL CHECK (domain_type IN ('sovie_subdomain','custom')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','verified','active','failed','disabled')),
  is_primary boolean NOT NULL DEFAULT false,
  verification_token text NOT NULL DEFAULT encode(gen_random_bytes(24), 'hex'),
  verified_at timestamptz,
  ssl_status text NOT NULL DEFAULT 'pending'
    CHECK (ssl_status IN ('pending','active','failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organization_domains_hostname_uidx
  ON public.organization_domains (lower(hostname));
CREATE UNIQUE INDEX organization_domains_one_primary_uidx
  ON public.organization_domains (organization_id)
  WHERE is_primary AND status <> 'disabled';

CREATE TABLE public.organization_modules (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  module_key text NOT NULL CHECK (module_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  enabled boolean NOT NULL DEFAULT true,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, module_key)
);

CREATE OR REPLACE FUNCTION public.provision_organization_capabilities(
  p_organization_id uuid, p_slug text, p_name text
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE default_branch_id uuid;
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

  INSERT INTO public.organization_warehouses (
    organization_id, branch_id, code, name, is_default
  ) VALUES (p_organization_id, default_branch_id, 'MAIN', 'Kho chính', true)
  ON CONFLICT (organization_id, (lower(code))) DO NOTHING;

  INSERT INTO public.organization_domains (
    organization_id, hostname, domain_type, status, is_primary, ssl_status
  ) VALUES (p_organization_id, lower(p_slug) || '.sovie.vn',
    'sovie_subdomain', 'active', true, 'active')
  ON CONFLICT ((lower(hostname))) DO NOTHING;

  INSERT INTO public.organization_modules (organization_id, module_key, enabled)
  SELECT p_organization_id, module.module_key, module.enabled
  FROM (VALUES
    ('sales', true), ('customers', true), ('catalog', true),
    ('pricing', true), ('cashbook', true), ('purchasing', true),
    ('reports', true), ('inventory', false), ('manufacturing', false),
    ('payroll', false)
  ) AS module(module_key, enabled)
  ON CONFLICT (organization_id, module_key) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.initialize_organization_capabilities()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.provision_organization_capabilities(NEW.id, NEW.slug, NEW.name);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS organizations_initialize_capabilities ON public.organizations;
CREATE TRIGGER organizations_initialize_capabilities
AFTER INSERT ON public.organizations FOR EACH ROW
EXECUTE FUNCTION public.initialize_organization_capabilities();

DO $backfill$
DECLARE organization record;
BEGIN
  FOR organization IN SELECT id, slug, name FROM public.organizations LOOP
    PERFORM public.provision_organization_capabilities(
      organization.id, organization.slug, organization.name
    );
  END LOOP;
END;
$backfill$;

UPDATE public.saas_plans SET limits = limits ||
  '{"branches":1,"warehouses":1,"custom_domains":0}'::jsonb
WHERE id = 'starter';

ALTER TABLE public.organization_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_branches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_warehouses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.organization_modules ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.organization_settings, public.organization_branches,
  public.organization_warehouses, public.organization_domains,
  public.organization_modules FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.organization_settings, public.organization_branches,
  public.organization_warehouses, public.organization_domains,
  public.organization_modules TO authenticated;

DO $policies$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'organization_settings', 'organization_branches',
    'organization_warehouses', 'organization_domains', 'organization_modules'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY tenant_read ON public.%I FOR SELECT TO authenticated USING (organization_id = public.current_organization_id())',
      table_name
    );
  END LOOP;
END;
$policies$;

CREATE OR REPLACE FUNCTION public.rpc_my_business_capabilities()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE active_organization_id uuid := public.current_organization_id();
DECLARE result jsonb;
BEGIN
  IF active_organization_id IS NULL THEN
    RAISE EXCEPTION '403: active organization membership required'
      USING ERRCODE = '42501';
  END IF;

  SELECT jsonb_build_object(
    'organizationId', active_organization_id,
    'settings', (SELECT to_jsonb(setting) - 'organization_id'
      FROM public.organization_settings setting
      WHERE setting.organization_id = active_organization_id),
    'modules', COALESCE((SELECT jsonb_object_agg(module.module_key,
      jsonb_build_object('enabled', module.enabled, 'config', module.config))
      FROM public.organization_modules module
      WHERE module.organization_id = active_organization_id), '{}'::jsonb),
    'branches', COALESCE((SELECT jsonb_agg(to_jsonb(branch) ORDER BY branch.is_default DESC, branch.name)
      FROM public.organization_branches branch
      WHERE branch.organization_id = active_organization_id AND branch.is_active), '[]'::jsonb),
    'warehouses', COALESCE((SELECT jsonb_agg(to_jsonb(warehouse) ORDER BY warehouse.is_default DESC, warehouse.name)
      FROM public.organization_warehouses warehouse
      WHERE warehouse.organization_id = active_organization_id AND warehouse.is_active), '[]'::jsonb),
    'domains', COALESCE((SELECT jsonb_agg(
      to_jsonb(domain) - 'verification_token' ORDER BY domain.is_primary DESC, domain.hostname)
      FROM public.organization_domains domain
      WHERE domain.organization_id = active_organization_id AND domain.status <> 'disabled'), '[]'::jsonb),
    'planLimits', COALESCE((SELECT plan.limits
      FROM public.organization_subscriptions subscription
      JOIN public.saas_plans plan ON plan.id = subscription.plan_id
      WHERE subscription.organization_id = active_organization_id
        AND subscription.status IN ('trialing','active','past_due','paused')
      ORDER BY subscription.created_at DESC LIMIT 1), '{}'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_organization_capabilities(uuid,text,text),
  public.initialize_organization_capabilities() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_my_business_capabilities() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_my_business_capabilities() TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0061', 'Add organization settings, modules, branches, warehouses and domains')
ON CONFLICT (version) DO NOTHING;

COMMIT;
