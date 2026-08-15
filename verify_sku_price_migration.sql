-- Read-only verification. Run after both migrations.

SELECT * FROM public.v_sku_price_migration_summary;

SELECT *
FROM public.v_sku_price_migration_checks
ORDER BY issue_type, product_code, brand, package_type;

SELECT issue_type, product_code, brand, package_type, details
FROM public.sku_price_migration_issues
ORDER BY id;

-- Required case A: B-H2 must have only the Lon SKU with a real specification and price.
SELECT
  sku.id,
  sku.code,
  sku.name,
  sku.brand,
  sku.base_product_id,
  sku.package_type,
  sku.package_weight,
  sku.package_weight_unit,
  sku.display_specification,
  sku.is_active,
  item.price AS standard_price
FROM public.products sku
LEFT JOIN public.price_list_items item
  ON item.product_id = sku.id
 AND item.price_list_id = 'pl-standard-default'
WHERE sku.code IN ('B-H2', 'B-H2-LON')
ORDER BY sku.code, sku.brand;

-- Required case B: BA-46 must have THUNG/LON/HOP with exact specifications and prices.
SELECT
  sku.id,
  sku.code,
  sku.package_type,
  sku.package_weight,
  sku.package_weight_unit,
  sku.display_specification,
  item.price AS standard_price
FROM public.products sku
LEFT JOIN public.price_list_items item
  ON item.product_id = sku.id
 AND item.price_list_id = 'pl-standard-default'
WHERE sku.code IN ('BA-46', 'BA-46-THUNG', 'BA-46-LON', 'BA-46-HOP')
ORDER BY sku.code, sku.brand;

-- Customer-specific lists must have a customer and the correct canonical type.
SELECT
  price_list.id,
  price_list.code,
  price_list.name,
  price_list.type,
  price_list.customer_id,
  customer.code AS customer_code,
  customer.name AS customer_name,
  price_list.is_active
FROM public.pricelists price_list
LEFT JOIN public.customers customer ON customer.id = price_list.customer_id
WHERE price_list.type = 'customer_specific'
ORDER BY price_list.display_order, price_list.name;

-- Direct vs inherited example for BA-46-LON across active lists.
SELECT
  price_list.id AS price_list_id,
  price_list.name AS price_list_name,
  direct_item.price AS direct_price,
  parent_item.price AS parent_price,
  standard_item.price AS standard_price,
  COALESCE(direct_item.price, parent_item.price, standard_item.price) AS effective_price,
  CASE
    WHEN direct_item.id IS NOT NULL THEN 'direct'
    WHEN parent_item.id IS NOT NULL OR standard_item.id IS NOT NULL THEN 'inherited'
    ELSE 'missing'
  END AS price_status
FROM public.pricelists price_list
CROSS JOIN public.products sku
LEFT JOIN public.price_list_items direct_item
  ON direct_item.price_list_id = price_list.id
 AND direct_item.product_id = sku.id
LEFT JOIN public.price_list_items parent_item
  ON parent_item.price_list_id = price_list.parent_price_list_id
 AND parent_item.product_id = sku.id
LEFT JOIN public.price_list_items standard_item
  ON standard_item.price_list_id = 'pl-standard-default'
 AND standard_item.product_id = sku.id
WHERE sku.code = 'BA-46-LON'
  AND price_list.is_active = true
ORDER BY price_list.display_order, price_list.name;

-- Settled order snapshots: product_id is untouched; new orders must have immutable fields.
SELECT
  item.order_id,
  item.product_id,
  item.product_code_snapshot,
  item.product_name_snapshot,
  item.specification_snapshot,
  item.price_list_id,
  item.price_list_name_snapshot,
  item.unit_price,
  item.price_source,
  item.final_unit_price
FROM public.order_items item
ORDER BY item.created_at DESC
LIMIT 100;
