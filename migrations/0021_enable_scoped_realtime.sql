BEGIN;

-- Realtime is transport metadata only. This migration does not insert, update,
-- delete or rewrite any business row. Existing RLS policies remain authoritative
-- for which change events each authenticated user may receive.
DO $migration$
DECLARE
  target_table text;
  realtime_tables text[] := ARRAY[
    'orders',
    'draft_orders',
    'customers',
    'customer_debt_transactions',
    'cashbook_transactions',
    'starting_balances',
    'sales_returns',
    'sales_return_items',
    'products',
    'pricelists',
    'price_list_items',
    'brands'
  ];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    EXECUTE 'CREATE PUBLICATION supabase_realtime';
  END IF;

  FOREACH target_table IN ARRAY realtime_tables LOOP
    IF to_regclass(format('public.%I', target_table)) IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
         FROM pg_catalog.pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = 'public'
           AND tablename = target_table
       ) THEN
      EXECUTE format(
        'ALTER PUBLICATION supabase_realtime ADD TABLE public.%I',
        target_table
      );
    END IF;
  END LOOP;
END;
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0021', 'Enable RLS-scoped realtime change delivery for active screens')
ON CONFLICT (version) DO NOTHING;

COMMIT;
