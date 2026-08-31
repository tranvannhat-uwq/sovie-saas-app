BEGIN;

-- Auth user/profile bootstrap can emit a platform audit row before the new
-- identity has an organization membership. Such rows remain invisible to all
-- tenant RLS. Authenticated business activity still requires the active tenant.
CREATE OR REPLACE FUNCTION public.enforce_business_row_organization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  is_platform_audit boolean := TG_TABLE_NAME IN ('audit_logs', 'activity_logs')
    AND auth.uid() IS NULL;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
    RAISE EXCEPTION 'organization_id is immutable'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.organization_id IS NULL THEN
    IF is_platform_audit THEN
      RETURN NEW;
    END IF;
    IF active_organization_id IS NULL THEN
      RAISE EXCEPTION 'organization_id is required'
        USING ERRCODE = '23502';
    END IF;
    NEW.organization_id := active_organization_id;
  END IF;

  IF auth.uid() IS NOT NULL
     AND (active_organization_id IS NULL
       OR NEW.organization_id <> active_organization_id) THEN
    RAISE EXCEPTION 'cross-organization write rejected'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_business_row_organization()
  FROM PUBLIC, anon, authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0059', 'Allow tenantless platform audit only during pre-membership Auth bootstrap')
ON CONFLICT (version) DO NOTHING;

COMMIT;
