BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0104') THEN
    RAISE EXCEPTION 'Migration 0105 requires migration 0104';
  END IF;
  IF to_regclass('public.products') IS NULL
      OR to_regclass('public.brands') IS NULL
      OR to_regclass('public.organization_modules') IS NULL
      OR to_regclass('public.organization_settings') IS NULL THEN
    RAISE EXCEPTION 'Migration 0105 requires the workspace catalog and settings schema';
  END IF;
END;
$prerequisite$;

-- Preserve the existing code+brand identity for branded SKUs. Since PostgreSQL
-- treats NULL values as distinct in a UNIQUE constraint, reject ambiguous
-- unbranded SKU collisions before adding a separate unbranded-code constraint.
DO $unbranded_sku_preflight$
DECLARE duplicate_group record;
BEGIN
  SELECT organization_id, upper(btrim(code)) AS normalized_code, count(*) AS row_count
    INTO duplicate_group
  FROM public.products
  WHERE NULLIF(btrim(brand), '') IS NULL
  GROUP BY organization_id, upper(btrim(code))
  HAVING count(*) > 1
  ORDER BY count(*) DESC
  LIMIT 1;

  IF FOUND THEN
    RAISE EXCEPTION 'Cannot enable unbranded products: workspace % has % rows with duplicate unbranded SKU %',
      duplicate_group.organization_id, duplicate_group.row_count, duplicate_group.normalized_code;
  END IF;
END;
$unbranded_sku_preflight$;

ALTER TABLE public.products ALTER COLUMN brand DROP NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS products_organization_unbranded_code_uidx
  ON public.products (organization_id, upper(btrim(code)))
  WHERE NULLIF(btrim(brand), '') IS NULL;

-- Backfill visibility from existing catalog use. Existing paint behavior and
-- populated brand catalogs remain visible; empty/new general workspaces start
-- without an industry-specific brand section.
UPDATE public.organization_modules module
SET config = jsonb_set(COALESCE(module.config, '{}'::jsonb),
  '{brand_catalog_enabled}',
  to_jsonb(
    module.organization_id = '00000000-0000-4000-8000-000000000001'::uuid
    OR module.config->>'brand_restriction_enabled' = 'true'
    OR EXISTS (
      SELECT 1 FROM public.brands brand
      WHERE brand.organization_id = module.organization_id
    )
    OR EXISTS (
      SELECT 1 FROM public.products product
      WHERE product.organization_id = module.organization_id
        AND NULLIF(btrim(product.brand), '') IS NOT NULL
    )
  ), true),
  updated_at = now()
WHERE module.module_key = 'sales'
  AND module.config->'brand_catalog_enabled' IS NULL;

