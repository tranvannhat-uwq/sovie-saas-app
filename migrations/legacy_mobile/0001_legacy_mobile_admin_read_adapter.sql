BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0055') THEN
    RAISE EXCEPTION 'Legacy mobile adapter requires migration 0055';
  END IF;
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0056')
      OR to_regclass('public.organization_memberships') IS NOT NULL THEN
    RAISE EXCEPTION 'Legacy mobile adapter must not be applied to the SaaS schema';
  END IF;
END;
$prerequisite$;

CREATE TABLE IF NOT EXISTS public.legacy_mobile_admin_readers (
  auth_user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL DEFAULT 'Mobile Admin',
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.legacy_mobile_admin_readers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.legacy_mobile_admin_readers FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.require_legacy_mobile_admin_reader()
RETURNS public.profiles
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_user_id uuid := auth.uid();
  actor public.profiles%ROWTYPE;
BEGIN
  IF request_user_id IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.legacy_mobile_admin_readers reader
    WHERE reader.auth_user_id = request_user_id AND reader.is_active = true
  ) THEN
    RAISE EXCEPTION '403: mobile read access required' USING ERRCODE = '42501';
  END IF;
  -- A dedicated Auth identity must not also be a web identity. This preserves
  -- every existing web RPC/RLS boundary without modifying it.
  IF EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.auth_user_id = request_user_id AND profile.is_active = true
  ) THEN
    RAISE EXCEPTION '403: dedicated mobile identity required' USING ERRCODE = '42501';
  END IF;
  actor.auth_user_id := request_user_id;
  actor.role := 'admin';
  actor.username := 'mobile_admin_viewer';
  actor.display_name := 'Mobile Admin';
  actor.is_active := true;
  RETURN actor;
END;
$$;
REVOKE ALL ON FUNCTION public.require_legacy_mobile_admin_reader() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_mobile_my_access()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_user_id uuid := auth.uid();
  reader_name text;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  SELECT reader.display_name INTO reader_name
  FROM public.legacy_mobile_admin_readers reader
  WHERE reader.auth_user_id = request_user_id AND reader.is_active = true;
  RETURN jsonb_build_object(
    'allowed', true,
    'membership_role', 'mobile_admin_viewer',
    'read_only', true,
    'profile', jsonb_build_object(
      'id', request_user_id,
      'auth_user_id', request_user_id,
      'username', 'mobile_admin_viewer',
      'display_name', COALESCE(reader_name, 'Mobile Admin'),
      'role', 'admin',
      'company_id', '',
      'is_external', false,
      'is_active', true
    )
  );
END;
$$;

-- Clone the current production dashboard query instead of changing the web
-- report. Only its authentication line and public name are replaced.
DO $clone_dashboard$
DECLARE
  source_oid oid := to_regprocedure('public.rpc_get_phase5_dashboard(jsonb)');
  definition text;
BEGIN
  IF source_oid IS NULL THEN RAISE EXCEPTION 'Production dashboard RPC is missing'; END IF;
  definition := pg_get_functiondef(source_oid);
  definition := replace(
    definition,
    'FUNCTION public.rpc_get_phase5_dashboard',
    'FUNCTION public.rpc_legacy_mobile_dashboard_source'
  );
  definition := replace(
    definition,
    'actor := public.require_authenticated_profile();',
    'PERFORM public.require_legacy_mobile_admin_reader(); actor.role := ''admin'';'
  );
  IF definition NOT LIKE '%require_legacy_mobile_admin_reader()%' THEN
    RAISE EXCEPTION 'Could not isolate dashboard authentication';
  END IF;
  EXECUTE definition;
