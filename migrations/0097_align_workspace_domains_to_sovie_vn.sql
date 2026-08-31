BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0096') THEN
    RAISE EXCEPTION 'Migration 0097 requires migration 0096';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.organization_domains
    WHERE domain_type = 'custom'
      AND (lower(hostname) = 'sovie.vn' OR lower(hostname) LIKE '%.sovie.vn')
  ) THEN
    RAISE EXCEPTION 'Review existing custom sovie.vn domains before migration 0097';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM public.organization_domains managed
    JOIN public.organizations organization ON organization.id = managed.organization_id
    JOIN public.organization_domains collision
      ON lower(collision.hostname) = lower(organization.slug) || '.sovie.vn'
     AND collision.id <> managed.id
    WHERE managed.domain_type = 'sovie_subdomain'
  ) THEN
    RAISE EXCEPTION 'Target sovie.vn hostname collision detected';
  END IF;
END;
$prerequisite$;

UPDATE public.organization_domains domain
SET hostname = lower(organization.slug) || '.sovie.vn',
    updated_at = now()
FROM public.organizations organization
WHERE organization.id = domain.organization_id
  AND domain.domain_type = 'sovie_subdomain'
  AND lower(domain.hostname) IS DISTINCT FROM lower(organization.slug) || '.sovie.vn';

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

REVOKE ALL ON FUNCTION public.provision_organization_capabilities(uuid,text,text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enforce_sovie_internal_domain_boundary()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.domain_type = 'custom'
    AND (lower(NEW.hostname) = 'sovie.vn' OR lower(NEW.hostname) LIKE '%.sovie.vn') THEN
    RAISE EXCEPTION 'A valid external custom hostname is required' USING ERRCODE = '22023';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_sovie_internal_domain_boundary()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS organization_domains_internal_suffix_guard
  ON public.organization_domains;
CREATE TRIGGER organization_domains_internal_suffix_guard
BEFORE INSERT OR UPDATE OF hostname, domain_type
ON public.organization_domains
FOR EACH ROW EXECUTE FUNCTION public.enforce_sovie_internal_domain_boundary();

INSERT INTO public.schema_migrations(version, description)
VALUES ('0097', 'Align every platform-managed workspace hostname to sovie.vn')
ON CONFLICT (version) DO UPDATE SET description = EXCLUDED.description;

COMMIT;
