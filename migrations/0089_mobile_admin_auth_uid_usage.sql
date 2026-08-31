BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = '0088') THEN
    RAISE EXCEPTION 'Migration 0089 requires migration 0088';
  END IF;
END;
$prerequisite$;

-- require_mobile_admin_reader() is owned by the non-login, NOBYPASSRLS
-- executor and calls auth.uid(). USAGE permits resolving that function only;
-- it does not grant access to auth.users or any other Auth table.
GRANT USAGE ON SCHEMA auth TO saas_rpc_executor;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0089', 'Allow mobile read executor to resolve auth.uid')
ON CONFLICT (version) DO NOTHING;

COMMIT;
