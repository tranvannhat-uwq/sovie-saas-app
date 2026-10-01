BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0103') THEN
    RAISE EXCEPTION 'Migration 0104 requires migration 0103';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0062') THEN
    RAISE EXCEPTION 'Migration 0104 requires generic catalog migration 0062';
  END IF;
  IF to_regclass('public.activity_logs') IS NULL THEN
    RAISE EXCEPTION 'Migration 0104 requires activity_logs';
  END IF;
END;
$prerequisite$;

-- The item classification used for brand-policy checks comes from the
-- workspace catalog. Client supplied itemType/isService flags are never
-- authoritative. Unlinked custom service lines require explicit workspace
-- configuration on the sales module.
CREATE OR REPLACE FUNCTION public.validate_customer_order_brand_scope()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  legacy_organization_id constant uuid := '00000000-0000-4000-8000-000000000001';
  sales_config jsonb := '{}'::jsonb;
  assigned_brand_id text;
  assigned_brand_name text;
  canonical_brand_name text;
  brand_restriction_enabled boolean := false;
  allow_unlinked_service_lines boolean := false;
  item jsonb;
  item_product_id text;
  client_declares_service boolean;
  item_is_service boolean;
  product_brand_id text;
  product_brand_name text;
  product_item_kind text;
  brand_matches boolean;