END;
$clone_dashboard$;
REVOKE ALL ON FUNCTION public.rpc_legacy_mobile_dashboard_source(jsonb)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_mobile_admin_dashboard(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE raw jsonb;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  raw := public.rpc_legacy_mobile_dashboard_source(p_filters);
  RETURN jsonb_build_object(
    'period', raw->'period',
    'summary', jsonb_build_object(
      'gross_sales', COALESCE(raw#>'{summary,gross_sales}', '0'::jsonb),
      'returns', COALESCE(raw#>'{summary,returns}', '0'::jsonb),
      'net_sales', COALESCE(raw#>'{summary,net_sales}', '0'::jsonb),
      'collected', COALESCE(raw#>'{summary,collected}', '0'::jsonb),
      'current_debt', COALESCE(raw#>'{summary,current_debt}', '0'::jsonb),
      'order_count', COALESCE(raw#>'{summary,order_count}', '0'::jsonb),
      'sold_quantity', COALESCE(raw#>'{summary,sold_quantity}', '0'::jsonb)
    ),
    'by_company', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'key', ranked.item->>'key',
      'name', COALESCE(company.name, ranked.item->>'key', 'Chưa phân loại'),
      'amount', ranked.item->'amount') ORDER BY ranked.position)
      FROM (SELECT item, position FROM jsonb_array_elements(COALESCE(raw->'by_company', '[]'::jsonb))
        WITH ORDINALITY expanded(item, position) LIMIT 5) ranked
      LEFT JOIN public.companies company ON company.id = ranked.item->>'key'), '[]'::jsonb),
    'by_brand', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'key', ranked.item->>'key',
      'name', COALESCE((SELECT brand.name FROM public.brands brand
        WHERE brand.id = ranked.item->>'key' OR brand.name = ranked.item->>'key'
        ORDER BY CASE WHEN brand.id = ranked.item->>'key' THEN 0 ELSE 1 END LIMIT 1),
        ranked.item->>'key', 'Chưa phân loại'),
      'amount', ranked.item->'amount') ORDER BY ranked.position)
      FROM (SELECT item, position FROM jsonb_array_elements(COALESCE(raw->'by_brand', '[]'::jsonb))
        WITH ORDINALITY expanded(item, position) LIMIT 5) ranked), '[]'::jsonb),
    'by_salesperson', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'key', ranked.item->>'key',
      'name', COALESCE((SELECT NULLIF(COALESCE(profile.display_name, profile.username), '')
        FROM public.profiles profile WHERE profile.id = ranked.item->>'key'
          OR profile.username = ranked.item->>'key'
          OR profile.auth_user_id::text = ranked.item->>'key' LIMIT 1),
        CASE WHEN ranked.item->>'key' = 'unassigned' THEN 'Chưa phân công' ELSE ranked.item->>'key' END),
      'amount', ranked.item->'amount') ORDER BY ranked.position)
      FROM (SELECT item, position FROM jsonb_array_elements(COALESCE(raw->'by_salesperson', '[]'::jsonb))
        WITH ORDINALITY expanded(item, position) LIMIT 5) ranked), '[]'::jsonb),
    'by_customer', COALESCE((SELECT jsonb_agg(item ORDER BY position)
      FROM (SELECT item, position FROM jsonb_array_elements(COALESCE(raw->'by_customer', '[]'::jsonb))
        WITH ORDINALITY expanded(item, position) LIMIT 5) ranked), '[]'::jsonb),
    'series', COALESCE((SELECT jsonb_agg(item ORDER BY item->>'date')
      FROM (SELECT item FROM jsonb_array_elements(COALESCE(raw->'series', '[]'::jsonb)) item
        ORDER BY item->>'date' DESC LIMIT 14) recent), '[]'::jsonb),
    'top_skus', COALESCE((SELECT jsonb_agg(item ORDER BY position)
      FROM (SELECT item, position FROM jsonb_array_elements(COALESCE(raw->'top_skus', '[]'::jsonb))
        WITH ORDINALITY expanded(item, position) LIMIT 5) ranked), '[]'::jsonb),
    'recent_orders', COALESCE(raw->'recent_orders', '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_mobile_orders_paginated(
  p_search text DEFAULT '', p_status text DEFAULT 'all', p_limit int DEFAULT 20, p_offset int DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  safe_limit int := LEAST(GREATEST(p_limit, 1), 50);
  safe_offset int := GREATEST(p_offset, 0);
  search_term text := btrim(COALESCE(p_search, ''));
  status_filter text := lower(COALESCE(NULLIF(p_status, ''), 'all'));
  result jsonb;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  WITH combined AS (
    SELECT order_row.id, 'finalized'::text source, order_row.customer_id,
      order_row.customer_name, COALESCE(customer.phone, '') customer_phone,
      COALESCE(order_row.order_date, order_row.created_at) order_date,
      order_row.status, COALESCE(order_row.total_payable, 0) total_payable,
      COALESCE(order_row.paid_amount, 0) paid_amount,
      jsonb_array_length(COALESCE(order_row.items, '[]'::jsonb)) item_count,
      COALESCE((SELECT sum(COALESCE((item->>'quantity')::numeric, 0))
        FROM jsonb_array_elements(COALESCE(order_row.items, '[]'::jsonb)) item), 0) quantity
    FROM public.orders order_row LEFT JOIN public.customers customer ON customer.id = order_row.customer_id
    UNION ALL
    SELECT draft.id, 'draft'::text, draft.customer_id, draft.customer_name,
      COALESCE(customer.phone, ''), draft.created_at, 'draft'::text,
      COALESCE(draft.total_payable, 0),
      COALESCE(NULLIF(to_jsonb(draft)->>'paid_amount', '')::numeric, 0),
      jsonb_array_length(COALESCE(draft.items, '[]'::jsonb)),
      COALESCE((SELECT sum(COALESCE((item->>'quantity')::numeric, 0))
        FROM jsonb_array_elements(COALESCE(draft.items, '[]'::jsonb)) item), 0)
    FROM public.draft_orders draft LEFT JOIN public.customers customer ON customer.id = draft.customer_id
  ), filtered AS (
    SELECT * FROM combined row_data WHERE
      (search_term = '' OR row_data.id ILIKE '%' || search_term || '%'
        OR row_data.customer_name ILIKE '%' || search_term || '%')
      AND (status_filter = 'all'
        OR (status_filter = 'draft' AND row_data.source = 'draft')
        OR (status_filter = 'confirmed' AND row_data.source = 'finalized'
          AND lower(row_data.status) IN ('confirmed', 'settled', 'completed', 'complete'))
        OR (status_filter = 'cancelled' AND row_data.source = 'finalized'
          AND lower(row_data.status) IN ('cancelled', 'canceled'))
        OR (status_filter <> 'draft' AND row_data.source = 'finalized'
          AND lower(row_data.status) = status_filter))
  ), page AS (
    SELECT * FROM filtered ORDER BY order_date DESC, id DESC LIMIT safe_limit OFFSET safe_offset
  ) SELECT jsonb_build_object('total', (SELECT count(*) FROM filtered), 'limit', safe_limit,
      'offset', safe_offset, 'data', COALESCE((SELECT jsonb_agg(to_jsonb(page)
        ORDER BY order_date DESC, id DESC) FROM page), '[]'::jsonb)) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_mobile_order_detail(p_id text, p_source text DEFAULT 'finalized')
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  IF lower(COALESCE(p_source, 'finalized')) = 'draft' THEN
    SELECT jsonb_build_object('id', draft.id, 'source', 'draft', 'customer_id', draft.customer_id,
      'customer_name', draft.customer_name, 'customer_phone', COALESCE(customer.phone, ''),
      'order_date', draft.created_at, 'status', 'draft',
      'total_payable', COALESCE(draft.total_payable, 0),
      'paid_amount', COALESCE(NULLIF(to_jsonb(draft)->>'paid_amount', '')::numeric, 0),
      'notes', COALESCE(draft.notes, ''), 'items', COALESCE(draft.items, '[]'::jsonb)) INTO result
    FROM public.draft_orders draft LEFT JOIN public.customers customer ON customer.id = draft.customer_id
    WHERE draft.id = p_id;
  ELSE
    SELECT jsonb_build_object('id', order_row.id, 'source', 'finalized',
      'customer_id', order_row.customer_id, 'customer_name', order_row.customer_name,
      'customer_phone', COALESCE(customer.phone, ''),
      'order_date', COALESCE(order_row.order_date, order_row.created_at), 'status', order_row.status,
      'total_payable', COALESCE(order_row.total_payable, 0), 'paid_amount', COALESCE(order_row.paid_amount, 0),
      'notes', COALESCE(order_row.notes, ''), 'items', COALESCE(order_row.items, '[]'::jsonb)) INTO result
    FROM public.orders order_row LEFT JOIN public.customers customer ON customer.id = order_row.customer_id
    WHERE order_row.id = p_id;
  END IF;
  IF result IS NULL THEN RAISE EXCEPTION 'Order not found'; END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_mobile_customers_paginated(
  p_search text DEFAULT '', p_limit int DEFAULT 30, p_offset int DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  safe_limit int := LEAST(GREATEST(p_limit, 1), 50); safe_offset int := GREATEST(p_offset, 0);
  search_term text := btrim(COALESCE(p_search, '')); result jsonb;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  WITH filtered AS (
    SELECT customer.id, customer.code, customer.name, COALESCE(customer.phone, '') phone,
      COALESCE(customer.debt, 0) debt, customer.status, customer.last_order_at,
      COALESCE((SELECT NULLIF(COALESCE(profile.display_name, profile.username), '')
        FROM public.profiles profile WHERE profile.id = customer.managed_by
          OR profile.username = customer.managed_by OR profile.auth_user_id::text = customer.managed_by
        LIMIT 1), customer.managed_by, '') managed_by
    FROM public.customers customer WHERE customer.deleted_at IS NULL
      AND (search_term = '' OR customer.code ILIKE '%' || search_term || '%'
        OR customer.name ILIKE '%' || search_term || '%' OR customer.phone ILIKE '%' || search_term || '%')
  ), page AS (SELECT * FROM filtered ORDER BY last_order_at DESC NULLS LAST, name
    LIMIT safe_limit OFFSET safe_offset)
  SELECT jsonb_build_object('total', (SELECT count(*) FROM filtered), 'limit', safe_limit,
    'offset', safe_offset, 'data', COALESCE((SELECT jsonb_agg(to_jsonb(page)
      ORDER BY last_order_at DESC NULLS LAST, name) FROM page), '[]'::jsonb)) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_mobile_customer_detail(p_id text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  SELECT jsonb_build_object('id', customer.id, 'code', customer.code, 'name', customer.name,
    'phone', customer.phone, 'phone2', customer.phone2, 'email', customer.email,
    'address', customer.address, 'company_name', customer.company_name, 'tax_code', customer.tax_code,
    'assigned_brand', customer.assigned_brand,
    'default_price_list_id', COALESCE(customer.default_price_list_id, customer.pricelist_id),
    'managed_by', COALESCE((SELECT NULLIF(COALESCE(profile.display_name, profile.username), '')
      FROM public.profiles profile WHERE profile.id = customer.managed_by
        OR profile.username = customer.managed_by OR profile.auth_user_id::text = customer.managed_by LIMIT 1),
      customer.managed_by, ''), 'debt', COALESCE(customer.debt, 0),
    'total_transaction', COALESCE(customer.total_transaction, 0),
    'total_return', COALESCE(customer.total_return, 0), 'net_revenue', COALESCE(customer.net_revenue, 0),
    'last_order_at', customer.last_order_at, 'last_payment_at', customer.last_payment_at,
    'notes', customer.notes, 'status', customer.status) INTO result
  FROM public.customers customer WHERE customer.id = p_id AND customer.deleted_at IS NULL;
  IF result IS NULL THEN RAISE EXCEPTION 'Customer not found'; END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_mobile_customer_debts(
  p_search text DEFAULT '', p_limit int DEFAULT 30, p_offset int DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  safe_limit int := LEAST(GREATEST(p_limit, 1), 50); safe_offset int := GREATEST(p_offset, 0);
  search_term text := btrim(COALESCE(p_search, '')); result jsonb;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  WITH filtered AS (
    SELECT customer.id, customer.code, customer.name, COALESCE(customer.phone, '') phone,
      COALESCE(customer.debt, 0) debt, customer.last_order_at, customer.last_payment_at
    FROM public.customers customer WHERE customer.deleted_at IS NULL AND COALESCE(customer.debt, 0) <> 0
      AND (search_term = '' OR customer.code ILIKE '%' || search_term || '%'
        OR customer.name ILIKE '%' || search_term || '%' OR customer.phone ILIKE '%' || search_term || '%')
  ), page AS (SELECT * FROM filtered ORDER BY debt DESC, name LIMIT safe_limit OFFSET safe_offset)
  SELECT jsonb_build_object('summary', jsonb_build_object(
      'receivable', COALESCE((SELECT sum(debt) FROM filtered WHERE debt > 0), 0),
      'advance', ABS(COALESCE((SELECT sum(debt) FROM filtered WHERE debt < 0), 0)),
      'customer_count', (SELECT count(*) FROM filtered)),
    'total', (SELECT count(*) FROM filtered), 'limit', safe_limit, 'offset', safe_offset,
    'data', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY debt DESC, name) FROM page), '[]'::jsonb))
    INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_mobile_customer_debt_transactions(
  p_customer_id text, p_limit int DEFAULT 30, p_offset int DEFAULT 0
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  safe_limit int := LEAST(GREATEST(p_limit, 1), 50); safe_offset int := GREATEST(p_offset, 0);
  result jsonb;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  IF NOT EXISTS (SELECT 1 FROM public.customers WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'Customer not found';
  END IF;
  WITH filtered AS (
    SELECT debt.id, debt.transaction_type, COALESCE(debt.amount, 0) amount,
      COALESCE(debt.debt_change, 0) debt_change, COALESCE(debt.balance_after, 0) balance_after,
      debt.order_id, debt.sales_return_id, debt.description, debt.transaction_date
    FROM public.customer_debt_transactions debt WHERE debt.customer_id = p_customer_id
  ), page AS (SELECT * FROM filtered ORDER BY transaction_date DESC, id DESC
    LIMIT safe_limit OFFSET safe_offset)
  SELECT jsonb_build_object('total', (SELECT count(*) FROM filtered), 'limit', safe_limit,
    'offset', safe_offset, 'data', COALESCE((SELECT jsonb_agg(to_jsonb(page)
      ORDER BY transaction_date DESC, id DESC) FROM page), '[]'::jsonb)) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_mobile_employees(
  p_search text DEFAULT '', p_limit int DEFAULT 30, p_offset int DEFAULT 0,
  p_start timestamptz DEFAULT date_trunc('month', now()), p_end timestamptz DEFAULT now() + interval '1 day'
) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE
  safe_limit int := LEAST(GREATEST(p_limit, 1), 50); safe_offset int := GREATEST(p_offset, 0);
  search_term text := btrim(COALESCE(p_search, '')); result jsonb;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  IF p_end <= p_start OR p_end - p_start > interval '1 year' THEN
    RAISE EXCEPTION 'Invalid employee reporting range';
  END IF;
  WITH filtered AS (
    SELECT profile.id, profile.username, profile.display_name, profile.role,
      profile.position, profile.company_id, profile.is_external, profile.is_active,
      COALESCE(metrics.customer_count, 0) customer_count,
      COALESCE(metrics.current_debt, 0) current_debt,
      COALESCE(metrics.order_count, 0) order_count, COALESCE(metrics.net_sales, 0) net_sales
    FROM public.profiles profile LEFT JOIN LATERAL (
      SELECT
        (SELECT count(*) FROM public.customers customer WHERE customer.deleted_at IS NULL
          AND customer.managed_by IN (profile.id, profile.username, profile.auth_user_id::text)) customer_count,
        (SELECT sum(COALESCE(customer.debt, 0)) FROM public.customers customer
          WHERE customer.deleted_at IS NULL
            AND customer.managed_by IN (profile.id, profile.username, profile.auth_user_id::text)) current_debt,
        (SELECT count(*) FROM public.orders order_row LEFT JOIN public.customers customer
          ON customer.id = order_row.customer_id
          WHERE COALESCE(order_row.order_date, order_row.created_at) >= p_start
            AND COALESCE(order_row.order_date, order_row.created_at) < p_end
            AND order_row.status NOT IN ('cancelled', 'canceled', 'draft')
            AND COALESCE(NULLIF(customer.managed_by, ''), NULLIF(order_row.customer_manager_id, ''))
              IN (profile.id, profile.username, profile.auth_user_id::text)) order_count,
        (SELECT sum(COALESCE(order_row.net_revenue, 0)) FROM public.orders order_row
          LEFT JOIN public.customers customer ON customer.id = order_row.customer_id
          WHERE COALESCE(order_row.order_date, order_row.created_at) >= p_start
            AND COALESCE(order_row.order_date, order_row.created_at) < p_end
            AND order_row.status NOT IN ('cancelled', 'canceled', 'draft')
            AND COALESCE(NULLIF(customer.managed_by, ''), NULLIF(order_row.customer_manager_id, ''))
              IN (profile.id, profile.username, profile.auth_user_id::text)) net_sales
    ) metrics ON true WHERE search_term = '' OR profile.username ILIKE '%' || search_term || '%'
      OR profile.display_name ILIKE '%' || search_term || '%'
      OR COALESCE(profile.position, '') ILIKE '%' || search_term || '%'
  ), page AS (SELECT * FROM filtered ORDER BY is_active DESC, net_sales DESC, display_name
    LIMIT safe_limit OFFSET safe_offset)
  SELECT jsonb_build_object('total', (SELECT count(*) FROM filtered), 'limit', safe_limit,
    'offset', safe_offset, 'period', jsonb_build_object('start', p_start, 'end', p_end),
    'data', COALESCE((SELECT jsonb_agg(to_jsonb(page)
      ORDER BY is_active DESC, net_sales DESC, display_name) FROM page), '[]'::jsonb)) INTO result;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_mobile_my_access() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_mobile_admin_dashboard(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_mobile_orders_paginated(text, text, int, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_mobile_order_detail(text, text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_mobile_customers_paginated(text, int, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_mobile_customer_detail(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_mobile_customer_debts(text, int, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_mobile_customer_debt_transactions(text, int, int) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_mobile_employees(text, int, int, timestamptz, timestamptz) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.rpc_mobile_my_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_admin_dashboard(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_orders_paginated(text, text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_order_detail(text, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_customers_paginated(text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_customer_detail(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_customer_debts(text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_customer_debt_transactions(text, int, int) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_employees(text, int, int, timestamptz, timestamptz) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('legacy-mobile-0001', 'Add isolated read-only mobile Admin adapter for legacy production')
ON CONFLICT (version) DO NOTHING;

COMMIT;
