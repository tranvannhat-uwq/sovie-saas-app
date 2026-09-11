-- Roll back migration-created SKU/price data without touching settled order_items.
-- Review the SELECT statements at the bottom before running this file.

BEGIN;

CREATE TEMP TABLE _rollback_context ON COMMIT DROP AS
SELECT id AS run_id
FROM public.sku_price_migration_runs
WHERE status = 'completed'
ORDER BY completed_at DESC NULLS LAST
LIMIT 1;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM _rollback_context) THEN
    RAISE EXCEPTION 'Không tìm thấy migration run đã hoàn tất để rollback';
  END IF;
END $$;

DELETE FROM public.price_list_items
WHERE source_type IN ('legacy_product_migration', 'legacy_discount_migration', 'migration')
  AND updated_by = 'migration';

UPDATE public.products product
SET is_active = COALESCE((backup.row_data->>'is_active')::boolean, true),
    is_legacy = COALESCE((backup.row_data->>'is_legacy')::boolean, false),
    base_product_id = NULLIF(backup.row_data->>'base_product_id', ''),
    parent_product_id = NULLIF(backup.row_data->>'parent_product_id', ''),
    package_type = NULLIF(backup.row_data->>'package_type', ''),
    package_weight = public.sku_parse_weight(backup.row_data->>'package_weight'),
    package_weight_unit = NULLIF(backup.row_data->>'package_weight_unit', ''),
    display_specification = NULLIF(backup.row_data->>'display_specification', ''),
    updated_at = now()
FROM public.sku_price_migration_backups backup
JOIN _rollback_context context ON context.run_id = backup.run_id
WHERE backup.source_table = 'products'
  AND backup.source_key = product.code || '::' || product.brand;

-- Never delete an SKU referenced by an order. Those rows remain inactive for review.
UPDATE public.products sku
SET is_active = false,
    updated_at = now()
FROM public.sku_price_migration_map map
WHERE map.existed_before = false
  AND sku.id = map.sku_product_id
  AND EXISTS (
    SELECT 1 FROM public.order_items item
    WHERE item.product_id = sku.id
  );

DELETE FROM public.products sku
USING public.sku_price_migration_map map
WHERE map.existed_before = false
  AND sku.id = map.sku_product_id
  AND NOT EXISTS (
    SELECT 1 FROM public.order_items item
    WHERE item.product_id = sku.id
  );

ALTER TABLE public.pricelists DROP CONSTRAINT IF EXISTS pricelists_type_check;
ALTER TABLE public.pricelists DROP CONSTRAINT IF EXISTS pricelists_customer_specific_check;

UPDATE public.pricelists price_list
SET code = NULLIF(backup.row_data->>'code', ''),
    name = COALESCE(NULLIF(backup.row_data->>'name', ''), price_list.name),
    type = NULLIF(backup.row_data->>'type', ''),
    customer_id = NULLIF(backup.row_data->>'customer_id', ''),
    customer_group_id = NULLIF(backup.row_data->>'customer_group_id', ''),
    parent_price_list_id = NULLIF(backup.row_data->>'parent_price_list_id', ''),
    effective_from = NULLIF(backup.row_data->>'effective_from', '')::date,
    effective_to = NULLIF(backup.row_data->>'effective_to', '')::date,
    is_active = COALESCE((backup.row_data->>'is_active')::boolean, true),
    display_order = COALESCE((backup.row_data->>'display_order')::integer, 0),
    brand_discounts = COALESCE(backup.row_data->'brand_discounts', '{}'::jsonb),
    updated_at = now()
FROM public.sku_price_migration_backups backup
JOIN _rollback_context context ON context.run_id = backup.run_id
WHERE backup.source_table = 'pricelists'
  AND backup.source_key = price_list.id;

UPDATE public.pricelists
SET is_active = false,
    updated_at = now()
WHERE id = 'pl-standard-default'
  AND NOT EXISTS (
    SELECT 1 FROM public.sku_price_migration_backups backup
    JOIN _rollback_context context ON context.run_id = backup.run_id
    WHERE backup.source_table = 'pricelists'
      AND backup.source_key = 'pl-standard-default'
  );

UPDATE public.sku_price_migration_runs
SET status = 'rolled_back',
    notes = COALESCE(notes, '') || ' Rolled back without changing settled order_items.'
WHERE id = (SELECT run_id FROM _rollback_context);

COMMIT;

-- Rows left here were retained because an order references them:
-- SELECT sku.id, sku.code, sku.brand
-- FROM public.products sku
-- JOIN public.sku_price_migration_map map ON map.sku_product_id = sku.id
-- WHERE map.existed_before = false AND sku.is_active = false;
