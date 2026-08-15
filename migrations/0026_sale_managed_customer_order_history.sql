BEGIN;

-- A Sale may read finalized order snapshots for dealers in the same customer
-- scope used by the customer screen. Draft ownership and every mutation rule
-- remain unchanged. Price-list visibility is still required, so this does not
-- expose an order backed by a price list that the Sale is not allowed to use.
DROP POLICY IF EXISTS orders_select ON public.orders;
CREATE POLICY orders_select ON public.orders
  FOR SELECT
  TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR (
      public.can_use_order_price_lists(pricelist_id, items)
      AND (
        created_by = auth.uid()::text
        OR salesperson_id = auth.uid()::text
        OR lower(salesperson_id) = lower(public.current_profile_username())
        OR (
          customer_id IS NOT NULL
          AND public.can_access_customer(customer_id)
        )
      )
    )
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'orders'
      AND policy.policyname = 'orders_select'
      AND policy.cmd = 'SELECT'
      AND policy.roles = ARRAY['authenticated']::name[]
      AND policy.qual LIKE '%can_use_order_price_lists(pricelist_id, items)%'
      AND policy.qual LIKE '%can_access_customer(customer_id)%'
  ) THEN
    RAISE EXCEPTION 'Migration 0026 stopped: managed-customer order policy was not verified';
  END IF;

  IF has_table_privilege('authenticated', 'public.orders', 'DELETE')
     OR has_table_privilege('authenticated', 'public.order_items', 'DELETE') THEN
    RAISE EXCEPTION 'Migration 0026 stopped: finalized-order deletion privilege was widened';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0026', 'Allow Sale to read order history for dealers in their managed customer scope')
ON CONFLICT (version) DO NOTHING;

COMMIT;
