-- SKU + price matrix migration for the current public schema.
-- Prerequisite: take a Supabase backup, then run this whole file once.
-- The migration is idempotent and keeps all legacy product/price columns.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.sku_parse_weight(p_raw text)
RETURNS numeric
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN NULLIF(btrim(p_raw), '') IS NULL THEN NULL
    WHEN regexp_match(lower(p_raw), '([0-9]+(?:[.,][0-9]+)?)') IS NULL THEN NULL
    ELSE replace((regexp_match(lower(p_raw), '([0-9]+(?:[.,][0-9]+)?)'))[1], ',', '.')::numeric
  END
$$;

CREATE OR REPLACE FUNCTION public.sku_parse_weight_unit(p_raw text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN lower(COALESCE(p_raw, '')) ~ '(^|[^a-z])ml([^a-z]|$)' THEN 'ml'
    WHEN lower(COALESCE(p_raw, '')) ~ '(^|[^a-z])kg([^a-z]|$)' THEN 'kg'
    WHEN lower(COALESCE(p_raw, '')) ~ '(^|[^a-z])g([^a-z]|$)' THEN 'g'
    WHEN lower(COALESCE(p_raw, '')) ~ '(^|[^a-z])l([^a-z]|$)' THEN 'l'
    ELSE NULL
  END
$$;

CREATE TABLE IF NOT EXISTS public.sku_price_migration_runs (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'running',
  notes text
);

CREATE TEMP TABLE _sku_migration_context (
  run_id uuid PRIMARY KEY
) ON COMMIT DROP;

INSERT INTO _sku_migration_context(run_id) VALUES (gen_random_uuid());

INSERT INTO public.sku_price_migration_runs(id)
SELECT run_id FROM _sku_migration_context;

CREATE TABLE IF NOT EXISTS public.sku_price_migration_backups (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.sku_price_migration_runs(id),
  source_table text NOT NULL,
  source_key text NOT NULL,
  row_data jsonb NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, source_table, source_key)
);

