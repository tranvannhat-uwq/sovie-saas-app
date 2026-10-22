BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0094') THEN
    RAISE EXCEPTION 'Migration 0102 requires migration 0094';
  END IF;
  IF to_regclass('public.organization_modules') IS NULL THEN
    RAISE EXCEPTION 'Migration 0102 requires organization_modules';
  END IF;
END;
$prerequisite$;

CREATE OR REPLACE FUNCTION public.validate_customer_order_brand_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  legacy_organization_id constant uuid := '00000000-0000-4000-8000-000000000001';
  assigned_brand_id text;
  assigned_brand_name text;
  canonical_brand_name text;
  brand_restriction_enabled boolean;
  item jsonb;
  item_product_id text;
  item_type text;
  item_is_service boolean;
  product_brand_id text;
  product_brand_name text;
  product_found boolean;
  brand_matches boolean;
BEGIN
  IF TG_OP = 'UPDATE'
      AND NEW.items IS NOT DISTINCT FROM OLD.items
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'Order must belong to a workspace'
      USING ERRCODE = '23502';
  END IF;
  IF jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Order items must be a JSON array'
      USING ERRCODE = '22023';
  END IF;

  SELECT module.config->'brand_restriction_enabled' = 'true'::jsonb
    INTO brand_restriction_enabled
  FROM public.organization_modules module
  WHERE module.organization_id = NEW.organization_id
    AND module.module_key = 'sales';
  brand_restriction_enabled := COALESCE(brand_restriction_enabled, false);

  IF NULLIF(btrim(NEW.customer_id), '') IS NOT NULL THEN
    SELECT customer.assigned_brand_id, customer.assigned_brand
      INTO assigned_brand_id, assigned_brand_name
    FROM public.customers customer
    WHERE customer.id = NEW.customer_id
      AND customer.organization_id = NEW.organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer "%" is not available in this workspace', NEW.customer_id
        USING ERRCODE = '23503';
    END IF;

    IF NULLIF(btrim(assigned_brand_id), '') IS NOT NULL THEN
      SELECT brand.name INTO canonical_brand_name
      FROM public.brands brand
      WHERE brand.id = assigned_brand_id
        AND brand.organization_id = NEW.organization_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Customer assigned brand is not available in this workspace'
          USING ERRCODE = '23503';
      END IF;
    ELSIF NEW.organization_id = legacy_organization_id
        AND NULLIF(btrim(assigned_brand_name), '') IS NOT NULL
        AND lower(btrim(assigned_brand_name)) NOT IN ('all', 'tất cả') THEN
      canonical_brand_name := btrim(assigned_brand_name);
      SELECT brand.id, brand.name
        INTO assigned_brand_id, canonical_brand_name
      FROM public.brands brand
      WHERE brand.organization_id = NEW.organization_id
        AND lower(btrim(brand.name)) = lower(btrim(assigned_brand_name))
      ORDER BY brand.id
      LIMIT 1;
      IF NOT FOUND THEN
        canonical_brand_name := btrim(assigned_brand_name);
      END IF;
    END IF;

    IF assigned_brand_id IS NULL AND (assigned_brand_name IS NULL
        OR lower(btrim(assigned_brand_name)) IN ('all', 'tất cả')) THEN
      assigned_brand_id := NULL;
      canonical_brand_name := NULL;
    END IF;
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(NEW.items) LOOP
    item_product_id := COALESCE(
      NULLIF(item->>'variantId', ''), NULLIF(item->>'variant_id', ''),
      NULLIF(item->>'productId', ''), NULLIF(item->>'product_id', '')
    );
    item_type := lower(btrim(COALESCE(item->>'itemType', item->>'item_type', item->>'type', item->>'kind', '')));
    item_is_service := item->>'isService' = 'true'
      OR item->>'is_service' = 'true'
      OR item_type IN ('service', 'dịch vụ', 'custom', 'custom line');

    IF item_product_id IS NULL THEN
      IF item_is_service THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'Order item is missing a product reference'
        USING ERRCODE = '23503';
    END IF;

    SELECT product.brand_id, product.brand
      INTO product_brand_id, product_brand_name
    FROM public.products product
    WHERE product.id = item_product_id
      AND product.organization_id = NEW.organization_id;
    product_found := FOUND;
    IF NOT product_found THEN
      RAISE EXCEPTION 'SKU "%" is not available in this workspace', item_product_id
        USING ERRCODE = '23503';
    END IF;

    IF brand_restriction_enabled AND NOT item_is_service
        AND (assigned_brand_id IS NOT NULL OR canonical_brand_name IS NOT NULL) THEN
      brand_matches := false;
      IF NULLIF(btrim(product_brand_id), '') IS NOT NULL
          AND NULLIF(btrim(assigned_brand_id), '') IS NOT NULL
          AND btrim(product_brand_id) = btrim(assigned_brand_id) THEN
        brand_matches := true;
      ELSIF NEW.organization_id = legacy_organization_id
          AND NULLIF(btrim(product_brand_name), '') IS NOT NULL
          AND NULLIF(btrim(canonical_brand_name), '') IS NOT NULL
          AND lower(btrim(product_brand_name)) = lower(btrim(canonical_brand_name)) THEN
        brand_matches := true;
      END IF;

      IF NOT brand_matches THEN
        RAISE EXCEPTION 'Customer is restricted to assigned brand "%"; SKU "%" belongs to "%"',
          COALESCE(canonical_brand_name, assigned_brand_id), item_product_id,
          COALESCE(NULLIF(btrim(product_brand_name), ''), NULLIF(btrim(product_brand_id), ''), 'unassigned')
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END LOOP;

  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.validate_customer_order_brand_scope() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS p1_order_assigned_brand_scope ON public.orders;
CREATE TRIGGER p1_order_assigned_brand_scope
BEFORE INSERT OR UPDATE OF items, customer_id, organization_id ON public.orders
FOR EACH ROW
EXECUTE FUNCTION public.validate_customer_order_brand_scope();

DROP TRIGGER IF EXISTS p1_draft_order_assigned_brand_scope ON public.draft_orders;
CREATE TRIGGER p1_draft_order_assigned_brand_scope
BEFORE INSERT OR UPDATE OF items, customer_id, organization_id ON public.draft_orders
FOR EACH ROW
EXECUTE FUNCTION public.validate_customer_order_brand_scope();

INSERT INTO public.schema_migrations(version, description)
VALUES ('0102', 'Enforce workspace sales brand policy on order and draft writes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
