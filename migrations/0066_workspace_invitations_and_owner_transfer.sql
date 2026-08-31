BEGIN;

CREATE OR REPLACE FUNCTION public.rpc_invite_organization_member(
  p_auth_user_id uuid,
  p_role text DEFAULT 'sale'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  added jsonb;
BEGIN
  -- rpc_add_organization_member owns role checks, profile validation, quota
  -- serialization and tenant derivation.
  added := public.rpc_add_organization_member(p_auth_user_id, p_role);

  UPDATE public.organization_memberships
  SET status = 'invited', is_default = false, joined_at = NULL,
      invited_by = auth.uid(), updated_at = now()
  WHERE organization_id = active_organization_id
    AND auth_user_id = p_auth_user_id;

  RETURN added || jsonb_build_object('status', 'invited');
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_accept_my_organization_invitations()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  accepted_count integer := 0;
  default_organization_id uuid;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;

  UPDATE public.organization_memberships
  SET status = 'active', joined_at = COALESCE(joined_at, now()), updated_at = now()
  WHERE auth_user_id = auth.uid() AND status = 'invited';
  GET DIAGNOSTICS accepted_count = ROW_COUNT;

  IF accepted_count > 0 AND NOT EXISTS (
    SELECT 1 FROM public.organization_memberships membership
    WHERE membership.auth_user_id = auth.uid()
      AND membership.status = 'active' AND membership.is_default
  ) THEN
    SELECT membership.organization_id INTO default_organization_id
    FROM public.organization_memberships membership
    WHERE membership.auth_user_id = auth.uid() AND membership.status = 'active'
    ORDER BY membership.joined_at DESC NULLS LAST, membership.created_at
    LIMIT 1;

    UPDATE public.organization_memberships
    SET is_default = true, updated_at = now()
    WHERE auth_user_id = auth.uid()
      AND organization_id = default_organization_id
      AND status = 'active';
  END IF;

  RETURN jsonb_build_object(
    'acceptedCount', accepted_count,
    'defaultOrganizationId', default_organization_id
  );
END;
$$;

-- Early legacy backfill could produce more than one Owner in a workspace.
-- Preserve the default/oldest Owner and demote only additional Owners before
-- enforcing the single-owner invariant.
WITH ranked_owners AS (
  SELECT membership.id,
    row_number() OVER (
      PARTITION BY membership.organization_id
      ORDER BY membership.is_default DESC, membership.created_at, membership.id
    ) AS owner_rank
  FROM public.organization_memberships membership
  WHERE membership.role = 'owner' AND membership.status = 'active'
)
UPDATE public.organization_memberships membership
SET role = 'admin', updated_at = now()
FROM ranked_owners ranked
WHERE membership.id = ranked.id AND ranked.owner_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS organization_memberships_one_active_owner_uidx
  ON public.organization_memberships (organization_id)
  WHERE role = 'owner' AND status = 'active';

CREATE OR REPLACE FUNCTION public.rpc_transfer_organization_ownership(
  p_target_auth_user_id uuid
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  target_membership public.organization_memberships%ROWTYPE;
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id, ARRAY['owner']) THEN
    RAISE EXCEPTION '403: workspace owner required' USING ERRCODE = '42501';
  END IF;
  IF p_target_auth_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Target member is already the workspace owner' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.organizations organization
  WHERE organization.id = active_organization_id FOR UPDATE;

  SELECT * INTO target_membership
  FROM public.organization_memberships membership
  WHERE membership.organization_id = active_organization_id
    AND membership.auth_user_id = p_target_auth_user_id
    AND membership.status = 'active'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Active target member not found in this workspace' USING ERRCODE = 'P0002';
  END IF;

  UPDATE public.organization_memberships
  SET role = 'admin', updated_at = now()
  WHERE organization_id = active_organization_id
    AND auth_user_id = auth.uid() AND role = 'owner' AND status = 'active';

  UPDATE public.organization_memberships
  SET role = 'owner', updated_at = now()
  WHERE id = target_membership.id;

  RETURN jsonb_build_object(
    'organizationId', active_organization_id,
    'previousOwnerAuthUserId', auth.uid(),
    'ownerAuthUserId', p_target_auth_user_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_invite_organization_member(uuid,text),
  public.rpc_accept_my_organization_invitations(),
  public.rpc_transfer_organization_ownership(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_invite_organization_member(uuid,text),
  public.rpc_accept_my_organization_invitations(),
  public.rpc_transfer_organization_ownership(uuid)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0066', 'Add email invitation acceptance and transactional workspace Owner transfer')
ON CONFLICT (version) DO NOTHING;

COMMIT;
