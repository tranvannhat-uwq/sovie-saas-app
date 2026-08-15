BEGIN;

-- The customer editor and legacy imports write customers.pricelist_id. The
-- duplicated default_price_list_id may still contain an older assignment on
-- upgraded rows. Make authoritative order pricing use the current, user-visible
-- selection first while retaining the duplicate as a compatibility fallback.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
  old_priority text := 'ARRAY[customer_row.default_price_list_id, customer_row.pricelist_id]';
  new_priority text := 'ARRAY[customer_row.pricelist_id, customer_row.default_price_list_id]';
BEGIN
  SELECT pg_get_functiondef('public.p1_resolve_order_price_list(text, text)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0031 stopped: p1_resolve_order_price_list(text, text) is missing';
  END IF;

  IF current_definition NOT LIKE '%' || new_priority || '%' THEN
    patched_definition := replace(current_definition, old_priority, new_priority);
    IF patched_definition = current_definition THEN
      RAISE EXCEPTION 'Migration 0031 stopped: customer price-list priority anchor was not found';
    END IF;
    EXECUTE patched_definition;
  END IF;
END
$migration$;

ALTER FUNCTION public.p1_resolve_order_price_list(text, text) SECURITY DEFINER;
ALTER FUNCTION public.p1_resolve_order_price_list(text, text)
  SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.p1_resolve_order_price_list(text, text)
  FROM PUBLIC, anon, authenticated;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'p1_resolve_order_price_list'
      AND pg_get_function_identity_arguments(procedure.oid) = 'p_customer_id text, p_requested_id text'
      AND procedure.prosrc LIKE '%ARRAY[customer_row.pricelist_id, customer_row.default_price_list_id]%'
      AND procedure.prosrc LIKE '%public.can_use_price_list(price_list.id)%'
      AND procedure.prosrc LIKE '%public.p1_price_list_is_effective(price_list)%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0031 stopped: secured customer price-list priority patch was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0031', 'Align authoritative order pricing with the customer-form price list')
ON CONFLICT (version) DO NOTHING;

COMMIT;
