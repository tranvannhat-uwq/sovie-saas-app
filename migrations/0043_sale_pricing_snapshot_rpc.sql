BEGIN;

-- Sale needs one bounded, read-only snapshot of the global price lists that
-- Accounting explicitly enabled. Reading price_list_items directly forces the
-- customer-assignment RLS predicate to run for every price row and can time out
-- on a large matrix. This RPC bypasses that per-row policy cost without
-- broadening the result set. Dealer-specific exceptions continue to use the
-- exact-customer RPC from migration 0041.
CREATE OR REPLACE FUNCTION public.rpc_get_sale_pricing_snapshot()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role <> 'sale' THEN
    RAISE EXCEPTION '403: sale pricing snapshot is available only to Sale'
      USING ERRCODE = '42501';
  END IF;

  WITH allowed_lists AS MATERIALIZED (
    SELECT price_list.*
    FROM public.pricelists price_list
    WHERE price_list.is_active = true
      AND price_list.is_available_for_sales = true
      AND price_list.customer_id IS NULL
      AND COALESCE(price_list.price_list_type, price_list.type, 'general')
          NOT IN ('dealer_private', 'customer_specific', 'customer')
  )
  SELECT jsonb_build_object(
    'price_lists', COALESCE((
      SELECT jsonb_agg(to_jsonb(price_list) ORDER BY price_list.display_order, price_list.name)
      FROM allowed_lists price_list
    ), '[]'::jsonb),
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(item) ORDER BY item.price_list_id, item.product_id, item.variant_id)
      FROM public.price_list_items item
      JOIN allowed_lists price_list ON price_list.id = item.price_list_id
    ), '[]'::jsonb)
  ) INTO result;

  RETURN result;
END
$$;

REVOKE ALL ON FUNCTION public.rpc_get_sale_pricing_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_sale_pricing_snapshot() TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0043', 'Load Accounting-approved Sale pricing through one bounded read-only snapshot')
ON CONFLICT (version) DO NOTHING;

COMMIT;