CREATE TABLE IF NOT EXISTS public.sku_price_migration_issues (
  id bigserial PRIMARY KEY,
  run_id uuid NOT NULL REFERENCES public.sku_price_migration_runs(id),
  issue_type text NOT NULL,
  product_code text,
  brand text,
  package_type text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.sku_price_migration_map (
  base_product_id text NOT NULL,
  base_product_code text NOT NULL,
  brand text NOT NULL,
  package_type text NOT NULL,
  sku_product_id text NOT NULL,
  sku_code text NOT NULL,
  legacy_price numeric,
  raw_weight text,
  existed_before boolean NOT NULL DEFAULT false,
  migrated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(base_product_id, package_type)
);

INSERT INTO public.sku_price_migration_backups(run_id, source_table, source_key, row_data)
SELECT ctx.run_id, 'products', p.code || '::' || p.brand, to_jsonb(p)
FROM public.products p
CROSS JOIN _sku_migration_context ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.sku_price_migration_backups(run_id, source_table, source_key, row_data)
SELECT ctx.run_id, 'pricelists', pl.id, to_jsonb(pl)
FROM public.pricelists pl
CROSS JOIN _sku_migration_context ctx
ON CONFLICT DO NOTHING;

INSERT INTO public.sku_price_migration_backups(run_id, source_table, source_key, row_data)
SELECT ctx.run_id, 'order_items', item.id, to_jsonb(item)
FROM public.order_items item
CROSS JOIN _sku_migration_context ctx
ON CONFLICT DO NOTHING;

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS base_product_id text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS parent_product_id text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS package_type text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS package_weight text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS package_weight_unit text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS display_specification text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS product_group text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_legacy boolean NOT NULL DEFAULT false;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

INSERT INTO public.sku_price_migration_issues(run_id, issue_type, product_code, brand, package_type, details)
SELECT ctx.run_id, 'UNPARSEABLE_EXISTING_SKU_WEIGHT', p.code, p.brand, p.package_type,
       jsonb_build_object('raw_weight', p.package_weight)
FROM public.products p
CROSS JOIN _sku_migration_context ctx
WHERE NULLIF(btrim(p.package_weight::text), '') IS NOT NULL
  AND public.sku_parse_weight(p.package_weight::text) IS NULL;

DO $$
DECLARE
  v_data_type text;
BEGIN
  SELECT data_type INTO v_data_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'products'
    AND column_name = 'package_weight';

  IF v_data_type NOT IN ('numeric', 'decimal') THEN
    ALTER TABLE public.products
      ALTER COLUMN package_weight TYPE numeric
      USING public.sku_parse_weight(package_weight::text);
  END IF;
END $$;

UPDATE public.products
SET id = gen_random_uuid()::text
WHERE id IS NULL OR btrim(id) = '';

WITH duplicate_ids AS (
  SELECT ctid, row_number() OVER (PARTITION BY id ORDER BY created_at NULLS LAST, code, brand) AS duplicate_rank
  FROM public.products
)
UPDATE public.products p
SET id = gen_random_uuid()::text,
    updated_at = now()
FROM duplicate_ids duplicate
WHERE p.ctid = duplicate.ctid
  AND duplicate.duplicate_rank > 1;

ALTER TABLE public.products ALTER COLUMN id SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_id_unique_idx ON public.products(id);
CREATE INDEX IF NOT EXISTS products_base_product_id_idx ON public.products(base_product_id);
CREATE INDEX IF NOT EXISTS products_package_type_idx ON public.products(package_type);
CREATE INDEX IF NOT EXISTS products_active_sku_idx ON public.products(is_active, is_legacy, package_type);

ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS type text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS customer_group_id text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS parent_price_list_id text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS effective_to date;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

INSERT INTO public.pricelists (
  id, code, name, type, customer_id, customer_group_id,
  parent_price_list_id, is_active, display_order, brand_discounts, created_at, updated_at
)
VALUES (
  'pl-standard-default', 'GIA_CHUNG', 'Giá chung', 'standard', NULL, NULL,
  NULL, true, 0, '{}'::jsonb, now(), now()
)
ON CONFLICT (id) DO UPDATE
SET code = EXCLUDED.code,
    name = EXCLUDED.name,
    type = EXCLUDED.type,
    customer_id = NULL,
    customer_group_id = NULL,
    parent_price_list_id = NULL,
    is_active = true,
    display_order = 0,
    updated_at = now();

UPDATE public.pricelists
SET type = CASE
      WHEN id = 'pl-standard-default' THEN 'standard'
      WHEN customer_id IS NOT NULL THEN 'customer_specific'
      ELSE 'customer_group'
    END,
    customer_group_id = CASE
      WHEN id <> 'pl-standard-default' AND customer_id IS NULL
        THEN COALESCE(customer_group_id, 'legacy:' || id)
      ELSE customer_group_id
    END,
    parent_price_list_id = CASE
      WHEN id = 'pl-standard-default' THEN NULL
      ELSE COALESCE(NULLIF(parent_price_list_id, id), 'pl-standard-default')
    END,
    display_order = CASE WHEN id = 'pl-standard-default' THEN 0 ELSE GREATEST(display_order, 10) END,
    updated_at = now();

ALTER TABLE public.pricelists DROP CONSTRAINT IF EXISTS pricelists_type_check;
ALTER TABLE public.pricelists
  ADD CONSTRAINT pricelists_type_check
  CHECK (type IN ('standard', 'customer_group', 'customer_specific'));
ALTER TABLE public.pricelists DROP CONSTRAINT IF EXISTS pricelists_customer_specific_check;
ALTER TABLE public.pricelists
  ADD CONSTRAINT pricelists_customer_specific_check
  CHECK (type <> 'customer_specific' OR customer_id IS NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS pricelists_code_unique_idx
  ON public.pricelists(code) WHERE code IS NOT NULL;
CREATE INDEX IF NOT EXISTS pricelists_customer_idx ON public.pricelists(customer_id);
CREATE INDEX IF NOT EXISTS pricelists_type_active_idx ON public.pricelists(type, is_active, display_order);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'pricelists_parent_fk'
      AND conrelid = 'public.pricelists'::regclass
  ) THEN
    ALTER TABLE public.pricelists
      ADD CONSTRAINT pricelists_parent_fk
      FOREIGN KEY(parent_price_list_id) REFERENCES public.pricelists(id) NOT VALID;
  END IF;
END $$;

ALTER TABLE public.pricelists DROP CONSTRAINT IF EXISTS pricelists_parent_not_self_check;
ALTER TABLE public.pricelists
  ADD CONSTRAINT pricelists_parent_not_self_check
  CHECK (parent_price_list_id IS NULL OR parent_price_list_id <> id);

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS default_price_list_id text;
UPDATE public.customers
SET default_price_list_id = NULLIF(pricelist_id, '')
WHERE default_price_list_id IS NULL
  AND NULLIF(pricelist_id, '') IS NOT NULL
  AND EXISTS (SELECT 1 FROM public.pricelists pl WHERE pl.id = customers.pricelist_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'customers_default_price_list_fk'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_default_price_list_fk
      FOREIGN KEY(default_price_list_id) REFERENCES public.pricelists(id) NOT VALID;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.price_list_items (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  price_list_id text NOT NULL,
  product_id text NOT NULL,
  price numeric NOT NULL,
  is_override boolean NOT NULL DEFAULT true,
  source_type text NOT NULL DEFAULT 'manual',
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.price_list_items ADD COLUMN IF NOT EXISTS is_override boolean NOT NULL DEFAULT true;
ALTER TABLE public.price_list_items ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'manual';
ALTER TABLE public.price_list_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.price_list_items ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

INSERT INTO public.sku_price_migration_backups(run_id, source_table, source_key, row_data)
SELECT ctx.run_id, 'price_list_items', item.id, to_jsonb(item)
FROM public.price_list_items item
CROSS JOIN _sku_migration_context ctx
ON CONFLICT DO NOTHING;

WITH ranked_items AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY price_list_id, product_id
           ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST, id
         ) AS duplicate_rank
  FROM public.price_list_items
)
DELETE FROM public.price_list_items item
USING ranked_items ranked
WHERE item.id = ranked.id
  AND ranked.duplicate_rank > 1;

ALTER TABLE public.price_list_items DROP CONSTRAINT IF EXISTS price_list_items_price_check;
ALTER TABLE public.price_list_items
  ADD CONSTRAINT price_list_items_price_check CHECK (price >= 0);
CREATE UNIQUE INDEX IF NOT EXISTS price_list_items_price_list_product_uidx
  ON public.price_list_items(price_list_id, product_id);
CREATE INDEX IF NOT EXISTS price_list_items_product_idx ON public.price_list_items(product_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'price_list_items_price_list_fk'
      AND conrelid = 'public.price_list_items'::regclass
  ) THEN
    ALTER TABLE public.price_list_items
      ADD CONSTRAINT price_list_items_price_list_fk
      FOREIGN KEY(price_list_id) REFERENCES public.pricelists(id) ON DELETE CASCADE NOT VALID;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'price_list_items_product_fk'
      AND conrelid = 'public.price_list_items'::regclass
  ) THEN
    ALTER TABLE public.price_list_items
      ADD CONSTRAINT price_list_items_product_fk
      FOREIGN KEY(product_id) REFERENCES public.products(id) NOT VALID;
  END IF;
