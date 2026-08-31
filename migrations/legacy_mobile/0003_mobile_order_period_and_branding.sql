BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='legacy-mobile-0002') THEN
    RAISE EXCEPTION 'Legacy mobile adapter 0003 requires legacy-mobile-0002';
  END IF;
END;
$prerequisite$;

CREATE OR REPLACE FUNCTION public.rpc_mobile_my_access()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  request_user_id uuid := auth.uid();
  reader_name text;
  primary_company_id text;
  primary_company_name text;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  SELECT reader.display_name INTO reader_name
  FROM public.legacy_mobile_admin_readers reader
  WHERE reader.auth_user_id = request_user_id AND reader.is_active = true;

  SELECT company.id, company.name
  INTO primary_company_id, primary_company_name
  FROM public.companies company
  WHERE lower(COALESCE(company.status, 'active')) = 'active'
  ORDER BY company.created_at, company.id
  LIMIT 1;

  IF primary_company_name IS NULL THEN
    SELECT brand.company_name
    INTO primary_company_name
    FROM public.brands brand
    WHERE btrim(COALESCE(brand.company_name, '')) <> ''
      AND lower(brand.company_name) LIKE '%emp hoa kỳ%'
    ORDER BY brand.company_name
    LIMIT 1;
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'membership_role', 'mobile_admin_viewer',
    'read_only', true,
    'company_name', COALESCE(primary_company_name, 'Sổ Việt'),
    'profile', jsonb_build_object(
      'id', request_user_id,
      'auth_user_id', request_user_id,
      'username', 'mobile_admin_viewer',
      'display_name', COALESCE(reader_name, 'Mobile Admin'),
      'role', 'admin',
      'company_id', COALESCE(primary_company_id, ''),
      'company_name', COALESCE(primary_company_name, 'Sổ Việt'),
      'is_external', false,
      'is_active', true
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_mobile_orders_by_period_paginated(
  p_search text,
  p_status text,
  p_from timestamptz,
  p_to timestamptz,
  p_limit int,
  p_offset int
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  safe_limit int := LEAST(GREATEST(COALESCE(p_limit, 20), 1), 50);
  safe_offset int := GREATEST(COALESCE(p_offset, 0), 0);
  search_term text := btrim(COALESCE(p_search, ''));
  status_filter text := lower(COALESCE(NULLIF(p_status, ''), 'all'));
  result jsonb;
BEGIN
  PERFORM public.require_legacy_mobile_admin_reader();
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'Invalid order period';
  END IF;
  IF p_to - p_from > interval '370 days' THEN
    RAISE EXCEPTION 'Order period cannot exceed 370 days';
  END IF;

  WITH combined AS (
    SELECT order_row.id, 'finalized'::text source, order_row.customer_id,
      order_row.customer_name, COALESCE(customer.phone, '') customer_phone,
      COALESCE(order_row.order_date, order_row.created_at) order_date,
      order_row.status, COALESCE(order_row.total_payable, 0) total_payable,
      COALESCE(order_row.paid_amount, 0) paid_amount,
      jsonb_array_length(COALESCE(order_row.items, '[]'::jsonb)) item_count,
      COALESCE((SELECT sum(COALESCE((item->>'quantity')::numeric, 0))
        FROM jsonb_array_elements(COALESCE(order_row.items, '[]'::jsonb)) item), 0) quantity
    FROM public.orders order_row
    LEFT JOIN public.customers customer ON customer.id = order_row.customer_id
    WHERE COALESCE(order_row.order_date, order_row.created_at) >= p_from
      AND COALESCE(order_row.order_date, order_row.created_at) < p_to

    UNION ALL

    SELECT draft.id, 'draft'::text, draft.customer_id, draft.customer_name,
      COALESCE(customer.phone, ''), draft.created_at, 'draft'::text,
      COALESCE(draft.total_payable, 0),
      COALESCE(NULLIF(to_jsonb(draft)->>'paid_amount', '')::numeric, 0),
      jsonb_array_length(COALESCE(draft.items, '[]'::jsonb)),
      COALESCE((SELECT sum(COALESCE((item->>'quantity')::numeric, 0))
        FROM jsonb_array_elements(COALESCE(draft.items, '[]'::jsonb)) item), 0)
    FROM public.draft_orders draft
    LEFT JOIN public.customers customer ON customer.id = draft.customer_id
    WHERE draft.created_at >= p_from AND draft.created_at < p_to
  ), filtered AS (
    SELECT * FROM combined row_data
    WHERE (search_term = '' OR row_data.id ILIKE '%' || search_term || '%'
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
    SELECT * FROM filtered
    ORDER BY order_date DESC, id DESC
    LIMIT safe_limit OFFSET safe_offset
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM filtered),
    'limit', safe_limit,
    'offset', safe_offset,
    'data', COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY order_date DESC, id DESC) FROM page), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_mobile_my_access() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_mobile_orders_by_period_paginated(text, text, timestamptz, timestamptz, int, int) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_my_access() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_mobile_orders_by_period_paginated(text, text, timestamptz, timestamptz, int, int) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('legacy-mobile-0003', 'Server-side order period filter and Supabase company branding for mobile')
ON CONFLICT (version) DO NOTHING;

COMMIT;
