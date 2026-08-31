BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_my_organization_members()
RETURNS TABLE (
  membership_id uuid,
  auth_user_id uuid,
  profile_id text,
  username text,
  display_name text,
  role text,
  status text,
  is_default boolean,
  company_id text,
  joined_at timestamptz
)
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE active_organization_id uuid := public.current_organization_id();
BEGIN
  IF active_organization_id IS NULL THEN
    RAISE EXCEPTION '403: active organization membership required' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT membership.id, membership.auth_user_id, profile.id::text,
    profile.username, profile.display_name, membership.role, membership.status,
    membership.is_default, profile.company_id, membership.joined_at
  FROM public.organization_memberships membership
  JOIN public.profiles profile ON profile.auth_user_id = membership.auth_user_id
  WHERE membership.organization_id = active_organization_id
  ORDER BY CASE membership.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
    WHEN 'accounting' THEN 2 ELSE 3 END, profile.display_name, profile.username;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_add_organization_member(
  p_auth_user_id uuid,
  p_role text DEFAULT 'sale'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  normalized_role text := lower(btrim(COALESCE(p_role, 'sale')));
  member_limit integer;
  member_count integer;
  result public.organization_memberships%ROWTYPE;
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id, ARRAY['owner','admin']) THEN
    RAISE EXCEPTION '403: workspace owner or admin required' USING ERRCODE = '42501';
  END IF;
  IF normalized_role NOT IN ('admin','accounting','sale') THEN
    RAISE EXCEPTION 'Unsupported member role' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles profile
    WHERE profile.auth_user_id = p_auth_user_id AND profile.is_active = true
  ) THEN
    RAISE EXCEPTION 'Active Auth-linked profile required' USING ERRCODE = '22023';
  END IF;

  -- Serialize member additions for this workspace so concurrent requests
  -- cannot both pass the same plan quota.
  PERFORM 1 FROM public.organizations organization
  WHERE organization.id = active_organization_id FOR UPDATE;

  SELECT COALESCE((plan.limits->>'users')::integer, 5)
  INTO member_limit
  FROM public.organization_subscriptions subscription
  JOIN public.saas_plans plan ON plan.id = subscription.plan_id
  WHERE subscription.organization_id = active_organization_id
    AND subscription.status IN ('trialing','active','past_due','paused')
  ORDER BY subscription.created_at DESC LIMIT 1;
  member_limit := COALESCE(member_limit, 5);

  SELECT count(*) INTO member_count
  FROM public.organization_memberships membership
  WHERE membership.organization_id = active_organization_id
    AND membership.status IN ('active','invited');

  IF member_count >= member_limit AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships membership
    WHERE membership.organization_id = active_organization_id
      AND membership.auth_user_id = p_auth_user_id
      AND membership.status IN ('active','invited')
  ) THEN
    RAISE EXCEPTION 'Workspace member limit reached (% users)', member_limit
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.organization_memberships (
    organization_id, auth_user_id, role, status, is_default,
    invited_by, joined_at, updated_at
  ) VALUES (
    active_organization_id, p_auth_user_id, normalized_role, 'active', false,
    auth.uid(), now(), now()
  )
  ON CONFLICT (organization_id, auth_user_id) DO UPDATE
  SET role = EXCLUDED.role, status = 'active', invited_by = auth.uid(),
      joined_at = COALESCE(organization_memberships.joined_at, now()), updated_at = now()
  RETURNING * INTO result;

  RETURN jsonb_build_object(
    'membershipId', result.id,
    'organizationId', result.organization_id,
    'authUserId', result.auth_user_id,
    'role', result.role,
    'status', result.status,
    'memberLimit', member_limit
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_update_organization_member(
  p_auth_user_id uuid,
  p_role text,
  p_status text,
  p_display_name text DEFAULT NULL,
  p_company_id text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  normalized_role text := lower(btrim(COALESCE(p_role, '')));
  normalized_status text := lower(btrim(COALESCE(p_status, '')));
  target public.organization_memberships%ROWTYPE;
  actor_role text;
  member_limit integer;
  member_count integer;
BEGIN
  IF active_organization_id IS NULL THEN
    RAISE EXCEPTION '403: active organization membership required' USING ERRCODE = '42501';
  END IF;
  SELECT membership.role INTO actor_role
  FROM public.organization_memberships membership
  WHERE membership.organization_id = active_organization_id
    AND membership.auth_user_id = auth.uid() AND membership.status = 'active';
  IF actor_role NOT IN ('owner','admin') THEN
    RAISE EXCEPTION '403: workspace owner or admin required' USING ERRCODE = '42501';
  END IF;
  IF normalized_role NOT IN ('admin','accounting','sale') THEN
    RAISE EXCEPTION 'Unsupported member role' USING ERRCODE = '22023';
  END IF;
  IF normalized_status NOT IN ('active','suspended') THEN
    RAISE EXCEPTION 'Unsupported member status' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO target FROM public.organization_memberships membership
  WHERE membership.organization_id = active_organization_id
    AND membership.auth_user_id = p_auth_user_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Workspace member not found' USING ERRCODE = 'P0002';
  END IF;
  IF target.role = 'owner' THEN
    RAISE EXCEPTION 'Workspace owner cannot be changed by member management' USING ERRCODE = '42501';
  END IF;
  IF p_auth_user_id = auth.uid() AND normalized_status <> 'active' THEN
    RAISE EXCEPTION 'You cannot suspend your own active membership' USING ERRCODE = '42501';
  END IF;

  IF target.status = 'suspended' AND normalized_status = 'active' THEN
    PERFORM 1 FROM public.organizations organization
    WHERE organization.id = active_organization_id FOR UPDATE;
    SELECT COALESCE((plan.limits->>'users')::integer, 5)
    INTO member_limit
    FROM public.organization_subscriptions subscription
    JOIN public.saas_plans plan ON plan.id = subscription.plan_id
    WHERE subscription.organization_id = active_organization_id
      AND subscription.status IN ('trialing','active','past_due','paused')
    ORDER BY subscription.created_at DESC LIMIT 1;
    member_limit := COALESCE(member_limit, 5);
    SELECT count(*) INTO member_count
    FROM public.organization_memberships membership
    WHERE membership.organization_id = active_organization_id
      AND membership.status IN ('active','invited');
    IF member_count >= member_limit THEN
      RAISE EXCEPTION 'Workspace member limit reached (% users)', member_limit USING ERRCODE = 'P0001';
    END IF;
  END IF;

  UPDATE public.organization_memberships
  SET role = normalized_role, status = normalized_status,
      is_default = CASE WHEN normalized_status = 'active' THEN is_default ELSE false END,
      joined_at = CASE WHEN normalized_status = 'active' THEN COALESCE(joined_at, now()) ELSE joined_at END,
      updated_at = now()
  WHERE id = target.id;

  IF p_display_name IS NOT NULL OR p_company_id IS NOT NULL THEN
    UPDATE public.profiles
    SET display_name = COALESCE(NULLIF(btrim(p_display_name), ''), display_name),
        company_id = COALESCE(NULLIF(btrim(p_company_id), ''), company_id),
        updated_at = now()
    WHERE auth_user_id = p_auth_user_id;
  END IF;

  RETURN jsonb_build_object(
    'membershipId', target.id, 'authUserId', p_auth_user_id,
    'role', normalized_role, 'status', normalized_status
  );
END;
$$;

-- A profile is a global Auth identity. Browser reads must be limited to the
-- caller and identities sharing the caller's active workspace.
DROP POLICY IF EXISTS profiles_select ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_insert ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_update ON public.profiles;
DROP POLICY IF EXISTS profiles_admin_delete ON public.profiles;
CREATE POLICY profiles_tenant_select ON public.profiles
FOR SELECT TO authenticated USING (
  auth_user_id = auth.uid()
  OR EXISTS (
    SELECT 1
    FROM public.organization_memberships caller_membership
    JOIN public.organization_memberships target_membership
      ON target_membership.organization_id = caller_membership.organization_id
     AND target_membership.auth_user_id = profiles.auth_user_id
     AND target_membership.status IN ('active','suspended')
    WHERE caller_membership.auth_user_id = auth.uid()
      AND caller_membership.organization_id = public.current_organization_id()
      AND caller_membership.status = 'active'
      AND caller_membership.role IN ('owner','admin','accounting')
  )
);
REVOKE INSERT, UPDATE, DELETE ON public.profiles FROM authenticated;
GRANT SELECT ON public.profiles TO authenticated;

REVOKE ALL ON FUNCTION public.rpc_my_organization_members(),
  public.rpc_add_organization_member(uuid,text),
  public.rpc_update_organization_member(uuid,text,text,text,text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_my_organization_members(),
  public.rpc_add_organization_member(uuid,text),
  public.rpc_update_organization_member(uuid,text,text,text,text)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0064', 'Add tenant-safe workspace member listing, quota, roles and suspension')
ON CONFLICT (version) DO NOTHING;

COMMIT;