END $$;

CREATE TEMP TABLE _sku_variant_source ON COMMIT DROP AS
SELECT
  p.id AS base_product_id,
  p.code AS base_product_code,
  p.name AS product_name,
  p.brand,
  p.brand_id,
  p.product_group,
  variant.package_type AS variant_package_type,
  variant.package_suffix,
  variant.raw_weight,
  public.sku_parse_weight(variant.raw_weight) AS parsed_weight,
  public.sku_parse_weight_unit(variant.raw_weight) AS parsed_weight_unit,
  variant.legacy_price,
  EXISTS (
    SELECT 1
    FROM public.products existing
    WHERE existing.code = p.code || '-' || variant.package_suffix
      AND existing.brand = p.brand
  ) AS existed_before
FROM public.products p
CROSS JOIN LATERAL (
  VALUES
    ('Thùng'::text, 'THUNG'::text, NULLIF(btrim(p.weight_thung), ''), p.price_thung),
    ('Lon'::text, 'LON'::text, NULLIF(btrim(p.weight_lon), ''), p.price_lon),
    ('Hộp'::text, 'HOP'::text, NULLIF(btrim(p.weight_hop), ''), p.price_hop),
    ('Bao'::text, 'BAO'::text, NULLIF(btrim(p.weight_bao), ''), p.price_bao),
    ('Túi'::text, 'TUI'::text, NULLIF(btrim(p.weight_tui), ''), p.price_tui)
) AS variant(package_type, package_suffix, raw_weight, legacy_price)
WHERE NULLIF(btrim(p.package_type), '') IS NULL
  AND (
    variant.raw_weight IS NOT NULL
    OR COALESCE(variant.legacy_price, 0) > 0
  );

