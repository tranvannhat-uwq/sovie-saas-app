BEGIN;

CREATE TEMP TABLE provisioning_hardening_results (
  check_name text PRIMARY KEY,
  passed boolean NOT NULL,
  detail text NOT NULL
) ON COMMIT DROP;

INSERT INTO provisioning_hardening_results
SELECT 'migration_0098_applied', EXISTS (
  SELECT 1 FROM public.schema_migrations WHERE version = '0098'
), 'schema migration 0098 must be present';

INSERT INTO provisioning_hardening_results
SELECT 'slug_validation_checks_domains',
  pg_get_functiondef('public.rpc_validate_organization_slug(text)'::regprocedure)
    LIKE '%organization_domains%',
  'slug validation must reject an already-reserved workspace hostname';

INSERT INTO provisioning_hardening_results
SELECT 'capability_provisioning_is_fail_closed',
  pg_get_functiondef('public.provision_organization_capabilities(uuid,text,text)'::regprocedure)
    LIKE '%Workspace capability provisioning is incomplete%'
  AND pg_get_functiondef('public.provision_organization_capabilities(uuid,text,text)'::regprocedure)
    LIKE '%Workspace hostname is already in use%',
  'capability trigger must fail atomically on incomplete or conflicting setup';

INSERT INTO provisioning_hardening_results
SELECT 'platform_rpc_checks_complete_workspace',
  pg_get_functiondef('public.rpc_platform_provision_customer(uuid,text,text,text,integer,text,text)'::regprocedure)
    LIKE '%Workspace domain provisioning failed%'
  AND pg_get_functiondef('public.rpc_platform_provision_customer(uuid,text,text,text,integer,text,text)'::regprocedure)
    LIKE '%Workspace membership or subscription provisioning failed%',
  'platform RPC must verify domain, membership and subscription';

DO $$
DECLARE failures text;
BEGIN
  SELECT string_agg(check_name || ': ' || detail, E'\n') INTO failures
  FROM provisioning_hardening_results WHERE NOT passed;
  IF failures IS NOT NULL THEN
    RAISE EXCEPTION 'Platform customer hardening verification failed:%', E'\n' || failures;
  END IF;
END;
$$;

ROLLBACK;
