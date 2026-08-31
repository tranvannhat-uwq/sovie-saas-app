BEGIN;

CREATE TABLE public.catalog_units (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[a-z][a-z0-9_]{0,30}$'),
  name text NOT NULL,
  symbol text NOT NULL,
  dimension text NOT NULL DEFAULT 'count'
    CHECK (dimension IN ('count','mass','volume','length','area','time','service','other')),
  decimal_places smallint NOT NULL DEFAULT 2 CHECK (decimal_places BETWEEN 0 AND 6),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, code)
);

CREATE TABLE public.catalog_categories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  parent_id uuid,
  code text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code),
  CONSTRAINT catalog_categories_parent_fkey FOREIGN KEY (organization_id, parent_id)
    REFERENCES public.catalog_categories (organization_id, id) ON DELETE RESTRICT
);

CREATE TABLE public.catalog_attribute_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  value_type text NOT NULL
    CHECK (value_type IN ('text','number','boolean','date','choice','multi_choice')),
  applies_to text NOT NULL DEFAULT 'variant'
    CHECK (applies_to IN ('product','variant','both')),
  is_variant_axis boolean NOT NULL DEFAULT false,
  options jsonb NOT NULL DEFAULT '[]'::jsonb,
  sort_order integer NOT NULL DEFAULT 0,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  UNIQUE (organization_id, code)
);

CREATE TABLE public.catalog_extensions (
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  extension_key text NOT NULL CHECK (extension_key ~ '^[a-z][a-z0-9_]{1,62}$'),
  enabled boolean NOT NULL DEFAULT false,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, extension_key)
);

ALTER TABLE public.product_groups
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT product_groups_organization_id_id_key UNIQUE (organization_id, id);
ALTER TABLE public.products
  ADD COLUMN IF NOT EXISTS item_kind text NOT NULL DEFAULT 'stock'
    CHECK (item_kind IN ('stock','non_stock','service','bundle')),
  ADD COLUMN IF NOT EXISTS sell_unit_code text NOT NULL DEFAULT 'piece',
  ADD COLUMN IF NOT EXISTS purchase_unit_code text NOT NULL DEFAULT 'piece',
  ADD COLUMN IF NOT EXISTS track_inventory boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT products_organization_id_id_key UNIQUE (organization_id, id);

CREATE TABLE public.catalog_product_attribute_values (
  organization_id uuid NOT NULL,
  product_group_id text NOT NULL,
  attribute_id uuid NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, product_group_id, attribute_id),
  FOREIGN KEY (organization_id, product_group_id)
    REFERENCES public.product_groups (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, attribute_id)
    REFERENCES public.catalog_attribute_definitions (organization_id, id) ON DELETE CASCADE
);

