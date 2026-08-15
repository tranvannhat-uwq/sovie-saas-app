BEGIN;

-- MOBILE STAGING ONLY
-- Target Supabase project: mqxqswwssmemkimnolfu
-- Removes only the old STG sample namespace, repairs anonymized display names,
-- and normalizes source customer codes that are not actually usable codes.
SELECT set_config('app.mobile_cleanup_environment', 'STAGING_ONLY', true);
SELECT set_config('app.mobile_cleanup_project_ref', 'mqxqswwssmemkimnolfu', true);

DO $guard$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Mobile cleanup refused: run it as the Supabase SQL Editor database owner';
  END IF;

  IF current_setting('app.mobile_cleanup_environment', true) IS DISTINCT FROM 'STAGING_ONLY'
     OR current_setting('app.mobile_cleanup_project_ref', true) IS DISTINCT FROM 'mqxqswwssmemkimnolfu' THEN
    RAISE EXCEPTION 'Mobile cleanup refused: staging target confirmation is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations WHERE version = '0053'
  ) THEN
    RAISE EXCEPTION 'Mobile cleanup refused: migration 0053 has not been applied';
  END IF;
END
$guard$;

CREATE TEMP TABLE mobile_cleanup_result (
  item text PRIMARY KEY,
  affected_rows bigint NOT NULL
) ON COMMIT DROP;

WITH removed AS (
  DELETE FROM public.price_list_items
  WHERE id LIKE 'STG-PRICE-%'
     OR price_list_id = 'STG-PRICELIST-MOBILE'
     OR product_id LIKE 'STG-PRODUCT-%'
     OR variant_id LIKE 'STG-PRODUCT-%'
  RETURNING 1
)
INSERT INTO mobile_cleanup_result VALUES ('sample_price_items_removed', (SELECT count(*) FROM removed));

WITH removed AS (
  DELETE FROM public.customers
  WHERE id LIKE 'STG-CUSTOMER-%'
     OR code LIKE 'STG-KH-%'
  RETURNING 1
)
INSERT INTO mobile_cleanup_result VALUES ('sample_customers_removed', (SELECT count(*) FROM removed));

WITH removed AS (
  DELETE FROM public.products
  WHERE id LIKE 'STG-PRODUCT-%'
     OR code LIKE 'STG-SP-%'
  RETURNING 1
)
INSERT INTO mobile_cleanup_result VALUES ('sample_products_removed', (SELECT count(*) FROM removed));

WITH removed AS (
  DELETE FROM public.pricelists
  WHERE id = 'STG-PRICELIST-MOBILE'
     OR code = 'STG-PL-MOBILE'
  RETURNING 1
)
INSERT INTO mobile_cleanup_result VALUES ('sample_pricelists_removed', (SELECT count(*) FROM removed));

-- The production-to-staging copy deliberately anonymizes every customer.
-- Rebuild the display text inside PostgreSQL so shell encoding cannot corrupt it.
WITH repaired AS (
  UPDATE public.customers
  SET name = 'Khách hàng ' || upper(substr(md5(id), 1, 8)),
      updated_at = now()
  WHERE id NOT LIKE 'STG-%'
  RETURNING 1
)
INSERT INTO mobile_cleanup_result VALUES ('customer_names_repaired', (SELECT count(*) FROM repaired));

-- Keep valid source codes. Replace blank, overly long, spaced or accented values
-- (for example a person's full name stored in the code column).
WITH repaired AS (
  UPDATE public.customers
  SET code = 'KH-ANON-' || upper(substr(md5(id), 1, 12)),
      updated_at = now()
  WHERE id NOT LIKE 'STG-%'
    AND (
      code IS NULL
      OR btrim(code) = ''
      OR length(code) > 32
      OR code !~ '^[A-Za-z0-9._/-]+$'
    )
  RETURNING 1
)
INSERT INTO mobile_cleanup_result VALUES ('customer_codes_repaired', (SELECT count(*) FROM repaired));

WITH repaired AS (
  UPDATE public.orders AS target
  SET customer_name = CASE
        WHEN target.customer_id IS NULL THEN 'Khách lẻ'
        ELSE 'Khách hàng ' || upper(substr(md5(target.customer_id), 1, 8))
      END,
      updated_at = now()
  RETURNING 1
)
INSERT INTO mobile_cleanup_result VALUES ('order_customer_names_repaired', (SELECT count(*) FROM repaired));

INSERT INTO public.audit_logs (
  table_name, action, record_id, new_data, performed_by, created_at
)
VALUES (
  'system',
  'MOBILE_STAGING_SAMPLE_REMOVAL_AND_TEXT_REPAIR',
  to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS'),
  (SELECT jsonb_object_agg(item, affected_rows) FROM mobile_cleanup_result),
  'database-owner:' || current_user,
  now()
);

DO $verify$
BEGIN
  IF EXISTS (SELECT 1 FROM public.customers WHERE id LIKE 'STG-CUSTOMER-%' OR code LIKE 'STG-KH-%')
     OR EXISTS (SELECT 1 FROM public.products WHERE id LIKE 'STG-PRODUCT-%' OR code LIKE 'STG-SP-%')
     OR EXISTS (SELECT 1 FROM public.pricelists WHERE id = 'STG-PRICELIST-MOBILE' OR code = 'STG-PL-MOBILE')
     OR EXISTS (SELECT 1 FROM public.price_list_items WHERE id LIKE 'STG-PRICE-%' OR price_list_id = 'STG-PRICELIST-MOBILE') THEN
    RAISE EXCEPTION 'Mobile cleanup verification failed: sample rows remain';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.customers
    WHERE id NOT LIKE 'STG-%'
      AND (name !~ '^Khách hàng [0-9A-F]{8}$' OR code IS NULL OR btrim(code) = '')
  ) THEN
    RAISE EXCEPTION 'Mobile cleanup verification failed: customer text is not normalized';
  END IF;
END
$verify$;

SELECT item, affected_rows
FROM mobile_cleanup_result
ORDER BY item;

COMMIT;