INSERT INTO public.sku_price_migration_issues(run_id, issue_type, product_code, brand, package_type, details)
SELECT ctx.run_id,
       CASE
         WHEN source.raw_weight IS NULL THEN 'SKU_MISSING_WEIGHT'
         WHEN source.parsed_weight IS NULL THEN 'SKU_UNPARSEABLE_WEIGHT'
         WHEN source.parsed_weight_unit IS NULL THEN 'SKU_MISSING_WEIGHT_UNIT'
       END,
       source.base_product_code,
       source.brand,
       source.variant_package_type,
       jsonb_build_object('raw_weight', source.raw_weight, 'legacy_price', source.legacy_price)
FROM _sku_variant_source source
CROSS JOIN _sku_migration_context ctx
WHERE source.raw_weight IS NULL
   OR source.parsed_weight IS NULL
   OR source.parsed_weight_unit IS NULL;

INSERT INTO public.products (
  id, code, name, brand, brand_id, base_product_id, parent_product_id,
  package_type, package_weight, package_weight_unit, display_specification,
  product_group, is_active, is_legacy, created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  source.base_product_code || '-' || source.package_suffix,
  source.product_name,
  source.brand,
  source.brand_id,
  source.base_product_id,
  source.base_product_id,
  source.variant_package_type,
  source.parsed_weight,
  source.parsed_weight_unit,
  CASE
    WHEN source.parsed_weight IS NOT NULL AND source.parsed_weight_unit IS NOT NULL
      THEN source.variant_package_type || ' ' ||
           replace(to_char(source.parsed_weight, 'FM999999990.999'), '.', ',') || ' ' ||
           source.parsed_weight_unit
    ELSE NULL
  END,
  source.product_group,
  true,
  false,
  now(),
  now()
FROM _sku_variant_source source
ON CONFLICT (code, brand) DO UPDATE
SET name = EXCLUDED.name,
    brand_id = COALESCE(EXCLUDED.brand_id, products.brand_id),
    base_product_id = EXCLUDED.base_product_id,
    parent_product_id = EXCLUDED.parent_product_id,
    package_type = EXCLUDED.package_type,
    package_weight = COALESCE(EXCLUDED.package_weight, products.package_weight),
    package_weight_unit = COALESCE(EXCLUDED.package_weight_unit, products.package_weight_unit),
    display_specification = COALESCE(EXCLUDED.display_specification, products.display_specification),
    product_group = COALESCE(EXCLUDED.product_group, products.product_group),
    is_active = true,
    is_legacy = false,
    updated_at = now();

INSERT INTO public.sku_price_migration_map (
  base_product_id, base_product_code, brand, package_type,
  sku_product_id, sku_code, legacy_price, raw_weight, existed_before, migrated_at
)
SELECT
  source.base_product_id,
  source.base_product_code,
  source.brand,
  source.variant_package_type,
  sku.id,
  sku.code,
  source.legacy_price,
  source.raw_weight,
  source.existed_before,
  now()
FROM _sku_variant_source source
JOIN public.products sku
  ON sku.code = source.base_product_code || '-' || source.package_suffix
 AND sku.brand = source.brand
ON CONFLICT (base_product_id, package_type) DO UPDATE
SET sku_product_id = EXCLUDED.sku_product_id,
    sku_code = EXCLUDED.sku_code,
    legacy_price = EXCLUDED.legacy_price,
    raw_weight = EXCLUDED.raw_weight,
    existed_before = sku_price_migration_map.existed_before,
    migrated_at = now();

INSERT INTO public.price_list_items (
  id, price_list_id, product_id, price, is_override, source_type, updated_by, created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  'pl-standard-default',
  map.sku_product_id,
  map.legacy_price,
  true,
  'legacy_product_migration',
  'migration',
  now(),
  now()
FROM public.sku_price_migration_map map
WHERE COALESCE(map.legacy_price, 0) > 0
ON CONFLICT (price_list_id, product_id) DO UPDATE
SET price = EXCLUDED.price,
    source_type = EXCLUDED.source_type,
    updated_by = EXCLUDED.updated_by,
    updated_at = now()
WHERE public.price_list_items.source_type IN ('legacy_product_migration', 'migration')
   OR public.price_list_items.updated_by = 'migration';

-- Remove only rows created by the previous incomplete migration when they merely
-- duplicate the new standard price. The backup table retains their original rows.
DELETE FROM public.price_list_items legacy_copy
USING public.price_list_items standard_item
WHERE legacy_copy.price_list_id = 'pl-general-default'
  AND legacy_copy.updated_by = 'migration'
  AND standard_item.price_list_id = 'pl-standard-default'
  AND standard_item.product_id = legacy_copy.product_id
  AND standard_item.price = legacy_copy.price;

-- Preserve old discount-list behavior without copying rows whose discount is zero.
INSERT INTO public.price_list_items (
  id, price_list_id, product_id, price, is_override, source_type, updated_by, created_at, updated_at
)
SELECT
  gen_random_uuid()::text,
  pl.id,
  map.sku_product_id,
  round(map.legacy_price * (1 - discount.value::numeric / 100)),
  true,
  'legacy_discount_migration',
  'migration',
  now(),
  now()
FROM public.pricelists pl
CROSS JOIN public.sku_price_migration_map map
JOIN LATERAL (
  SELECT brand_discount.value
  FROM jsonb_each_text(COALESCE(pl.brand_discounts, '{}'::jsonb)) brand_discount
  WHERE lower(brand_discount.key) = lower(map.brand)
    AND brand_discount.value ~ '^[0-9]+([.][0-9]+)?$'
    AND brand_discount.value::numeric > 0
    AND brand_discount.value::numeric <= 100
  LIMIT 1
) discount ON true
WHERE pl.id <> 'pl-standard-default'
  AND COALESCE(map.legacy_price, 0) > 0
ON CONFLICT (price_list_id, product_id) DO NOTHING;

-- A legacy base is archived only after every expected SKU has a parsed specification
-- and every positive legacy price exists in the standard price list.
UPDATE public.products base
SET is_legacy = true,
    is_active = false,
    updated_at = now()
WHERE EXISTS (
    SELECT 1 FROM _sku_variant_source source
    WHERE source.base_product_id = base.id
  )
  AND NOT EXISTS (
    SELECT 1 FROM _sku_variant_source source
    WHERE source.base_product_id = base.id
      AND (
        source.parsed_weight IS NULL
        OR source.parsed_weight_unit IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM public.products sku
          WHERE sku.code = source.base_product_code || '-' || source.package_suffix
            AND sku.brand = source.brand
            AND sku.package_type = source.variant_package_type
            AND sku.display_specification IS NOT NULL
        )
        OR (
          COALESCE(source.legacy_price, 0) > 0
          AND NOT EXISTS (
            SELECT 1
            FROM public.sku_price_migration_map map
            JOIN public.price_list_items item
              ON item.product_id = map.sku_product_id
             AND item.price_list_id = 'pl-standard-default'
            WHERE map.base_product_id = source.base_product_id
              AND map.package_type = source.variant_package_type
          )
        )
      )
  );

ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS specification_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_list_id text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_list_name_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS unit_price numeric;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_source text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_selected_by text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS final_unit_price numeric;

UPDATE public.order_items
SET unit_price = COALESCE(unit_price, sale_price, list_price, 0),
    final_unit_price = COALESCE(final_unit_price, sale_price, unit_price, list_price, 0),
    specification_snapshot = COALESCE(specification_snapshot, unit_snapshot),
    price_source = COALESCE(NULLIF(price_source, ''), 'legacy_snapshot')
WHERE unit_price IS NULL
   OR final_unit_price IS NULL
   OR specification_snapshot IS NULL
   OR price_source IS NULL;

CREATE OR REPLACE VIEW public.v_sku_price_migration_checks AS
SELECT 'DUPLICATE_SKU_CODE'::text AS issue_type, p.code AS product_code, p.brand, p.package_type,
       jsonb_build_object('count', count(*)) AS details
FROM public.products p
WHERE p.package_type IS NOT NULL
GROUP BY p.code, p.brand, p.package_type
HAVING count(*) > 1
UNION ALL
SELECT 'SKU_MISSING_SPECIFICATION', p.code, p.brand, p.package_type,
       jsonb_build_object('product_id', p.id)
FROM public.products p
WHERE p.is_legacy = false
  AND p.package_type IS NOT NULL
  AND (p.package_weight IS NULL OR p.package_weight_unit IS NULL OR NULLIF(btrim(p.display_specification), '') IS NULL)
UNION ALL
SELECT 'ACTIVE_LEGACY_PRODUCT', p.code, p.brand, p.package_type,
       jsonb_build_object('product_id', p.id)
FROM public.products p
WHERE p.is_legacy = true AND p.is_active = true
UNION ALL
SELECT 'ACTIVE_SKU_WITHOUT_PRICE', p.code, p.brand, p.package_type,
       jsonb_build_object('product_id', p.id)
FROM public.products p
WHERE p.is_legacy = false
  AND p.is_active = true
  AND p.package_type IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.price_list_items item
    WHERE item.product_id = p.id
  )