BEGIN
  IF TG_OP = 'UPDATE'
      AND NEW.items IS NOT DISTINCT FROM OLD.items
      AND NEW.customer_id IS NOT DISTINCT FROM OLD.customer_id
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
    RETURN NEW;
  END IF;

  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'Order must belong to a workspace' USING ERRCODE = '23502';
  END IF;
  IF jsonb_typeof(NEW.items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Order items must be a JSON array' USING ERRCODE = '22023';
  END IF;

  SELECT COALESCE(module.config, '{}'::jsonb)
    INTO sales_config
  FROM public.organization_modules module
  WHERE module.organization_id = NEW.organization_id
    AND module.module_key = 'sales';
  brand_restriction_enabled := sales_config->>'brand_restriction_enabled' = 'true';
  allow_unlinked_service_lines := sales_config->>'allow_unlinked_service_lines' = 'true';

  IF NULLIF(btrim(NEW.customer_id), '') IS NOT NULL THEN
    SELECT customer.assigned_brand_id, customer.assigned_brand
      INTO assigned_brand_id, assigned_brand_name
    FROM public.customers customer
    WHERE customer.id = NEW.customer_id
      AND customer.organization_id = NEW.organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer "%" is not available in this workspace', NEW.customer_id USING ERRCODE = '23503';
    END IF;

    IF NULLIF(btrim(assigned_brand_id), '') IS NOT NULL THEN
      SELECT brand.name INTO canonical_brand_name
      FROM public.brands brand
      WHERE brand.id = assigned_brand_id
        AND brand.organization_id = NEW.organization_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'Customer assigned brand is not available in this workspace' USING ERRCODE = '23503';
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
      IF NOT FOUND THEN canonical_brand_name := btrim(assigned_brand_name); END IF;
    END IF;

    IF assigned_brand_id IS NULL AND (assigned_brand_name IS NULL
        OR lower(btrim(assigned_brand_name)) IN ('all', 'tất cả')) THEN
      assigned_brand_id := NULL;
      canonical_brand_name := NULL;
    END IF;
  END IF;

  IF brand_restriction_enabled
      AND NULLIF(btrim(NEW.customer_id), '') IS NOT NULL
      AND assigned_brand_id IS NULL
      AND canonical_brand_name IS NULL THEN
    RAISE EXCEPTION 'Customer has no assigned brand while brand restriction is enabled'
      USING ERRCODE = '23514';
  END IF;

  FOR item IN SELECT value FROM jsonb_array_elements(NEW.items) LOOP
    item_product_id := COALESCE(
      NULLIF(item->>'variantId', ''), NULLIF(item->>'variant_id', ''),
      NULLIF(item->>'productId', ''), NULLIF(item->>'product_id', '')
    );
    client_declares_service := lower(btrim(COALESCE(item->>'isService', ''))) = 'true'
      OR lower(btrim(COALESCE(item->>'is_service', ''))) = 'true'
      OR lower(btrim(COALESCE(item->>'itemType', item->>'item_type', item->>'type', item->>'kind', '')))
        IN ('service', 'dịch vụ', 'custom', 'custom line');
    item_is_service := false;

    IF item_product_id IS NULL THEN
      IF client_declares_service AND allow_unlinked_service_lines THEN
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'Order item is missing a catalog product reference'
        USING ERRCODE = '23503';
    END IF;

    SELECT product.brand_id, product.brand, product.item_kind
      INTO product_brand_id, product_brand_name, product_item_kind
    FROM public.products product
    WHERE product.id = item_product_id
      AND product.organization_id = NEW.organization_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'SKU "%" is not available in this workspace', item_product_id USING ERRCODE = '23503';
    END IF;
    item_is_service := product_item_kind = 'service';

    IF brand_restriction_enabled AND NOT item_is_service THEN
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
FOR EACH ROW EXECUTE FUNCTION public.validate_customer_order_brand_scope();

DROP TRIGGER IF EXISTS p1_draft_order_assigned_brand_scope ON public.draft_orders;
CREATE TRIGGER p1_draft_order_assigned_brand_scope
BEFORE INSERT OR UPDATE OF items, customer_id, organization_id ON public.draft_orders
FOR EACH ROW EXECUTE FUNCTION public.validate_customer_order_brand_scope();

-- Record policy changes in the tenant-scoped activity feed with actor and
-- before/after values. The Owner/Admin check remains the same as migration 0103.
CREATE OR REPLACE FUNCTION public.rpc_set_sales_brand_restriction(p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  actor public.profiles%ROWTYPE;
  existing_config jsonb;
  updated_config jsonb;
  prior_enabled boolean;
BEGIN
  IF active_organization_id IS NULL
      OR NOT public.has_organization_role(active_organization_id, ARRAY['owner', 'admin']) THEN
    RAISE EXCEPTION '403: workspace owner or admin required' USING ERRCODE = '42501';
  END IF;
  IF p_enabled IS NULL THEN
    RAISE EXCEPTION 'Brand restriction setting must be true or false' USING ERRCODE = '22023';
  END IF;
  actor := public.require_authenticated_profile();

  SELECT COALESCE(module.config, '{}'::jsonb)
    INTO existing_config
  FROM public.organization_modules module
  WHERE module.organization_id = active_organization_id
    AND module.module_key = 'sales';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales module configuration was not found for this workspace' USING ERRCODE = 'P0002';
  END IF;
  prior_enabled := existing_config->>'brand_restriction_enabled' = 'true';
  IF prior_enabled = p_enabled THEN
    RETURN jsonb_build_object(
      'organizationId', active_organization_id,
      'brandRestrictionEnabled', to_jsonb(p_enabled)
    );
  END IF;

  UPDATE public.organization_modules
  SET config = jsonb_set(COALESCE(config, '{}'::jsonb),
      '{brand_restriction_enabled}', to_jsonb(p_enabled), true),
      updated_at = now()
  WHERE organization_id = active_organization_id
    AND module_key = 'sales'
  RETURNING config INTO updated_config;

  INSERT INTO public.activity_logs (
    organization_id, operation_key, actor_id, actor_profile_id, actor_username,
    actor_name, actor_role, action, module, target_type, target_id, target_name,
    description, old_value, new_value, changes, metadata, created_at
  ) VALUES (
    active_organization_id, 'sales-policy:' || txid_current()::text,
    actor.auth_user_id, actor.id, actor.username,
    actor.display_name, actor.role, 'update_sales_brand_policy', 'settings',
    'sales_policy', active_organization_id::text,
    COALESCE((SELECT name FROM public.organizations WHERE id = active_organization_id), active_organization_id::text),
    'Updated assigned-brand order policy',
    jsonb_build_object('brandRestrictionEnabled', prior_enabled),
    jsonb_build_object('brandRestrictionEnabled', p_enabled),
    jsonb_build_object('brandRestrictionEnabled', jsonb_build_object('old', prior_enabled, 'new', p_enabled)),
    jsonb_build_object('source', 'rpc_set_sales_brand_restriction'), now()
  );

  RETURN jsonb_build_object(
    'organizationId', active_organization_id,
    'brandRestrictionEnabled', updated_config->'brand_restriction_enabled'
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_set_sales_brand_restriction(boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_set_sales_brand_restriction(boolean) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0104', 'Use workspace catalog item kinds for order policy and audit sales policy changes')
ON CONFLICT (version) DO NOTHING;

COMMIT;
