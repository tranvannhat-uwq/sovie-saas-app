BEGIN;

-- A legacy root-level migration installed this trigger before the ordered
-- migration chain existed. Its original implementation checked only the
-- global Sale toggle and therefore rejected a list even when that exact list
-- was assigned to the order's customer. Keep the trigger as defence in depth,
-- but make it use the customer-scoped authorization introduced by 0040.
CREATE OR REPLACE FUNCTION public.reject_forbidden_order_price_lists()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF public.current_profile_role() = 'sale'
     AND NOT public.can_use_order_price_lists_for_customer(
       NEW.customer_id,
       NEW.pricelist_id,
       NEW.items
     ) THEN
    RAISE EXCEPTION '403: price list % is not available for this customer', NEW.pricelist_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.reject_forbidden_order_price_lists()
  FROM PUBLIC, anon, authenticated;

-- Recreate both legacy triggers so changing the customer or item-level price
-- list is checked too, not only a change to the order-level price list.
DROP TRIGGER IF EXISTS trg_orders_reject_forbidden_price_list ON public.orders;
CREATE TRIGGER trg_orders_reject_forbidden_price_list
  BEFORE INSERT OR UPDATE OF customer_id, pricelist_id, items ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.reject_forbidden_order_price_lists();

DROP TRIGGER IF EXISTS trg_draft_orders_reject_forbidden_price_list ON public.draft_orders;
CREATE TRIGGER trg_draft_orders_reject_forbidden_price_list
  BEFORE INSERT OR UPDATE OF customer_id, pricelist_id, items ON public.draft_orders
  FOR EACH ROW EXECUTE FUNCTION public.reject_forbidden_order_price_lists();

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'reject_forbidden_order_price_lists'
      AND procedure.prosrc LIKE '%can_use_order_price_lists_for_customer%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0053 stopped: customer-scoped trigger verification failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    JOIN pg_class table_row ON table_row.oid = trigger_row.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = table_row.relnamespace
    WHERE namespace.nspname = 'public'
      AND table_row.relname = 'draft_orders'
      AND trigger_row.tgname = 'trg_draft_orders_reject_forbidden_price_list'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'Migration 0053 stopped: draft trigger verification failed';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0053', 'Repair legacy order trigger to honor exact customer-assigned Sale price lists')
ON CONFLICT (version) DO NOTHING;

COMMIT;
