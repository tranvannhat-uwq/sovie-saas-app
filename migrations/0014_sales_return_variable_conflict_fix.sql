BEGIN;

-- PostgreSQL reports `order_id` as ambiguous inside rpc_record_sales_return
-- because the Phase 3 function used the same name for a local variable and
-- several table columns. Patch only the recognized declaration/references;
-- monetary, debt, cashbook and commission formulas remain unchanged.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_record_sales_return(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0014 stopped: rpc_record_sales_return(jsonb) is missing';
  END IF;

  IF current_definition LIKE '%target_order_id text :=%' THEN
    RETURN;
  END IF;

  IF current_definition NOT LIKE '%order_id text := NULLIF(btrim(p_input->>''orderId''), '''')%'
     OR current_definition NOT LIKE '%FROM public.orders WHERE id = order_id FOR UPDATE%'
     OR current_definition NOT LIKE '%WHERE id = item_id AND order_id = sale.id FOR UPDATE%' THEN
    RAISE EXCEPTION 'Migration 0014 stopped: rpc_record_sales_return declaration was not recognized';
  END IF;

  patched_definition := replace(
    current_definition,
    'order_id text := NULLIF(btrim(p_input->>''orderId''), '''')',
    'target_order_id text := NULLIF(btrim(p_input->>''orderId''), '''')'
  );
  patched_definition := replace(patched_definition,
    'IF order_id IS NULL OR reason IS NULL',
    'IF target_order_id IS NULL OR reason IS NULL');
  patched_definition := replace(patched_definition,
    '''orderId'', order_id, ''reason''',
    '''orderId'', target_order_id, ''reason''');
  patched_definition := replace(patched_definition,
    'SELECT * INTO STRICT sale FROM public.orders WHERE id = order_id FOR UPDATE;',
    'SELECT * INTO STRICT sale FROM public.orders sale_source WHERE sale_source.id = target_order_id FOR UPDATE;');
  patched_definition := replace(patched_definition,
    'WHERE id = item_id AND order_id = sale.id FOR UPDATE;',
    'WHERE public.order_items.id = item_id AND public.order_items.order_id = sale.id FOR UPDATE;');

  IF patched_definition = current_definition
     OR patched_definition NOT LIKE '%target_order_id text :=%'
     OR patched_definition LIKE '%FROM public.orders WHERE id = order_id FOR UPDATE%'
     OR patched_definition LIKE '%WHERE id = item_id AND order_id = sale.id FOR UPDATE%' THEN
    RAISE EXCEPTION 'Migration 0014 stopped: sales return patch was incomplete';
  END IF;

  EXECUTE patched_definition;
END
$migration$;

ALTER FUNCTION public.rpc_record_sales_return(jsonb) SECURITY DEFINER;
ALTER FUNCTION public.rpc_record_sales_return(jsonb) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.rpc_record_sales_return(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_record_sales_return(jsonb) TO authenticated;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'rpc_record_sales_return'
      AND pg_get_function_identity_arguments(procedure.oid) = 'p_input jsonb'
      AND procedure.prosrc LIKE '%target_order_id text :=%'
      AND procedure.prosrc LIKE '%sale_source.id = target_order_id%'
      AND procedure.prosrc LIKE '%public.order_items.order_id = sale.id%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0014 stopped: secured sales return patch was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0014', 'Resolve rpc_record_sales_return order_id variable conflict')
ON CONFLICT (version) DO NOTHING;

COMMIT;

