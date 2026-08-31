BEGIN;

ALTER TABLE public.organizations DROP CONSTRAINT IF EXISTS organizations_status_check;
ALTER TABLE public.organizations ADD CONSTRAINT organizations_status_check
  CHECK(status IN ('trialing','active','past_due','suspended','cancelled','archived'));

CREATE TABLE public.organization_archive_requests(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'requested' CHECK(status IN ('requested','cancelled','completed','rejected')),
  confirmation_slug text NOT NULL,
  backup_reference text NOT NULL,
  reason text NOT NULL DEFAULT '',
  eligible_at timestamptz NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  completed_event_key text UNIQUE,
  completed_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX organization_archive_requests_one_pending_uidx
  ON public.organization_archive_requests(organization_id) WHERE status='requested';
CREATE INDEX organization_archive_requests_org_time_idx
  ON public.organization_archive_requests(organization_id,requested_at DESC);

ALTER TABLE public.organization_archive_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organization_archive_requests FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.organization_archive_requests TO authenticated;
CREATE POLICY organization_archive_requests_owner_read ON public.organization_archive_requests
FOR SELECT TO authenticated USING(public.has_organization_role(organization_id,ARRAY['owner']));

CREATE OR REPLACE FUNCTION public.rpc_request_organization_archive(
  p_confirmation_slug text,p_backup_reference text,p_reason text DEFAULT ''
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE active_organization_id uuid:=public.current_organization_id();
DECLARE organization public.organizations%ROWTYPE;
DECLARE subscription public.organization_subscriptions%ROWTYPE;
DECLARE existing_request public.organization_archive_requests%ROWTYPE;
DECLARE created_request public.organization_archive_requests%ROWTYPE;
DECLARE normalized_backup_reference text:=btrim(COALESCE(p_backup_reference,''));
BEGIN
  IF active_organization_id IS NULL OR NOT public.has_organization_role(active_organization_id,ARRAY['owner']) THEN
    RAISE EXCEPTION '403: workspace Owner required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO organization FROM public.organizations candidate
  WHERE candidate.id=active_organization_id FOR UPDATE;
  IF lower(btrim(COALESCE(p_confirmation_slug,'')))<>lower(organization.slug) THEN
    RAISE EXCEPTION 'Type the exact workspace slug to confirm' USING ERRCODE='22023';
  END IF;
  IF char_length(normalized_backup_reference) NOT BETWEEN 8 AND 240 THEN
    RAISE EXCEPTION 'Verified backup reference is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO subscription FROM public.organization_subscriptions candidate
  WHERE candidate.organization_id=active_organization_id
  ORDER BY candidate.updated_at DESC,candidate.created_at DESC LIMIT 1 FOR UPDATE;
  IF NOT FOUND OR subscription.status<>'cancelled' OR subscription.read_only_ends_at IS NULL
    OR subscription.read_only_ends_at>now() THEN
    RAISE EXCEPTION 'Workspace can be archived only after the 30-day cancelled read-only period' USING ERRCODE='55000';
  END IF;
  SELECT * INTO existing_request FROM public.organization_archive_requests request
  WHERE request.organization_id=active_organization_id AND request.status='requested';
  IF FOUND THEN
    RETURN jsonb_build_object('requestId',existing_request.id,'duplicate',true,
      'status',existing_request.status,'eligibleAt',existing_request.eligible_at);
  END IF;
  INSERT INTO public.organization_archive_requests(
    organization_id,requested_by,confirmation_slug,backup_reference,reason,eligible_at
  ) VALUES(active_organization_id,auth.uid(),organization.slug,normalized_backup_reference,
    left(btrim(COALESCE(p_reason,'')),500),subscription.read_only_ends_at)
  RETURNING * INTO created_request;
  RETURN jsonb_build_object('requestId',created_request.id,'duplicate',false,
    'status',created_request.status,'eligibleAt',created_request.eligible_at);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_apply_organization_archive(
  p_request_id uuid,p_event_key text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,public AS $$
DECLARE request public.organization_archive_requests%ROWTYPE;
DECLARE normalized_event_key text:=btrim(COALESCE(p_event_key,''));
BEGIN
  IF auth.role()<>'service_role' THEN
    RAISE EXCEPTION '403: service role required' USING ERRCODE='42501';
  END IF;
  IF char_length(normalized_event_key) NOT BETWEEN 8 AND 240 THEN
    RAISE EXCEPTION 'Archive event key is required' USING ERRCODE='22023';
  END IF;
  SELECT * INTO request FROM public.organization_archive_requests candidate
  WHERE candidate.id=p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Archive request not found' USING ERRCODE='P0002'; END IF;
  IF request.status='completed' THEN
    RETURN jsonb_build_object('requestId',request.id,'organizationId',request.organization_id,
      'status','completed','duplicate',true);
  END IF;
  IF request.status<>'requested' OR request.eligible_at>now() THEN
    RAISE EXCEPTION 'Archive request is not executable' USING ERRCODE='55000';
  END IF;
  PERFORM 1 FROM public.organizations organization
  WHERE organization.id=request.organization_id FOR UPDATE;
  UPDATE public.organizations SET status='archived',updated_at=now()
  WHERE id=request.organization_id;
  UPDATE public.organization_memberships SET status='suspended',is_default=false,updated_at=now()
  WHERE organization_id=request.organization_id AND status<>'suspended';
  UPDATE public.organization_domains SET status='disabled',is_primary=false,updated_at=now()
  WHERE organization_id=request.organization_id AND status<>'disabled';
  UPDATE public.organization_archive_requests SET status='completed',completed_at=now(),
    completed_event_key=normalized_event_key,completed_by='service_role',updated_at=now()
  WHERE id=request.id;
  RETURN jsonb_build_object('requestId',request.id,'organizationId',request.organization_id,
    'status','completed','duplicate',false,'dataDeleted',false);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_request_organization_archive(text,text,text),
  public.rpc_apply_organization_archive(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_request_organization_archive(text,text,text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_apply_organization_archive(uuid,text) TO service_role;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0078','Add confirmed post-cancellation organization soft-archive workflow')
ON CONFLICT(version) DO NOTHING;
COMMIT;