UNION ALL
SELECT 'PRICE_ITEM_ORPHAN_PRODUCT', NULL, NULL, NULL,
       jsonb_build_object(
         'price_list_item_id', item.id,
         'price_list_id', item.price_list_id,
         'product_id', item.product_id,
         'price', item.price
       )
FROM public.price_list_items item
WHERE NOT EXISTS (
  SELECT 1 FROM public.products product WHERE product.id = item.product_id
)
UNION ALL
SELECT 'ORDER_REFERENCES_LEGACY_PRODUCT', legacy.code, legacy.brand, legacy.package_type,
       jsonb_build_object('order_item_id', item.id, 'order_id', item.order_id, 'product_id', item.product_id)
FROM public.order_items item
JOIN public.products legacy
  ON legacy.is_legacy = true
 AND (item.product_id = legacy.id OR item.product_id = legacy.code);

CREATE OR REPLACE VIEW public.v_sku_price_migration_summary AS
SELECT
  (SELECT count(*) FROM public.products
   WHERE NULLIF(btrim(package_type), '') IS NULL
     AND (NULLIF(btrim(weight_thung), '') IS NOT NULL OR NULLIF(btrim(weight_lon), '') IS NOT NULL
       OR NULLIF(btrim(weight_hop), '') IS NOT NULL OR NULLIF(btrim(weight_bao), '') IS NOT NULL
       OR NULLIF(btrim(weight_tui), '') IS NOT NULL
       OR price_thung > 0 OR price_lon > 0 OR price_hop > 0 OR price_bao > 0 OR price_tui > 0)
  ) AS legacy_products_with_package_data,
  (SELECT count(*) FROM public.sku_price_migration_map) AS expected_skus,
  (SELECT count(*) FROM public.products WHERE is_legacy = false AND package_type IS NOT NULL) AS actual_skus,
  (SELECT count(*) FROM public.products WHERE is_legacy = false AND package_type IS NOT NULL
     AND (package_weight IS NULL OR package_weight_unit IS NULL OR display_specification IS NULL)) AS skus_missing_specification,
  (SELECT count(*) FROM (
     SELECT code, brand FROM public.products WHERE package_type IS NOT NULL GROUP BY code, brand HAVING count(*) > 1
   ) duplicate_codes) AS duplicate_sku_codes,
  (SELECT count(*) FROM public.sku_price_migration_map WHERE legacy_price > 0) AS legacy_prices,
  (SELECT count(*) FROM public.price_list_items WHERE source_type = 'legacy_product_migration') AS migrated_standard_prices,
  (SELECT count(*) FROM public.sku_price_migration_map map
   WHERE map.legacy_price > 0 AND NOT EXISTS (
     SELECT 1 FROM public.price_list_items item
     WHERE item.product_id = map.sku_product_id AND item.price_list_id = 'pl-standard-default'
   )) AS unmigrated_prices,
  (SELECT count(*) FROM public.products base
   WHERE NULLIF(btrim(base.package_type), '') IS NULL
     AND EXISTS (SELECT 1 FROM public.sku_price_migration_map map WHERE map.base_product_id = base.id)
     AND base.is_legacy = false) AS unmarked_legacy_products,
  (SELECT count(*) FROM public.products sku
   WHERE sku.is_legacy = false AND sku.package_type IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.price_list_items item WHERE item.product_id = sku.id)) AS skus_without_any_price,
  (SELECT count(*) FROM public.products sku
   WHERE sku.is_legacy = false AND sku.package_type IS NOT NULL
     AND NULLIF(btrim(sku.display_specification), '') IS NULL) AS skus_with_na_specification,
  (SELECT count(*) FROM public.order_items item
   JOIN public.products legacy ON legacy.is_legacy = true
    AND (item.product_id = legacy.id OR item.product_id = legacy.code)) AS old_order_items_referencing_legacy;

ALTER TABLE public.price_list_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS select_price_list_items ON public.price_list_items;
DROP POLICY IF EXISTS manage_price_list_items ON public.price_list_items;
CREATE POLICY select_price_list_items ON public.price_list_items
  FOR SELECT TO authenticated USING (true);
CREATE POLICY manage_price_list_items ON public.price_list_items
  FOR ALL TO authenticated USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());
DROP POLICY IF EXISTS local_app_anon_access ON public.price_list_items;
CREATE POLICY local_app_anon_access ON public.price_list_items
  FOR ALL TO anon USING (true) WITH CHECK (true);

UPDATE public.sku_price_migration_runs
SET status = 'completed',
    completed_at = now(),
    notes = 'Review v_sku_price_migration_summary, v_sku_price_migration_checks and sku_price_migration_issues before accepting.'
WHERE id = (SELECT run_id FROM _sku_migration_context);

COMMIT;

-- After commit:
-- SELECT * FROM public.v_sku_price_migration_summary;
-- SELECT * FROM public.v_sku_price_migration_checks ORDER BY issue_type, product_code, brand;
-- SELECT * FROM public.sku_price_migration_issues ORDER BY id;
