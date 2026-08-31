BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0085') THEN
    RAISE EXCEPTION 'Migration 0086 requires migration 0085';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'saas_rpc_executor') THEN
    RAISE EXCEPTION 'Migration 0086 requires tenant RPC executor migration 0060';
  END IF;
END;
$prerequisite$;

-- Migration 0060's profile policy resolves active tenant membership, but its
-- non-login executor was not granted access to the referenced control-plane
-- table. The executor remains NOBYPASSRLS and is reachable only through
-- reviewed SECURITY DEFINER business RPCs.
GRANT SELECT ON TABLE public.organization_memberships TO saas_rpc_executor;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0086', 'Allow tenant RPC executor to resolve profile membership scope')
ON CONFLICT (version) DO NOTHING;

COMMIT;
