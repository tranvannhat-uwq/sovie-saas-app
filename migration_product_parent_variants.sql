-- Product parent + packaging variants.
-- Run after migration_sku_price_matrix.sql and migration_order_price_snapshots.sql.
-- Existing product IDs remain variant IDs, so prices and historical orders are preserved.

BEGIN;

CREATE OR REPLACE FUNCTION public.infer_product_base_code(p_code text)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT COALESCE(
    NULLIF(
      regexp_replace(
        btrim(COALESCE(p_code, '')),
        '[-_[:space:]]+(LON|THUNG|THÙNG|HOP|HỘP|BAO|TUI|TÚI|CHAI|GOI|GÓI|KG|LIT|LÍT)$',
        '',
        'i'
      ),
      ''
    ),
    btrim(COALESCE(p_code, ''))
  );
$$;

CREATE TABLE IF NOT EXISTS public.product_groups (
  id text PRIMARY KEY,
  base_code text NOT NULL,
  product_name text NOT NULL,
  brand_id text,
  brand_name text NOT NULL DEFAULT '',
  category_id text,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS product_groups_identity_uidx
  ON public.product_groups(lower(base_code), lower(product_name), lower(brand_name));
CREATE INDEX IF NOT EXISTS product_groups_brand_idx
  ON public.product_groups(brand_id, is_active);

ALTER TABLE public.products ADD COLUMN IF NOT EXISTS product_group_id text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS base_code text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS variant_code text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS packaging_name text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS unit_name text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS weight_or_volume numeric;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS conversion_quantity numeric NOT NULL DEFAULT 1;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS barcode text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS purchase_price numeric NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.product_variant_migration_issues (
  id bigserial PRIMARY KEY,
  issue_type text NOT NULL,
  product_id text,
  product_code text,
  inferred_base_code text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  reviewed_at timestamptz,
  reviewed_by text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS product_variant_migration_issue_uidx
  ON public.product_variant_migration_issues(
    issue_type,
    COALESCE(product_id, ''),
    COALESCE(inferred_base_code, '')
  );

UPDATE public.products variant
SET base_code = COALESCE(
      NULLIF(btrim(variant.base_code), ''),
      NULLIF(btrim(parent.base_code), ''),
      NULLIF(btrim(parent.code), ''),
      public.infer_product_base_code(variant.code)
    ),
    variant_code = COALESCE(NULLIF(btrim(variant.variant_code), ''), variant.code),
    packaging_name = COALESCE(NULLIF(btrim(variant.packaging_name), ''), variant.package_type),
    unit_name = COALESCE(NULLIF(btrim(variant.unit_name), ''), variant.package_weight_unit),
    weight_or_volume = COALESCE(variant.weight_or_volume, variant.package_weight),
    updated_at = now()
FROM public.products parent
WHERE parent.id = COALESCE(variant.base_product_id, variant.parent_product_id)
  AND variant.package_type IS NOT NULL;

UPDATE public.products variant
SET base_code = COALESCE(NULLIF(btrim(variant.base_code), ''), public.infer_product_base_code(variant.code)),
    variant_code = COALESCE(NULLIF(btrim(variant.variant_code), ''), variant.code),
    packaging_name = COALESCE(NULLIF(btrim(variant.packaging_name), ''), variant.package_type),
    unit_name = COALESCE(NULLIF(btrim(variant.unit_name), ''), variant.package_weight_unit),
    weight_or_volume = COALESCE(variant.weight_or_volume, variant.package_weight),
    updated_at = now()
WHERE variant.package_type IS NOT NULL;

INSERT INTO public.product_variant_migration_issues (
  issue_type, product_id, product_code, inferred_base_code, details
)
SELECT
  'AMBIGUOUS_BASE_CODE',
  min(product.id),
  min(product.code),
  product.base_code,
  jsonb_build_object(
    'brand', min(COALESCE(product.brand, '')),
    'names', jsonb_agg(DISTINCT product.name),
    'product_ids', jsonb_agg(DISTINCT product.id)
  )
FROM public.products product
WHERE product.package_type IS NOT NULL
  AND product.is_legacy = false
  AND NULLIF(btrim(product.base_code), '') IS NOT NULL
GROUP BY lower(product.base_code), lower(COALESCE(product.brand, '')), product.base_code
HAVING count(DISTINCT lower(product.name)) > 1
ON CONFLICT DO NOTHING;

INSERT INTO public.product_variant_migration_issues (
  issue_type, product_id, product_code, inferred_base_code, details
)
SELECT
  'MISSING_PACKAGING_DETAILS',
  product.id,
  product.code,
  product.base_code,
  jsonb_build_object(
    'package_type', product.package_type,
    'package_weight', product.package_weight,
    'package_weight_unit', product.package_weight_unit
  )
FROM public.products product
WHERE product.package_type IS NOT NULL
  AND product.is_legacy = false
  AND (
    NULLIF(btrim(product.package_type), '') IS NULL
    OR product.package_weight IS NULL
    OR NULLIF(btrim(product.package_weight_unit), '') IS NULL
  )
ON CONFLICT DO NOTHING;

WITH safe_variants AS (
  SELECT
    product.*,
    'pg-' || md5(
      lower(btrim(product.base_code)) || '|' ||
      lower(btrim(product.name)) || '|' ||
      lower(btrim(COALESCE(product.brand, '')))
    ) AS generated_group_id
  FROM public.products product
  WHERE product.package_type IS NOT NULL
    AND product.is_legacy = false
    AND NULLIF(btrim(product.base_code), '') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.product_variant_migration_issues issue
      WHERE issue.issue_type = 'AMBIGUOUS_BASE_CODE'
        AND lower(issue.inferred_base_code) = lower(product.base_code)
        AND lower(COALESCE(issue.details->>'brand', '')) = lower(COALESCE(product.brand, ''))
    )
),
group_rows AS (
  SELECT
    COALESCE(min(NULLIF(product_group_id, '')), min(generated_group_id)) AS id,
    base_code,
    name AS product_name,
    min(brand_id) AS brand_id,
    COALESCE(brand, '') AS brand_name,
    bool_or(is_active) AS is_active
  FROM safe_variants
  GROUP BY lower(base_code), base_code, lower(name), name, lower(COALESCE(brand, '')), COALESCE(brand, '')
)
INSERT INTO public.product_groups (
  id, base_code, product_name, brand_id, brand_name, is_active, updated_at
)
SELECT id, base_code, product_name, brand_id, brand_name, is_active, now()
FROM group_rows
ON CONFLICT (id) DO UPDATE
SET base_code = EXCLUDED.base_code,
    product_name = EXCLUDED.product_name,
    brand_id = COALESCE(EXCLUDED.brand_id, public.product_groups.brand_id),
    brand_name = EXCLUDED.brand_name,
    is_active = EXCLUDED.is_active,
    updated_at = now();

UPDATE public.products product
SET product_group_id = matched.id,
    updated_at = now()
FROM public.product_groups matched
WHERE product.package_type IS NOT NULL
  AND product.is_legacy = false
  AND lower(matched.base_code) = lower(product.base_code)
  AND lower(matched.product_name) = lower(product.name)
  AND lower(matched.brand_name) = lower(COALESCE(product.brand, ''))
  AND product.product_group_id IS NULL;

CREATE INDEX IF NOT EXISTS products_product_group_idx
  ON public.products(product_group_id, is_active);
CREATE INDEX IF NOT EXISTS products_base_code_idx
  ON public.products(lower(base_code));
CREATE INDEX IF NOT EXISTS products_variant_code_brand_idx
  ON public.products(lower(variant_code), lower(COALESCE(brand, '')))
  WHERE variant_code IS NOT NULL AND is_legacy = false;

ALTER TABLE public.price_list_items ADD COLUMN IF NOT EXISTS variant_id text;
UPDATE public.price_list_items
SET variant_id = product_id
WHERE variant_id IS NULL;
CREATE INDEX IF NOT EXISTS price_list_items_variant_idx
  ON public.price_list_items(variant_id);
CREATE UNIQUE INDEX IF NOT EXISTS price_list_items_price_list_variant_uidx
  ON public.price_list_items(price_list_id, variant_id)
  WHERE variant_id IS NOT NULL;

ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS product_group_id text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS variant_id text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS variant_code_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS packaging_name_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS weight_or_volume_snapshot text;

ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS variant_id text;
ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS variant_code_snapshot text;
ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS packaging_name_snapshot text;
ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS specification_snapshot text;
CREATE INDEX IF NOT EXISTS sales_return_items_variant_idx
  ON public.sales_return_items(variant_id);

INSERT INTO public.product_variant_migration_issues (
  issue_type, product_id, product_code, inferred_base_code, details
)
SELECT
  'AMBIGUOUS_RETURN_VARIANT',
  return_item.id,
  return_item.product_id,
  NULL,
  jsonb_build_object(
    'sales_return_item_id', return_item.id,
    'candidate_variant_ids', jsonb_agg(product.id)
  )
FROM public.sales_return_items return_item
JOIN public.products product ON product.code = return_item.product_id
WHERE NOT EXISTS (
    SELECT 1 FROM public.products exact_product
    WHERE exact_product.id = return_item.product_id
  )
GROUP BY return_item.id, return_item.product_id
HAVING count(*) > 1
ON CONFLICT DO NOTHING;

UPDATE public.sales_return_items return_item
SET variant_id = COALESCE(
      return_item.variant_id,
      (
        SELECT product.id
        FROM public.products product
        WHERE product.id = return_item.product_id
           OR (
             product.code = return_item.product_id
             AND (
               SELECT count(*)
               FROM public.products candidate
               WHERE candidate.code = return_item.product_id
             ) = 1
           )
        ORDER BY CASE WHEN product.id = return_item.product_id THEN 0 ELSE 1 END
        LIMIT 1
      )
    ),
    variant_code_snapshot = COALESCE(
      NULLIF(return_item.variant_code_snapshot, ''),
      (
        SELECT COALESCE(product.variant_code, product.code)
        FROM public.products product
        WHERE product.id = return_item.product_id
           OR (
             product.code = return_item.product_id
             AND (
               SELECT count(*)
               FROM public.products candidate
               WHERE candidate.code = return_item.product_id
             ) = 1
           )
        ORDER BY CASE WHEN product.id = return_item.product_id THEN 0 ELSE 1 END
        LIMIT 1
      ),
      return_item.product_id
    ),
    packaging_name_snapshot = COALESCE(
      NULLIF(return_item.packaging_name_snapshot, ''),
      (
        SELECT COALESCE(product.packaging_name, product.package_type)
        FROM public.products product
        WHERE product.id = return_item.product_id
           OR (
             product.code = return_item.product_id
             AND (
               SELECT count(*)
               FROM public.products candidate
               WHERE candidate.code = return_item.product_id
             ) = 1
           )
        ORDER BY CASE WHEN product.id = return_item.product_id THEN 0 ELSE 1 END
        LIMIT 1
      ),
      return_item.package_type
    ),
    specification_snapshot = COALESCE(
      NULLIF(return_item.specification_snapshot, ''),
      (
        SELECT product.display_specification
        FROM public.products product
        WHERE product.id = return_item.product_id
           OR (
             product.code = return_item.product_id
             AND (
               SELECT count(*)
               FROM public.products candidate
               WHERE candidate.code = return_item.product_id
             ) = 1
           )
        ORDER BY CASE WHEN product.id = return_item.product_id THEN 0 ELSE 1 END
        LIMIT 1
      )
    )
WHERE return_item.variant_id IS NULL
   OR return_item.variant_code_snapshot IS NULL
   OR return_item.packaging_name_snapshot IS NULL
   OR return_item.specification_snapshot IS NULL;

CREATE OR REPLACE FUNCTION public.fill_order_item_variant_snapshots()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  variant public.products%ROWTYPE;
BEGIN
  NEW.variant_id := COALESCE(NULLIF(NEW.variant_id, ''), NULLIF(NEW.product_id, ''));
  NEW.product_id := COALESCE(NULLIF(NEW.product_id, ''), NULLIF(NEW.variant_id, ''));

  SELECT *
  INTO variant
  FROM public.products
  WHERE id = NEW.variant_id
  LIMIT 1;

  IF FOUND THEN
    NEW.product_group_id := COALESCE(NULLIF(NEW.product_group_id, ''), variant.product_group_id);
    NEW.variant_code_snapshot := COALESCE(
      NULLIF(NEW.variant_code_snapshot, ''),
      NULLIF(NEW.product_code_snapshot, ''),
      variant.variant_code,
      variant.code
    );
    NEW.product_code_snapshot := COALESCE(NULLIF(NEW.product_code_snapshot, ''), variant.variant_code, variant.code);
    NEW.product_name_snapshot := COALESCE(NULLIF(NEW.product_name_snapshot, ''), variant.name);
    NEW.packaging_name_snapshot := COALESCE(
      NULLIF(NEW.packaging_name_snapshot, ''),
      variant.packaging_name,
      variant.package_type
    );
    NEW.weight_or_volume_snapshot := COALESCE(
      NULLIF(NEW.weight_or_volume_snapshot, ''),
      NULLIF(concat_ws(' ', variant.weight_or_volume, variant.unit_name), ''),
      NULLIF(variant.display_specification, '')
    );
    NEW.unit_snapshot := COALESCE(NULLIF(NEW.unit_snapshot, ''), variant.unit_name, variant.package_weight_unit);
    NEW.specification_snapshot := COALESCE(
      NULLIF(NEW.specification_snapshot, ''),
      NULLIF(variant.display_specification, ''),
      concat_ws(' ', variant.packaging_name, variant.weight_or_volume, variant.unit_name)
    );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_order_items_fill_variant_snapshots ON public.order_items;
CREATE TRIGGER trg_order_items_fill_variant_snapshots
  BEFORE INSERT OR UPDATE OF product_id, variant_id, product_code_snapshot,
    specification_snapshot, unit_snapshot
  ON public.order_items
  FOR EACH ROW
  EXECUTE FUNCTION public.fill_order_item_variant_snapshots();

UPDATE public.order_items item
SET variant_id = COALESCE(item.variant_id, item.product_id),
    product_group_id = COALESCE(item.product_group_id, product.product_group_id),
    variant_code_snapshot = COALESCE(item.variant_code_snapshot, item.product_code_snapshot, product.variant_code, product.code),
    packaging_name_snapshot = COALESCE(item.packaging_name_snapshot, product.packaging_name, product.package_type),
    weight_or_volume_snapshot = COALESCE(
      item.weight_or_volume_snapshot,
      NULLIF(concat_ws(' ', product.weight_or_volume, product.unit_name), ''),
      item.specification_snapshot,
      product.display_specification
    )
FROM public.products product
WHERE product.id = COALESCE(item.variant_id, item.product_id);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'products_product_group_fk'
      AND conrelid = 'public.products'::regclass
  ) THEN
    ALTER TABLE public.products
      ADD CONSTRAINT products_product_group_fk
      FOREIGN KEY(product_group_id) REFERENCES public.product_groups(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'price_list_items_variant_fk'
      AND conrelid = 'public.price_list_items'::regclass
  ) THEN
    ALTER TABLE public.price_list_items
      ADD CONSTRAINT price_list_items_variant_fk
      FOREIGN KEY(variant_id) REFERENCES public.products(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_items_variant_fk'
      AND conrelid = 'public.order_items'::regclass
  ) THEN
    ALTER TABLE public.order_items
      ADD CONSTRAINT order_items_variant_fk
      FOREIGN KEY(variant_id) REFERENCES public.products(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'order_items_product_group_fk'
      AND conrelid = 'public.order_items'::regclass
  ) THEN
    ALTER TABLE public.order_items
      ADD CONSTRAINT order_items_product_group_fk
      FOREIGN KEY(product_group_id) REFERENCES public.product_groups(id) NOT VALID;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'sales_return_items_variant_fk'
      AND conrelid = 'public.sales_return_items'::regclass
  ) THEN
    ALTER TABLE public.sales_return_items
      ADD CONSTRAINT sales_return_items_variant_fk
      FOREIGN KEY(variant_id) REFERENCES public.products(id) NOT VALID;
  END IF;
