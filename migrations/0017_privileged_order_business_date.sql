BEGIN;

-- Preserve the real sale day when Admin/Accounting enters weekend or holiday
-- orders later. Posting/audit timestamps remain the actual confirmation time.
-- Sales users cannot forge a historical date: their payload date is ignored.
DO $migration$
DECLARE
  current_definition text;
  patched_definition text;
BEGIN
  SELECT pg_get_functiondef('public.rpc_confirm_order(jsonb)'::regprocedure)
  INTO current_definition;

  IF current_definition IS NULL THEN
    RAISE EXCEPTION 'Migration 0017 stopped: rpc_confirm_order(jsonb) is missing';
  END IF;

  IF current_definition LIKE '%business_date timestamptz;%' THEN
    RETURN;
  END IF;

  patched_definition := replace(
    current_definition,
    'item_index integer := 0;',
    E'item_index integer := 0;\n  business_date timestamptz;'
  );
  IF patched_definition = current_definition THEN
    RAISE EXCEPTION 'Migration 0017 stopped: declaration anchor was not found';
  END IF;

  current_definition := patched_definition;
  patched_definition := regexp_replace(
    current_definition,
    '(actor[[:space:]]*:=[[:space:]]*public\.require_authenticated_profile\(\);)',
    E'\\1\n\n  business_date := now();\n  IF actor.role IN (''admin'', ''accounting'') AND NULLIF(btrim(p_order->>''date''), '''') IS NOT NULL THEN\n    business_date := (p_order->>''date'')::timestamptz;\n    IF business_date > now() THEN\n      RAISE EXCEPTION ''Order date cannot be in the future'';\n    END IF;\n  END IF;'
  );
  IF patched_definition = current_definition THEN
    RAISE EXCEPTION 'Migration 0017 stopped: actor/date anchor was not found';
  END IF;

  current_definition := patched_definition;
  patched_definition := regexp_replace(
    current_definition,
    '(actor\.auth_user_id::text[[:space:]]*,[[:space:]]*actor\.auth_user_id::text[[:space:]]*,[[:space:]]*''settled''[[:space:]]*,)[[:space:]]*now\(\)[[:space:]]*,[[:space:]]*now\(\)[[:space:]]*,[[:space:]]*now\(\)[[:space:]]*,[[:space:]]*now\(\)',
    E'\\1 business_date, now(), now(), now()'
  );
  IF patched_definition = current_definition THEN
    RAISE EXCEPTION 'Migration 0017 stopped: order timestamp anchor was not found';
  END IF;

  current_definition := patched_definition;
  patched_definition := regexp_replace(
    current_definition,
    '(actor\.auth_user_id::text[[:space:]]*,)[[:space:]]*now\(\)([[:space:]]*\);[[:space:]]*UPDATE public\.customers)',
    E'\\1 business_date\\2'
  );
  IF patched_definition = current_definition THEN
    RAISE EXCEPTION 'Migration 0017 stopped: debt date anchor was not found';
  END IF;

  current_definition := patched_definition;
  patched_definition := regexp_replace(
    current_definition,
    'last_order_at[[:space:]]*=[[:space:]]*now\(\)[[:space:]]*,[[:space:]]*updated_at[[:space:]]*=[[:space:]]*now\(\)[[:space:]]*,[[:space:]]*updated_by[[:space:]]*=[[:space:]]*actor\.auth_user_id::text',
    E'last_order_at = GREATEST(COALESCE(last_order_at, business_date), business_date),\n        updated_at = now(), updated_by = actor.auth_user_id::text'
  );
  IF patched_definition = current_definition THEN
    RAISE EXCEPTION 'Migration 0017 stopped: customer last-order anchor was not found';
  END IF;

  EXECUTE patched_definition;
END
$migration$;

ALTER FUNCTION public.rpc_confirm_order(jsonb) SECURITY DEFINER;
ALTER FUNCTION public.rpc_confirm_order(jsonb) SET search_path = pg_catalog, public;
REVOKE ALL ON FUNCTION public.rpc_confirm_order(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO authenticated;

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'rpc_confirm_order'
      AND pg_get_function_identity_arguments(procedure.oid) = 'p_order jsonb'
      AND procedure.prosrc LIKE '%business_date timestamptz;%'
      AND procedure.prosrc LIKE '%actor.role IN (''admin'', ''accounting'')%'
      AND procedure.prosrc ~ '''settled''[[:space:]]*,[[:space:]]*business_date[[:space:]]*,[[:space:]]*now\(\)[[:space:]]*,[[:space:]]*now\(\)[[:space:]]*,[[:space:]]*now\(\)'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0017 stopped: secured business-date patch was not verified';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0017', 'Allow privileged historical order business dates without changing audit time')
ON CONFLICT (version) DO NOTHING;

COMMIT;
