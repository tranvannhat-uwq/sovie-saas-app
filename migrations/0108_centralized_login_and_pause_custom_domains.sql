BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations WHERE version = '0107'
  ) THEN
    RAISE EXCEPTION 'Migration 0108 requires migration 0107';
  END IF;
END;
$prerequisite$;

-- Login is now selected from the authenticated account's active memberships;
-- no workspace or custom hostname may bind a session to a single tenant.
REVOKE ALL ON FUNCTION public.rpc_bind_login_to_workspace_domain(text)
  FROM PUBLIC, anon, authenticated;

-- Pause customer-managed custom domains. Existing domain rows and provider
-- evidence remain intact, while no new request, DNS check, SSL job, or primary
-- domain change can be initiated by an authenticated customer.
REVOKE ALL ON FUNCTION public.rpc_request_custom_domain(text),
  public.rpc_my_custom_domain_verification(uuid),
  public.rpc_set_primary_custom_domain(uuid),
  public.rpc_disable_custom_domain(uuid),
  public.rpc_begin_domain_dns_verification(uuid),
  public.rpc_begin_domain_ssl_provisioning(uuid)
  FROM PUBLIC, anon, authenticated;

UPDATE public.saas_plans
SET limits = jsonb_set(COALESCE(limits, '{}'::jsonb), '{custom_domains}', '0'::jsonb, true)
WHERE COALESCE((limits->>'custom_domains')::integer, 0) <> 0;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0108', 'Centralize login on sovie.vn and pause customer-managed custom domains')
ON CONFLICT (version) DO NOTHING;

COMMIT;
