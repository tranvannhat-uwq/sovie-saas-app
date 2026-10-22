BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_bind_login_to_workspace_domain(p_hostname text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized_hostname text := regexp_replace(
    lower(btrim(COALESCE(p_hostname, ''))), '\.+$', ''
  );
  origin_header text;
  origin_hostname text;
  active_organization_id uuid;
  platform_staff boolean := COALESCE(public.is_platform_staff(), false);
  user_has_workspace boolean;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;

  BEGIN
    origin_header := NULLIF(
      current_setting('request.headers', true)::jsonb ->> 'origin', ''
    );
  EXCEPTION WHEN invalid_text_representation THEN
    origin_header := NULL;
  END;

  IF origin_header IS NOT NULL THEN
    origin_hostname := lower(substring(
      origin_header FROM '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+)'
    ));
    IF origin_hostname IS NULL OR origin_hostname <> normalized_hostname THEN
      RETURN jsonb_build_object('allowed', false);
    END IF;
  END IF;

  IF normalized_hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$' THEN
    SELECT domain.organization_id INTO active_organization_id
    FROM public.organization_domains domain
    JOIN public.organizations organization ON organization.id = domain.organization_id
    WHERE lower(domain.hostname) = normalized_hostname
      AND domain.status = 'active'
      AND domain.ssl_status = 'active'
    LIMIT 1;
  END IF;

  IF active_organization_id IS NOT NULL THEN
    IF public.can_access_organization(active_organization_id) THEN
      IF public.has_organization_role(
        active_organization_id, ARRAY['mobile_admin_viewer']
      ) AND public.current_organization_id() IS DISTINCT FROM active_organization_id THEN
        RETURN jsonb_build_object('allowed', false);
      END IF;

      UPDATE public.organization_memberships
      SET is_default = false, updated_at = now()
      WHERE auth_user_id = auth.uid() AND is_default = true
        AND organization_id <> active_organization_id;

      UPDATE public.organization_memberships
      SET is_default = true, updated_at = now()
      WHERE auth_user_id = auth.uid()
        AND organization_id = active_organization_id
        AND status = 'active'
        AND is_default = false;

      RETURN jsonb_build_object(
        'allowed', true,
        'organizationId', active_organization_id,
        'platformOnly', false
      );
    END IF;

    IF platform_staff THEN
      RETURN jsonb_build_object(
        'allowed', true, 'organizationId', NULL, 'platformOnly', true
      );
    END IF;

    RETURN jsonb_build_object('allowed', false);
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.organization_memberships membership
    WHERE membership.auth_user_id = auth.uid() AND membership.status = 'active'
  ) INTO user_has_workspace;

  IF platform_staff THEN
    RETURN jsonb_build_object(
      'allowed', true, 'organizationId', NULL, 'platformOnly', true
    );
  END IF;

  IF user_has_workspace THEN
    RETURN jsonb_build_object('allowed', false);
  END IF;

  -- A newly authenticated user without a workspace can continue to onboarding
  -- from the main SoVie site. Tenant members must use an active workspace host.
  RETURN jsonb_build_object(
    'allowed', true, 'organizationId', NULL, 'platformOnly', false
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_bind_login_to_workspace_domain(text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_bind_login_to_workspace_domain(text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0106', 'Bind authenticated SaaS sessions to the active workspace domain')
ON CONFLICT (version) DO NOTHING;

COMMIT;