CREATE TABLE public.catalog_variant_attribute_values (
  organization_id uuid NOT NULL,
  product_id text NOT NULL,
  attribute_id uuid NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, product_id, attribute_id),
  FOREIGN KEY (organization_id, product_id)
    REFERENCES public.products (organization_id, id) ON DELETE CASCADE,
  FOREIGN KEY (organization_id, attribute_id)
    REFERENCES public.catalog_attribute_definitions (organization_id, id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION public.provision_generic_catalog(p_organization_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.catalog_units (
    organization_id, code, name, symbol, dimension, decimal_places
  )
  SELECT p_organization_id, unit.code, unit.name, unit.symbol,
    unit.dimension, unit.decimal_places
  FROM (VALUES
    ('piece','Cái','cái','count',0), ('box','Hộp','hộp','count',0),
    ('set','Bộ','bộ','count',0), ('kg','Kilôgam','kg','mass',3),
    ('g','Gam','g','mass',2), ('l','Lít','l','volume',3),
    ('ml','Mililít','ml','volume',2), ('m','Mét','m','length',2),
    ('m2','Mét vuông','m²','area',2), ('hour','Giờ','giờ','time',2)
  ) AS unit(code,name,symbol,dimension,decimal_places)
  ON CONFLICT (organization_id, code) DO NOTHING;
END;
$$;

CREATE OR REPLACE FUNCTION public.initialize_generic_catalog()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.provision_generic_catalog(NEW.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER organizations_initialize_generic_catalog
AFTER INSERT ON public.organizations FOR EACH ROW
EXECUTE FUNCTION public.initialize_generic_catalog();

DO $catalog_backfill$
DECLARE organization record;
BEGIN
  FOR organization IN SELECT id FROM public.organizations LOOP
    PERFORM public.provision_generic_catalog(organization.id);
  END LOOP;
END;
$catalog_backfill$;

UPDATE public.products
SET sell_unit_code = CASE lower(btrim(COALESCE(unit_name,'')))
      WHEN 'kg' THEN 'kg' WHEN 'g' THEN 'g' WHEN 'l' THEN 'l'
      WHEN 'ml' THEN 'ml' WHEN 'm' THEN 'm' ELSE 'piece' END,
    purchase_unit_code = CASE lower(btrim(COALESCE(unit_name,'')))
      WHEN 'kg' THEN 'kg' WHEN 'g' THEN 'g' WHEN 'l' THEN 'l'
      WHEN 'ml' THEN 'ml' WHEN 'm' THEN 'm' ELSE 'piece' END;

ALTER TABLE public.products
  ADD CONSTRAINT products_organization_sell_unit_fkey
    FOREIGN KEY (organization_id, sell_unit_code)
    REFERENCES public.catalog_units (organization_id, code) NOT VALID,
  ADD CONSTRAINT products_organization_purchase_unit_fkey
    FOREIGN KEY (organization_id, purchase_unit_code)
    REFERENCES public.catalog_units (organization_id, code) NOT VALID;
ALTER TABLE public.products VALIDATE CONSTRAINT products_organization_sell_unit_fkey;
ALTER TABLE public.products VALIDATE CONSTRAINT products_organization_purchase_unit_fkey;

-- Preserve paint behavior only as an explicit extension of the compatibility
-- organization. New organizations are generic and receive no industry rule.
UPDATE public.organization_settings
SET industry_key = 'paint_distribution', updated_at = now()
WHERE organization_id = '00000000-0000-4000-8000-000000000001'::uuid;
INSERT INTO public.catalog_extensions (organization_id, extension_key, enabled, config)
VALUES (
  '00000000-0000-4000-8000-000000000001'::uuid,
  'paint_color', true,
  '{"input_field":"colorCode","suffix_adjustments":[{"suffix":".","percent":5},{"suffix":"T","percent":15},{"suffix":"D","percent":20},{"suffix":"A","percent":25}]}'::jsonb
)
ON CONFLICT (organization_id, extension_key) DO UPDATE
SET enabled = EXCLUDED.enabled, config = EXCLUDED.config, updated_at = now();

CREATE OR REPLACE FUNCTION public.catalog_extension_adjustment_percent(
  p_extension_key text, p_input jsonb
) RETURNS numeric LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE extension_config jsonb;
DECLARE input_value text;
DECLARE rule jsonb;
BEGIN
  SELECT extension.config INTO extension_config
  FROM public.catalog_extensions extension
  WHERE extension.organization_id = public.current_organization_id()
    AND extension.extension_key = p_extension_key AND extension.enabled;
  IF extension_config IS NULL THEN RETURN 0; END IF;

  input_value := btrim(COALESCE(p_input->>(extension_config->>'input_field'), ''));
  FOR rule IN SELECT value FROM jsonb_array_elements(
    COALESCE(extension_config->'suffix_adjustments', '[]'::jsonb)
  ) LOOP
    IF upper(right(input_value, char_length(rule->>'suffix'))) = upper(rule->>'suffix') THEN
      RETURN GREATEST(0, COALESCE((rule->>'percent')::numeric, 0));
    END IF;
  END LOOP;
  RETURN 0;
END;
$$;
GRANT EXECUTE ON FUNCTION public.catalog_extension_adjustment_percent(text,jsonb)
  TO saas_rpc_executor;

DO $patch_order_extension$
DECLARE definition text;
DECLARE rule_start integer;
DECLARE rule_end_relative integer;
DECLARE replacement constant text :=
  'color_markup_percent := public.catalog_extension_adjustment_percent(''paint_color'', item);';
BEGIN
  SELECT pg_get_functiondef('public.rpc_confirm_order(jsonb)'::regprocedure)
  INTO definition;
  rule_start := strpos(definition, 'color_markup_percent := CASE');
  IF rule_start = 0 THEN
    RAISE EXCEPTION 'Migration 0062 stopped: authoritative adjustment rule shape changed';
  END IF;
  rule_end_relative := strpos(substr(definition, rule_start), 'END;');
  IF rule_end_relative = 0 THEN
    RAISE EXCEPTION 'Migration 0062 stopped: authoritative adjustment rule end was not found';
  END IF;
  definition := overlay(definition PLACING replacement FROM rule_start
    FOR rule_end_relative + char_length('END;') - 1);
  EXECUTE definition;
END;
$patch_order_extension$;

DO $catalog_rls$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'catalog_units','catalog_categories','catalog_attribute_definitions',
    'catalog_extensions','catalog_product_attribute_values',
    'catalog_variant_attribute_values'
  ] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', table_name);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO authenticated', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_read ON public.%I FOR SELECT TO authenticated USING (organization_id = public.current_organization_id())',
      table_name
    );
  END LOOP;
END;
$catalog_rls$;

CREATE OR REPLACE FUNCTION public.rpc_my_catalog_context()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE active_organization_id uuid := public.current_organization_id();
BEGIN
  IF active_organization_id IS NULL THEN
    RAISE EXCEPTION '403: active organization membership required'
      USING ERRCODE = '42501';
  END IF;
  RETURN jsonb_build_object(
    'organizationId', active_organization_id,
    'extensions', COALESCE((SELECT jsonb_object_agg(extension.extension_key,
      jsonb_build_object('enabled',extension.enabled,'config',extension.config))
      FROM public.catalog_extensions extension
      WHERE extension.organization_id = active_organization_id), '{}'::jsonb),
    'units', COALESCE((SELECT jsonb_agg(to_jsonb(unit) ORDER BY unit.name)
      FROM public.catalog_units unit
      WHERE unit.organization_id = active_organization_id AND unit.is_active), '[]'::jsonb),
    'categories', COALESCE((SELECT jsonb_agg(to_jsonb(category) ORDER BY category.sort_order,category.name)
      FROM public.catalog_categories category
      WHERE category.organization_id = active_organization_id AND category.is_active), '[]'::jsonb),
    'attributeDefinitions', COALESCE((SELECT jsonb_agg(to_jsonb(attribute) ORDER BY attribute.sort_order,attribute.name)
      FROM public.catalog_attribute_definitions attribute
      WHERE attribute.organization_id = active_organization_id AND attribute.is_active), '[]'::jsonb)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.provision_generic_catalog(uuid),
  public.initialize_generic_catalog(),
  public.catalog_extension_adjustment_percent(text,jsonb)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_my_catalog_context() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_my_catalog_context() TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0062', 'Add generic catalog metadata and isolate paint pricing as a tenant extension')
ON CONFLICT (version) DO NOTHING;

COMMIT;
