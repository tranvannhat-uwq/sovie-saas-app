BEGIN;

-- Return only the effective price list that is already saved on the selected
-- customer. SECURITY DEFINER avoids relying on broad table SELECT policies,
-- while the customer and exact-assignment checks keep the exception scoped.
CREATE OR REPLACE FUNCTION public.rpc_get_customer_assigned_pricing(
  p_customer_id text
) RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  selected_list public.pricelists%ROWTYPE;
BEGIN
  PERFORM public.require_authenticated_profile();

  IF NULLIF(btrim(p_customer_id), '') IS NULL
     OR NOT public.can_access_customer(p_customer_id) THEN
    RAISE EXCEPTION '403: customer is outside the current user scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT price_list.*
  INTO selected_list
  FROM public.customers customer
  CROSS JOIN LATERAL unnest(
    ARRAY[customer.pricelist_id, customer.default_price_list_id]
  ) WITH ORDINALITY AS assigned(reference, priority)
  JOIN public.pricelists price_list
    ON lower(btrim(assigned.reference)) IN (
      lower(btrim(price_list.id)),
      lower(btrim(COALESCE(price_list.code, ''))),
      lower(btrim(price_list.name))
    )
  WHERE customer.id = p_customer_id
    AND COALESCE(customer.status, 'active') = 'active'
    AND customer.deleted_at IS NULL
    AND NULLIF(btrim(assigned.reference), '') IS NOT NULL
    AND price_list.is_active = true
    AND (price_list.effective_from IS NULL OR price_list.effective_from <= CURRENT_DATE)
    AND (price_list.effective_to IS NULL OR price_list.effective_to >= CURRENT_DATE)
    AND public.can_use_price_list_for_customer(customer.id, price_list.id)
  ORDER BY assigned.priority,
    CASE
      WHEN lower(btrim(price_list.id)) = lower(btrim(assigned.reference)) THEN 0
      WHEN lower(btrim(COALESCE(price_list.code, ''))) = lower(btrim(assigned.reference)) THEN 1
      ELSE 2
    END,
    price_list.display_order,
    price_list.id
  LIMIT 1;

  IF selected_list.id IS NULL THEN
    RAISE EXCEPTION '403: no effective assigned price list is available for this customer'
      USING ERRCODE = '42501';
  END IF;

  RETURN jsonb_build_object(
    'price_list', to_jsonb(selected_list),
    'items', COALESCE(
      (
        SELECT jsonb_agg(to_jsonb(item) ORDER BY item.id)
        FROM public.price_list_items item
        WHERE item.price_list_id = selected_list.id
      ),
      '[]'::jsonb
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_customer_assigned_pricing(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_customer_assigned_pricing(text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0041', 'Read the exact customer-assigned pricing through a scoped RPC')
ON CONFLICT(version) DO NOTHING;

COMMIT;
