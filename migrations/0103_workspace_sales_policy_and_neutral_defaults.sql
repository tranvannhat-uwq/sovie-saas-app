BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0102') THEN
    RAISE EXCEPTION 'Migration 0103 requires migration 0102';
  END IF;
  IF to_regclass('public.organization_modules') IS NULL THEN
    RAISE EXCEPTION 'Migration 0103 requires organization_modules';
  END IF;
END;
$prerequisite$;

-- Retain the legacy paint workspace behavior. Other existing and future
-- workspaces remain unrestricted unless an Owner/Admin opts in explicitly.
UPDATE public.organization_modules
SET config = jsonb_set(COALESCE(config, '{}'::jsonb),
  '{brand_restriction_enabled}',
  CASE WHEN organization_id = '00000000-0000-4000-8000-000000000001'::uuid
    THEN 'true'::jsonb ELSE 'false'::jsonb END,
  true),
  updated_at = now()
WHERE module_key = 'sales'
  AND config->'brand_restriction_enabled' IS NULL;

CREATE OR REPLACE FUNCTION public.rpc_set_sales_brand_restriction(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  updated_config jsonb;
BEGIN
  IF active_organization_id IS NULL
      OR NOT public.has_organization_role(active_organization_id, ARRAY['owner', 'admin']) THEN
    RAISE EXCEPTION '403: workspace owner or admin required'
      USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'Brand restriction setting must be true or false'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.organization_modules
  SET config = jsonb_set(COALESCE(config, '{}'::jsonb),
      '{brand_restriction_enabled}', to_jsonb(p_enabled), true),
      updated_at = now()
  WHERE organization_id = active_organization_id
    AND module_key = 'sales'
  RETURNING config INTO updated_config;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales module configuration was not found for this workspace'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN jsonb_build_object(
    'organizationId', active_organization_id,
    'brandRestrictionEnabled', updated_config->'brand_restriction_enabled'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_set_sales_brand_restriction(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_set_sales_brand_restriction(boolean) TO authenticated;

-- Clear defaults inherited from the original paint-company starter schema.
-- The application supplies tenant context explicitly and products may have
-- no brand in industries where that field does not apply.
ALTER TABLE public.products ALTER COLUMN brand DROP DEFAULT;
ALTER TABLE public.profiles ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE public.orders ALTER COLUMN company_id DROP DEFAULT;
ALTER TABLE public.draft_orders ALTER COLUMN company_id DROP DEFAULT;

CREATE OR REPLACE FUNCTION public.normalize_order_company_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  legacy_organization_id constant uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
  IF NEW.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id <> legacy_organization_id
      AND (NULLIF(btrim(NEW.company_id), '') IS NULL
        OR upper(btrim(NEW.company_id)) IN ('MAIN', 'ABS_NORTH', 'ABS_SOUTH', 'EMP_USA')) THEN
    NEW.company_id := NEW.organization_id::text;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.normalize_order_company_scope() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a1_normalize_order_company_scope ON public.orders;
CREATE TRIGGER a1_normalize_order_company_scope
BEFORE INSERT OR UPDATE OF organization_id, company_id ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.normalize_order_company_scope();

DROP TRIGGER IF EXISTS a1_normalize_draft_company_scope ON public.draft_orders;
CREATE TRIGGER a1_normalize_draft_company_scope
BEFORE INSERT OR UPDATE OF organization_id, company_id ON public.draft_orders
FOR EACH ROW EXECUTE FUNCTION public.normalize_order_company_scope();

INSERT INTO public.schema_migrations(version, description)
VALUES ('0103', 'Add workspace-specific sales brand policy and remove paint-company defaults')
ON CONFLICT (version) DO NOTHING;

COMMIT;
