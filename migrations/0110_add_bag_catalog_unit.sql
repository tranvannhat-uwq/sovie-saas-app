BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations WHERE version = '0109'
  ) THEN
    RAISE EXCEPTION 'Migration 0110 requires migration 0109';
  END IF;
END;
$prerequisite$;

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
    ('m2','Mét vuông','m²','area',2), ('hour','Giờ','giờ','time',2),
    ('bag','Bao','bao','count',0)
  ) AS unit(code,name,symbol,dimension,decimal_places)
  ON CONFLICT (organization_id, code) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.provision_generic_catalog(uuid)
  FROM PUBLIC, anon, authenticated;

-- Backfill existing organizations with bag unit
INSERT INTO public.catalog_units (
  organization_id, code, name, symbol, dimension, decimal_places
)
SELECT id, 'bag', 'Bao', 'bao', 'count', 0
FROM public.organizations
ON CONFLICT (organization_id, code) DO NOTHING;

UPDATE public.products
SET sell_unit_code = 'bag',
    purchase_unit_code = 'bag'
WHERE lower(btrim(COALESCE(unit_name, ''))) = 'bao'
   OR lower(btrim(COALESCE(package_weight_unit, ''))) = 'bao';

INSERT INTO public.schema_migrations(version, description)
VALUES ('0110', 'Add bag catalog unit')
ON CONFLICT (version) DO NOTHING;

COMMIT;
