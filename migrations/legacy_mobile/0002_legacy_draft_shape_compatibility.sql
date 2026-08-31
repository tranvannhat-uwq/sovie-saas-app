BEGIN;

DO $patch$
DECLARE
  function_oid oid;
  definition text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='legacy-mobile-0001') THEN
    RAISE EXCEPTION 'Legacy mobile adapter 0002 requires legacy-mobile-0001';
  END IF;

  FOREACH function_oid IN ARRAY ARRAY[
    to_regprocedure('public.rpc_mobile_orders_paginated(text,text,integer,integer)'),
    to_regprocedure('public.rpc_mobile_order_detail(text,text)')
  ] LOOP
    IF function_oid IS NULL THEN RAISE EXCEPTION 'Legacy mobile order RPC is missing'; END IF;
    definition := pg_get_functiondef(function_oid);
    definition := replace(definition,
      'COALESCE(draft.order_date, draft.created_at)',
      'draft.created_at');
    definition := replace(definition,
      'COALESCE(draft.paid_amount, 0)',
      'COALESCE(NULLIF(to_jsonb(draft)->>''paid_amount'', '''')::numeric, 0)');
    EXECUTE definition;
  END LOOP;
END;
$patch$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('legacy-mobile-0002', 'Read legacy draft rows without SaaS-only order date columns')
ON CONFLICT (version) DO NOTHING;

COMMIT;