CREATE OR REPLACE FUNCTION public.rpc_set_sales_brand_settings(
  p_brand_restriction_enabled boolean,
  p_brand_catalog_enabled boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  actor public.profiles%ROWTYPE;
  old_config jsonb;
  new_config jsonb;
BEGIN
  IF active_organization_id IS NULL
      OR NOT public.has_organization_role(active_organization_id, ARRAY['owner', 'admin']) THEN
    RAISE EXCEPTION '403: workspace owner or admin required' USING ERRCODE = '42501';
  END IF;
  IF p_brand_restriction_enabled IS NULL OR p_brand_catalog_enabled IS NULL THEN
    RAISE EXCEPTION 'Brand settings must be true or false' USING ERRCODE = '22023';
  END IF;
  IF p_brand_restriction_enabled AND NOT p_brand_catalog_enabled THEN
    RAISE EXCEPTION 'Brand restriction requires the brand catalog to remain enabled' USING ERRCODE = '22023';
  END IF;

  actor := public.require_authenticated_profile();
  SELECT COALESCE(module.config, '{}'::jsonb)
    INTO old_config
  FROM public.organization_modules module
  WHERE module.organization_id = active_organization_id
    AND module.module_key = 'sales'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sales module configuration was not found for this workspace' USING ERRCODE = 'P0002';
  END IF;

  new_config := jsonb_set(
    jsonb_set(old_config, '{brand_restriction_enabled}', to_jsonb(p_brand_restriction_enabled), true),
    '{brand_catalog_enabled}', to_jsonb(p_brand_catalog_enabled), true
  );
  UPDATE public.organization_modules
  SET config = new_config, updated_at = now()
  WHERE organization_id = active_organization_id AND module_key = 'sales';

  IF old_config->>'brand_restriction_enabled' IS DISTINCT FROM p_brand_restriction_enabled::text
      OR old_config->>'brand_catalog_enabled' IS DISTINCT FROM p_brand_catalog_enabled::text THEN
    INSERT INTO public.activity_logs (
      organization_id, operation_key, actor_id, actor_profile_id, actor_username,
      actor_name, actor_role, action, module, target_type, target_id, target_name,
      description, old_value, new_value, changes, metadata, created_at
    ) VALUES (
      active_organization_id, 'sales-brand-settings:' || txid_current()::text,
      actor.auth_user_id, actor.id, actor.username, actor.display_name, actor.role,
      'update_sales_brand_settings', 'settings', 'sales_policy', active_organization_id::text,
      COALESCE((SELECT name FROM public.organizations WHERE id = active_organization_id), active_organization_id::text),
      'Updated workspace brand catalog and sales restriction settings',
      jsonb_build_object(
        'brandRestrictionEnabled', old_config->'brand_restriction_enabled',
        'brandCatalogEnabled', old_config->'brand_catalog_enabled'
      ),
      jsonb_build_object(
        'brandRestrictionEnabled', p_brand_restriction_enabled,
        'brandCatalogEnabled', p_brand_catalog_enabled
      ),
      jsonb_build_object(
        'brandRestrictionEnabled', jsonb_build_object('old', old_config->'brand_restriction_enabled', 'new', p_brand_restriction_enabled),
        'brandCatalogEnabled', jsonb_build_object('old', old_config->'brand_catalog_enabled', 'new', p_brand_catalog_enabled)
      ),
      jsonb_build_object('source', 'rpc_set_sales_brand_settings'), now()
    );
  END IF;

  RETURN jsonb_build_object(
    'organizationId', active_organization_id,
    'brandRestrictionEnabled', p_brand_restriction_enabled,
    'brandCatalogEnabled', p_brand_catalog_enabled
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_set_sales_brand_settings(boolean, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_set_sales_brand_settings(boolean, boolean) TO authenticated;

ALTER TABLE public.organization_settings
  ADD COLUMN IF NOT EXISTS branding jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.rpc_set_invoice_issuer_profile(
  p_company_id text,
  p_profile jsonb
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  actor public.profiles%ROWTYPE;
  target_company_id text := btrim(COALESCE(p_company_id, ''));
  existing_branding jsonb;
  existing_profiles jsonb;
  profile jsonb;
BEGIN
  IF active_organization_id IS NULL
      OR NOT public.has_organization_role(active_organization_id, ARRAY['owner', 'admin']) THEN
    RAISE EXCEPTION '403: workspace owner or admin required' USING ERRCODE = '42501';
  END IF;
  IF target_company_id = '' OR p_profile IS NULL OR jsonb_typeof(p_profile) <> 'object' THEN
    RAISE EXCEPTION 'A company key and invoice profile are required' USING ERRCODE = '22023';
  END IF;
  IF target_company_id <> active_organization_id::text
      AND NOT EXISTS (
        SELECT 1 FROM public.companies company
        WHERE company.organization_id = active_organization_id AND company.id = target_company_id
      )
      AND NOT EXISTS (
        SELECT 1 FROM public.organization_branches branch
        WHERE branch.organization_id = active_organization_id AND branch.id::text = target_company_id
      ) THEN
    RAISE EXCEPTION 'Issuer does not belong to this workspace' USING ERRCODE = '42501';
  END IF;

  profile := jsonb_build_object(
    'legal_name', left(btrim(COALESCE(p_profile->>'legal_name', '')), 240),
    'tax_code', left(btrim(COALESCE(p_profile->>'tax_code', '')), 40),
    'logo_url', left(btrim(COALESCE(p_profile->>'logo_url', '')), 1000),
    'hotline', left(btrim(COALESCE(p_profile->>'hotline', '')), 80),
    'customer_service_phone', left(btrim(COALESCE(p_profile->>'customer_service_phone', '')), 80),
    'email', left(btrim(COALESCE(p_profile->>'email', '')), 240),
    'address', left(btrim(COALESCE(p_profile->>'address', '')), 500),
    'factory_address', left(btrim(COALESCE(p_profile->>'factory_address', '')), 500),
    'business_address', left(btrim(COALESCE(p_profile->>'business_address', '')), 500),
    'invoice_warehouse_text', left(btrim(COALESCE(p_profile->>'invoice_warehouse_text', '')), 240),
    'sales_phone', left(btrim(COALESCE(p_profile->>'sales_phone', '')), 80)
  );
  IF profile->>'logo_url' <> ''
      AND profile->>'logo_url' !~* '^https://'
      AND (left(profile->>'logo_url', 1) <> '/' OR left(profile->>'logo_url', 2) = '//') THEN
    RAISE EXCEPTION 'Invoice logo must use HTTPS or a workspace-local path' USING ERRCODE = '22023';
  END IF;

  actor := public.require_authenticated_profile();
  SELECT COALESCE(setting.branding, '{}'::jsonb)
    INTO existing_branding
  FROM public.organization_settings setting
  WHERE setting.organization_id = active_organization_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace settings were not found' USING ERRCODE = 'P0002';
  END IF;
  existing_profiles := CASE
    WHEN jsonb_typeof(existing_branding->'invoice_issuers') = 'object'
      THEN existing_branding->'invoice_issuers'
    ELSE '{}'::jsonb
  END;
  UPDATE public.organization_settings
  SET branding = jsonb_set(existing_branding, '{invoice_issuers}',
      existing_profiles || jsonb_build_object(target_company_id, profile), true),
      updated_at = now()
  WHERE organization_id = active_organization_id;

  INSERT INTO public.activity_logs (
    organization_id, operation_key, actor_id, actor_profile_id, actor_username,
    actor_name, actor_role, action, module, target_type, target_id, target_name,
    description, old_value, new_value, changes, metadata, created_at
  ) VALUES (
    active_organization_id, 'invoice-issuer-profile:' || txid_current()::text,
    actor.auth_user_id, actor.id, actor.username, actor.display_name, actor.role,
    'update_invoice_issuer_profile', 'settings', 'invoice_issuer', target_company_id,
    COALESCE(profile->>'legal_name', target_company_id), 'Updated invoice issuer profile',
    existing_profiles->target_company_id, profile,
    jsonb_build_object('profile', jsonb_build_object('old', existing_profiles->target_company_id, 'new', profile)),
    jsonb_build_object('source', 'rpc_set_invoice_issuer_profile'), now()
  );

  RETURN jsonb_build_object('organizationId', active_organization_id,
    'companyId', target_company_id, 'profile', profile);
END;
$function$;

REVOKE ALL ON FUNCTION public.rpc_set_invoice_issuer_profile(text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_set_invoice_issuer_profile(text, jsonb) TO authenticated;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS issuer_profile_snapshot jsonb;
ALTER TABLE public.draft_orders
  ADD COLUMN IF NOT EXISTS issuer_profile_snapshot jsonb;

CREATE OR REPLACE FUNCTION public.set_order_issuer_profile_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  issuer_profile jsonb;
  org_name text;
  issuer_address text;
  legacy_organization_id constant uuid := '00000000-0000-4000-8000-000000000001';
BEGIN
  IF TG_OP = 'UPDATE'
      AND NEW.issuer_profile_snapshot IS NOT NULL
      AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
      AND NEW.organization_id IS NOT DISTINCT FROM OLD.organization_id THEN
    RETURN NEW;
  END IF;

  SELECT settings.branding->'invoice_issuers'->COALESCE(NULLIF(NEW.company_id, ''), NEW.organization_id::text)
    INTO issuer_profile
  FROM public.organization_settings settings
  WHERE settings.organization_id = NEW.organization_id;

  IF issuer_profile IS NULL AND NEW.organization_id = legacy_organization_id THEN
    SELECT jsonb_build_object(
      'issuer_id', brand.company_id,
      'legal_name', brand.company_name,
      'logo_url', brand.logo_filename,
      'hotline', brand.hotline,
      'customer_service_phone', brand.cskh,
      'email', brand.email,
      'address', brand.address_main,
      'factory_address', brand.address_factory,
      'business_address', brand.address_business,
      'invoice_warehouse_text', brand.invoice_warehouse_text,
      'sales_phone', brand.sales_phone
    ) INTO issuer_profile
    FROM public.brands brand
    WHERE brand.organization_id = NEW.organization_id
      AND brand.company_id = NEW.company_id
    ORDER BY brand.name
    LIMIT 1;
  END IF;

  IF issuer_profile IS NULL THEN
    SELECT COALESCE(NULLIF(company.name, ''), NULLIF(branch.name, ''), organization.name),
      COALESCE(NULLIF(company.address, ''), NULLIF(branch.address, ''))
    INTO org_name, issuer_address
    FROM public.organizations organization
    LEFT JOIN public.companies company
      ON company.organization_id = NEW.organization_id
     AND company.id = NEW.company_id
    LEFT JOIN public.organization_branches branch
      ON branch.organization_id = NEW.organization_id
     AND branch.id::text = NEW.company_id
    WHERE organization.id = NEW.organization_id;
    issuer_profile := jsonb_build_object(
      'issuer_id', NEW.company_id,
      'legal_name', COALESCE(NULLIF(org_name, ''), 'DOANH NGHIỆP'),
      'tax_code', '', 'logo_url', '', 'hotline', '', 'customer_service_phone', '',
      'email', '', 'address', COALESCE(issuer_address, ''), 'factory_address', '', 'business_address', '',
      'invoice_warehouse_text', '', 'sales_phone', ''
    );
  END IF;

  NEW.issuer_profile_snapshot := issuer_profile;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_order_issuer_profile_snapshot() FROM PUBLIC, anon, authenticated;
DROP TRIGGER IF EXISTS orders_issuer_profile_snapshot ON public.orders;
CREATE TRIGGER orders_issuer_profile_snapshot
BEFORE INSERT OR UPDATE OF organization_id, company_id ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.set_order_issuer_profile_snapshot();
DROP TRIGGER IF EXISTS draft_orders_issuer_profile_snapshot ON public.draft_orders;
CREATE TRIGGER draft_orders_issuer_profile_snapshot
BEFORE INSERT OR UPDATE OF organization_id, company_id ON public.draft_orders
FOR EACH ROW EXECUTE FUNCTION public.set_order_issuer_profile_snapshot();

-- Attribute dashboard revenue and company filters to the order's transaction company.
-- Brand is descriptive product metadata outside the legacy paint workspace.
CREATE OR REPLACE FUNCTION public.rpc_get_phase5_dashboard(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  start_at timestamptz;
  end_at timestamptz;
  result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  start_at := COALESCE(NULLIF(p_filters->>'start', '')::timestamptz, date_trunc('month', now()));
  end_at := COALESCE(NULLIF(p_filters->>'end', '')::timestamptz, now() + interval '1 day');
  IF end_at <= start_at OR end_at - start_at > interval '5 years' THEN
    RAISE EXCEPTION 'Invalid reporting date range';
  END IF;

  WITH visible_orders AS (
    SELECT sale.*,
      COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''), 'unassigned') managed_salesperson_id
    FROM public.orders sale
    LEFT JOIN public.customers customer ON customer.id = sale.customer_id
    WHERE COALESCE(sale.order_date, sale.created_at) >= start_at
      AND COALESCE(sale.order_date, sale.created_at) < end_at
      AND sale.status NOT IN ('cancelled', 'canceled', 'draft')
      AND (actor.role <> 'sale' OR COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''))
        IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (NULLIF(p_filters->>'company_id', '') IS NULL OR p_filters->>'company_id' = 'all'
        OR sale.company_id = p_filters->>'company_id')
      AND (NULLIF(p_filters->>'customer_id', '') IS NULL OR p_filters->>'customer_id' = 'all'
        OR sale.customer_id = p_filters->>'customer_id')
      AND (actor.role = 'sale' OR NULLIF(p_filters->>'salesperson_id', '') IS NULL
        OR p_filters->>'salesperson_id' = 'all'
        OR COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''), 'unassigned') = p_filters->>'salesperson_id')
  ), item_rows AS (
    SELECT item.*, sale.customer_id, sale.customer_name, sale.company_id, sale.managed_salesperson_id,
      sale.customer_manager_id, sale.order_date, sale.order_created_at,
      sale.company_id revenue_company_id
    FROM (
      SELECT visible.*, visible.created_at order_created_at
      FROM visible_orders visible
    ) sale
    JOIN public.order_items item ON item.order_id = sale.id
    WHERE (NULLIF(p_filters->>'brand_id', '') IS NULL OR p_filters->>'brand_id' = 'all'
      OR item.brand_id = p_filters->>'brand_id')
      AND (NULLIF(p_filters->>'company_id', '') IS NULL OR p_filters->>'company_id' = 'all'
        OR sale.company_id = p_filters->>'company_id')
  ), valid_returns AS (
    SELECT ret.* FROM public.sales_returns ret JOIN visible_orders sale ON sale.id = ret.sale_id
    WHERE ret.status NOT IN ('cancelled', 'canceled')
      AND COALESCE(ret.return_date, ret.created_at) >= start_at
      AND COALESCE(ret.return_date, ret.created_at) < end_at
  ), valid_payments AS (
    SELECT pay.* FROM public.payments pay
    WHERE pay.status = 'completed' AND pay.created_at >= start_at AND pay.created_at < end_at
      AND EXISTS (SELECT 1 FROM visible_orders sale WHERE sale.id = pay.order_id)
  ), customer_scope AS (
    SELECT customer.* FROM public.customers customer
    WHERE (actor.role <> 'sale' OR customer.managed_by IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (NULLIF(p_filters->>'customer_id', '') IS NULL OR p_filters->>'customer_id' = 'all'
        OR customer.id = p_filters->>'customer_id')
      AND (actor.role = 'sale' OR NULLIF(p_filters->>'salesperson_id', '') IS NULL
        OR p_filters->>'salesperson_id' = 'all' OR customer.managed_by = p_filters->>'salesperson_id')
  )
  SELECT jsonb_build_object(
    'period', jsonb_build_object('start', start_at, 'end', end_at),
    'summary', jsonb_build_object(
      'gross_sales', COALESCE((SELECT sum(total_payable) FROM visible_orders), 0),
      'returns', COALESCE((SELECT sum(COALESCE(NULLIF(total_refund, 0), total_return_amount, 0)) FROM valid_returns), 0),
      'net_sales', COALESCE((SELECT sum(net_revenue) FROM visible_orders), 0),
      'collected', COALESCE((SELECT sum(amount) FROM valid_payments), 0),
      'debt_issued', COALESCE((SELECT sum(GREATEST(debt_amount, 0)) FROM visible_orders), 0),
      'debt_collected', COALESCE((SELECT sum(-debt_change) FROM public.customer_debt_transactions debt
        WHERE debt.transaction_date >= start_at AND debt.transaction_date < end_at AND debt.debt_change < 0
          AND EXISTS (SELECT 1 FROM customer_scope c WHERE c.id = debt.customer_id)), 0),
      'current_debt', COALESCE((SELECT sum(debt) FROM customer_scope), 0),
      'order_count', (SELECT count(*) FROM visible_orders),
      'sold_quantity', COALESCE((SELECT sum(quantity - COALESCE(returned_quantity, 0)) FROM item_rows), 0)
    ),
    'by_company', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'key', revenue_company_id,
        'amount', sum(CASE WHEN p_filters->>'sales_mode' = 'gross' THEN line_total ELSE COALESCE(NULLIF(net_amount, 0), line_total) END)
      ) x
      FROM item_rows
      GROUP BY revenue_company_id
    ) q), '[]'::jsonb),
    'by_brand', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'key', COALESCE(brand_id, 'unassigned'),
        'amount', sum(CASE WHEN p_filters->>'sales_mode' = 'gross' THEN line_total ELSE COALESCE(NULLIF(net_amount, 0), line_total) END)
      ) x
      FROM item_rows GROUP BY brand_id
    ) q), '[]'::jsonb),
    'by_salesperson', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'key', managed_salesperson_id,
        'amount', sum(CASE WHEN p_filters->>'sales_mode' = 'gross' THEN total_payable ELSE net_revenue END)
      ) x
      FROM visible_orders GROUP BY managed_salesperson_id
    ) q), '[]'::jsonb),
    'kpi_by_employee', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'net_sales')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'key', sale.managed_salesperson_id,
        'gross_sales', sum(sale.total_payable),
        'returns', sum(COALESCE((SELECT sum(COALESCE(NULLIF(ret.total_refund, 0), ret.total_return_amount, 0))
          FROM valid_returns ret WHERE ret.sale_id = sale.id), 0)),
        'net_sales', sum(sale.net_revenue),
        'collected', sum(COALESCE((SELECT sum(pay.amount) FROM valid_payments pay WHERE pay.order_id = sale.id), 0)),
        'debt_issued', sum(GREATEST(sale.debt_amount, 0))
      ) x FROM visible_orders sale GROUP BY sale.managed_salesperson_id
    ) q), '[]'::jsonb),
    'by_customer', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object('key', customer_id, 'name', max(customer_name), 'amount', sum(CASE WHEN p_filters->>'sales_mode' = 'gross' THEN total_payable ELSE net_revenue END)) x
      FROM visible_orders GROUP BY customer_id
    ) q), '[]'::jsonb),
    'series', COALESCE((SELECT jsonb_agg(x ORDER BY x->>'date') FROM (
      SELECT jsonb_build_object('date', to_char(date_trunc('day', COALESCE(order_date, created_at) AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD'),
        'amount', sum(CASE WHEN p_filters->>'sales_mode' = 'gross' THEN total_payable ELSE net_revenue END)) x
      FROM visible_orders GROUP BY date_trunc('day', COALESCE(order_date, created_at) AT TIME ZONE 'Asia/Bangkok')
    ) q), '[]'::jsonb),
    'top_skus', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'quantity')::numeric DESC) FROM (
      SELECT jsonb_build_object('code', COALESCE(variant_code_snapshot, product_code_snapshot),
        'name', product_name_snapshot, 'quantity', sum(quantity - COALESCE(returned_quantity, 0)),
        'amount', sum(COALESCE(NULLIF(net_amount, 0), line_total))) x
      FROM item_rows GROUP BY COALESCE(variant_code_snapshot, product_code_snapshot), product_name_snapshot
      ORDER BY sum(quantity - COALESCE(returned_quantity, 0)) DESC LIMIT 10
    ) q), '[]'::jsonb),
    'recent_orders', COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.order_date DESC) FROM (
      SELECT id, customer_id, customer_name, company_id, total_payable, net_revenue,
        COALESCE(order_date, created_at) order_date, status FROM visible_orders
      ORDER BY COALESCE(order_date, created_at) DESC LIMIT 10
    ) q), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;

ALTER FUNCTION public.rpc_get_phase5_dashboard(jsonb) OWNER TO saas_rpc_executor;
REVOKE ALL ON FUNCTION public.rpc_get_phase5_dashboard(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_phase5_dashboard(jsonb) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0105', 'Make brands optional, snapshot invoice issuers, and report sales by transaction company')
ON CONFLICT (version) DO NOTHING;

COMMIT;
