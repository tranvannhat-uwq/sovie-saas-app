BEGIN;

-- Sales staff may read the append-only debt ledger only for customers already
-- inside their customer scope. Financial mutations remain restricted to the
-- reviewed RPCs and finance roles.
DROP POLICY IF EXISTS customer_debt_transactions_sale_select
  ON public.customer_debt_transactions;
CREATE POLICY customer_debt_transactions_sale_select
  ON public.customer_debt_transactions
  FOR SELECT
  TO authenticated
  USING (
    public.current_profile_role() = 'sale'
    AND public.can_access_customer(customer_id)
  );

GRANT SELECT ON TABLE public.customer_debt_transactions TO authenticated;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.customer_debt_transactions FROM authenticated;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies policy
    WHERE policy.schemaname = 'public'
      AND policy.tablename = 'customer_debt_transactions'
      AND policy.policyname = 'customer_debt_transactions_sale_select'
      AND policy.cmd = 'SELECT'
      AND policy.roles = ARRAY['authenticated']::name[]
      AND policy.qual LIKE '%current_profile_role()%'
      AND policy.qual LIKE '%can_access_customer(customer_id)%'
  ) THEN
    RAISE EXCEPTION 'Migration 0024 stopped: scoped Sale debt-history policy was not verified';
  END IF;

  IF has_table_privilege('authenticated', 'public.customer_debt_transactions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.customer_debt_transactions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.customer_debt_transactions', 'DELETE') THEN
    RAISE EXCEPTION 'Migration 0024 stopped: authenticated still has direct debt-ledger mutation privileges';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0024', 'Allow Sale to read debt history only for customers in their managed scope')
ON CONFLICT (version) DO NOTHING;

COMMIT;