END $$;

CREATE OR REPLACE VIEW public.v_product_parent_variants AS
SELECT
  parent.id AS product_id,
  parent.base_code,
  parent.product_name,
  parent.brand_id,
  parent.brand_name,
  parent.category_id,
  parent.description,
  parent.is_active,
  variant.id AS variant_id,
  COALESCE(variant.variant_code, variant.code) AS variant_code,
  COALESCE(variant.packaging_name, variant.package_type) AS packaging_name,
  COALESCE(variant.weight_or_volume, variant.package_weight) AS weight_or_volume,
  COALESCE(variant.unit_name, variant.package_weight_unit) AS unit_name,
  variant.display_specification,
  variant.barcode,
  variant.purchase_price,
  variant.conversion_quantity,
  variant.is_active AS variant_is_active
FROM public.product_groups parent
JOIN public.products variant ON variant.product_group_id = parent.id;

CREATE OR REPLACE VIEW public.v_variant_prices AS
SELECT
  item.id,
  item.price_list_id,
  COALESCE(item.variant_id, item.product_id) AS variant_id,
  item.price,
  item.is_override,
  item.source_type,
  item.updated_at,
  item.updated_by
FROM public.price_list_items item;

ALTER TABLE public.product_groups ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS select_product_groups ON public.product_groups;
DROP POLICY IF EXISTS manage_product_groups ON public.product_groups;
DROP POLICY IF EXISTS local_app_anon_access ON public.product_groups;
CREATE POLICY select_product_groups ON public.product_groups
  FOR SELECT TO authenticated
  USING (true);
CREATE POLICY manage_product_groups ON public.product_groups
  FOR ALL TO authenticated
  USING (public.is_admin_or_accounting())
  WITH CHECK (public.is_admin_or_accounting());
CREATE POLICY local_app_anon_access ON public.product_groups
  FOR ALL TO anon
  USING (true)
  WITH CHECK (true);

COMMIT;
