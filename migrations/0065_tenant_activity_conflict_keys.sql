BEGIN;

-- Migration 0058 tenant-scoped the activity_logs unique key. These three
-- trigger functions were created earlier and still referenced the legacy
-- four-column conflict target, causing audited business updates to fail.
DO $rewrite_activity_conflicts$
DECLARE
  function_name text;
  function_definition text;
BEGIN
  FOREACH function_name IN ARRAY ARRAY[
    'public.p36_log_activity_row()',
    'public.p37_log_draft_activity()',
    'public.p52_log_price_change()'
  ] LOOP
    SELECT pg_get_functiondef(function_name::regprocedure)
    INTO function_definition;

    function_definition := regexp_replace(
      function_definition,
      'ON\s+CONFLICT\s*\(\s*operation_key\s*,\s*module\s*,\s*target_type\s*,\s*target_id\s*\)',
      'ON CONFLICT (organization_id, operation_key, module, target_type, target_id)',
      'gi'
    );

    IF function_definition !~* 'ON\s+CONFLICT\s*\(\s*organization_id\s*,\s*operation_key' THEN
      RAISE EXCEPTION 'Could not tenant-scope activity conflict target in %', function_name;
    END IF;
    EXECUTE function_definition;
  END LOOP;
END;
$rewrite_activity_conflicts$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0065', 'Align activity trigger conflict targets with tenant-scoped unique key')
ON CONFLICT (version) DO NOTHING;

COMMIT;
