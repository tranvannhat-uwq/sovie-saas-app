BEGIN;

-- Dashboard attribution follows the business owner of the data:
--   * company revenue comes from each order item's paint brand;
--   * employee revenue comes from the salesperson managing the customer.
-- The user who entered/finalized an order is intentionally not used for either.
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
        OR EXISTS (
          SELECT 1
          FROM public.order_items company_item
          WHERE company_item.order_id = sale.id
            AND COALESCE(NULLIF((
              SELECT brand.company_id
              FROM public.brands brand
              WHERE brand.id = company_item.brand_id OR brand.name = company_item.brand_id
              ORDER BY CASE WHEN brand.id = company_item.brand_id THEN 0 ELSE 1 END
              LIMIT 1
            ), ''), sale.company_id) = p_filters->>'company_id'
        ))
      AND (NULLIF(p_filters->>'customer_id', '') IS NULL OR p_filters->>'customer_id' = 'all'
        OR sale.customer_id = p_filters->>'customer_id')
      AND (actor.role = 'sale' OR NULLIF(p_filters->>'salesperson_id', '') IS NULL
        OR p_filters->>'salesperson_id' = 'all'
        OR COALESCE(NULLIF(customer.managed_by, ''), NULLIF(sale.customer_manager_id, ''), 'unassigned') = p_filters->>'salesperson_id')
  ), item_rows AS (
    SELECT item.*, sale.customer_id, sale.customer_name, sale.company_id, sale.managed_salesperson_id,
      sale.customer_manager_id, sale.order_date, sale.order_created_at,
      COALESCE(NULLIF((
        SELECT brand.company_id
        FROM public.brands brand
        WHERE brand.id = item.brand_id OR brand.name = item.brand_id
        ORDER BY CASE WHEN brand.id = item.brand_id THEN 0 ELSE 1 END
        LIMIT 1
      ), ''), sale.company_id) revenue_company_id
    FROM (
      SELECT visible.*, visible.created_at order_created_at
      FROM visible_orders visible
    ) sale
    JOIN public.order_items item ON item.order_id = sale.id
    WHERE (NULLIF(p_filters->>'brand_id', '') IS NULL OR p_filters->>'brand_id' = 'all'
      OR item.brand_id = p_filters->>'brand_id')
      AND (NULLIF(p_filters->>'company_id', '') IS NULL OR p_filters->>'company_id' = 'all'
        OR COALESCE(NULLIF((
          SELECT brand.company_id
          FROM public.brands brand
          WHERE brand.id = item.brand_id OR brand.name = item.brand_id
          ORDER BY CASE WHEN brand.id = item.brand_id THEN 0 ELSE 1 END
          LIMIT 1
        ), ''), sale.company_id) = p_filters->>'company_id')
  ), valid_returns AS (
    SELECT ret.* FROM public.sales_returns ret JOIN visible_orders sale ON sale.id = ret.sale_id
    WHERE ret.status NOT IN ('cancelled', 'canceled')
      AND COALESCE(ret.return_date, ret.created_at) >= start_at
      AND COALESCE(ret.return_date, ret.created_at) < end_at
  ), valid_payments AS (
    SELECT pay.* FROM public.payments pay
    WHERE pay.status = 'completed' AND pay.created_at >= start_at AND pay.created_at < end_at
      AND (actor.role <> 'sale' OR EXISTS (SELECT 1 FROM visible_orders sale WHERE sale.id = pay.order_id))
  ), customer_scope AS (
    SELECT customer.* FROM public.customers customer
    WHERE actor.role <> 'sale' OR customer.managed_by IN (actor.id, actor.username, actor.auth_user_id::text)
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
          AND (actor.role <> 'sale' OR EXISTS (SELECT 1 FROM customer_scope c WHERE c.id = debt.customer_id))), 0),
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

REVOKE ALL ON FUNCTION public.rpc_get_phase5_dashboard(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_phase5_dashboard(jsonb) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0033', 'Attribute dashboard company revenue by paint brand and sales by customer manager')
ON CONFLICT (version) DO NOTHING;

COMMIT;
