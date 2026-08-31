BEGIN;

CREATE TABLE public.domain_verification_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES public.organization_domains(id) ON DELETE CASCADE,
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','verified','failed','error')),
  evidence_hash text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX domain_verification_attempts_tenant_domain_idx
  ON public.domain_verification_attempts (organization_id, domain_id, requested_at DESC);

ALTER TABLE public.domain_verification_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.domain_verification_attempts FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.domain_verification_attempts TO authenticated;
CREATE POLICY domain_verification_attempts_owner_read ON public.domain_verification_attempts
FOR SELECT TO authenticated USING (
  public.has_organization_role(organization_id, ARRAY['owner'])
);

CREATE OR REPLACE FUNCTION public.rpc_begin_domain_dns_verification(p_domain_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE active_organization_id uuid := public.current_organization_id();
DECLARE domain public.organization_domains%ROWTYPE;
DECLARE attempt public.domain_verification_attempts%ROWTYPE;
DECLARE last_attempt_at timestamptz;
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id, ARRAY['owner']) THEN
    RAISE EXCEPTION '403: workspace owner required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.organization_write_access_allowed(active_organization_id) THEN
    RAISE EXCEPTION 'Workspace is read-only for the current subscription' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.organizations organization
  WHERE organization.id = active_organization_id FOR UPDATE;
  SELECT * INTO domain FROM public.organization_domains candidate
  WHERE candidate.id = p_domain_id
    AND candidate.organization_id = active_organization_id
    AND candidate.domain_type = 'custom'
    AND candidate.status IN ('pending','failed','verified')
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Pending custom domain not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  SELECT candidate.requested_at INTO last_attempt_at
  FROM public.domain_verification_attempts candidate
  WHERE candidate.organization_id = active_organization_id
    AND candidate.domain_id = domain.id
  ORDER BY candidate.requested_at DESC LIMIT 1;
  IF last_attempt_at IS NOT NULL AND last_attempt_at > now() - interval '1 minute' THEN
    RAISE EXCEPTION 'Please wait one minute before checking DNS again' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.domain_verification_attempts (
    organization_id, domain_id, requested_by
  ) VALUES (active_organization_id, domain.id, auth.uid())
  RETURNING * INTO attempt;
  RETURN jsonb_build_object(
    'attemptId', attempt.id, 'domainId', domain.id, 'hostname', domain.hostname,
    'verification', jsonb_build_object(
      'type', 'TXT', 'name', '_sovie-verification.' || domain.hostname,
      'value', domain.verification_token
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_finish_domain_dns_verification(
  p_attempt_id uuid, p_verified boolean, p_evidence_hash text DEFAULT NULL,
  p_error boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE attempt public.domain_verification_attempts%ROWTYPE;
DECLARE result jsonb;
BEGIN
  SELECT * INTO attempt FROM public.domain_verification_attempts candidate
  WHERE candidate.id = p_attempt_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Verification attempt not found' USING ERRCODE = 'P0002'; END IF;
  IF attempt.status <> 'pending' THEN
    RETURN jsonb_build_object('duplicate', true, 'attemptId', attempt.id, 'status', attempt.status);
  END IF;
  IF COALESCE(p_error,false) THEN
    UPDATE public.domain_verification_attempts SET status='error',
      evidence_hash=NULLIF(p_evidence_hash,''), completed_at=now() WHERE id=attempt.id;
    RETURN jsonb_build_object('duplicate',false,'attemptId',attempt.id,'status','error');
  END IF;
  result := public.rpc_apply_domain_verification(
    'dns-attempt:' || attempt.id, attempt.domain_id, COALESCE(p_verified,false),
    false, 'system', p_evidence_hash
  );
  UPDATE public.domain_verification_attempts SET
    status=CASE WHEN COALESCE(p_verified,false) THEN 'verified' ELSE 'failed' END,
    evidence_hash=NULLIF(p_evidence_hash,''), completed_at=now()
  WHERE id=attempt.id;
  RETURN result || jsonb_build_object('attemptId',attempt.id,
    'dnsVerified',COALESCE(p_verified,false));
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_begin_domain_dns_verification(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_begin_domain_dns_verification(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_finish_domain_dns_verification(uuid,boolean,text,boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_finish_domain_dns_verification(uuid,boolean,text,boolean)
  TO service_role;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0073', 'Add tenant-audited and rate-limited custom domain DNS verification attempts')
ON CONFLICT (version) DO NOTHING;
COMMIT;
