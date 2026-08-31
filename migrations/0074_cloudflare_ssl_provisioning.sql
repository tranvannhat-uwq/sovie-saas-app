BEGIN;

ALTER TABLE public.organization_domains
  ADD COLUMN IF NOT EXISTS provider text,
  ADD COLUMN IF NOT EXISTS provider_hostname_id text,
  ADD COLUMN IF NOT EXISTS provider_status text,
  ADD COLUMN IF NOT EXISTS provider_ssl_status text,
  ADD COLUMN IF NOT EXISTS provider_updated_at timestamptz;
CREATE UNIQUE INDEX organization_domains_provider_hostname_uidx
  ON public.organization_domains(provider,provider_hostname_id)
  WHERE provider IS NOT NULL AND provider_hostname_id IS NOT NULL;

CREATE TABLE public.domain_provisioning_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES public.organization_domains(id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'cloudflare' CHECK (provider IN ('cloudflare')),
  operation text NOT NULL CHECK (operation IN ('create','sync')),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','processing','waiting','succeeded','failed')),
  requested_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
CREATE INDEX domain_provisioning_jobs_tenant_idx
  ON public.domain_provisioning_jobs(organization_id,domain_id,created_at DESC);
CREATE UNIQUE INDEX domain_provisioning_jobs_one_open_uidx
  ON public.domain_provisioning_jobs(domain_id) WHERE status IN ('queued','processing');

CREATE TABLE public.domain_provisioning_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES public.organization_domains(id) ON DELETE CASCADE,
  job_id uuid NOT NULL REFERENCES public.domain_provisioning_jobs(id) ON DELETE CASCADE,
  event_key text NOT NULL UNIQUE,
  provider text NOT NULL,
  hostname_status text,
  ssl_status text,
  evidence_hash text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domain_provisioning_events_tenant_idx
  ON public.domain_provisioning_events(organization_id,domain_id,created_at DESC);

ALTER TABLE public.domain_provisioning_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.domain_provisioning_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.domain_provisioning_jobs,public.domain_provisioning_events
  FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.domain_provisioning_jobs,public.domain_provisioning_events TO authenticated;
CREATE POLICY domain_provisioning_jobs_owner_read ON public.domain_provisioning_jobs
FOR SELECT TO authenticated USING(public.has_organization_role(organization_id,ARRAY['owner']));
CREATE POLICY domain_provisioning_events_owner_read ON public.domain_provisioning_events
FOR SELECT TO authenticated USING(public.has_organization_role(organization_id,ARRAY['owner']));

CREATE OR REPLACE FUNCTION public.rpc_begin_domain_ssl_provisioning(p_domain_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE active_organization_id uuid:=public.current_organization_id();
DECLARE domain public.organization_domains%ROWTYPE;
DECLARE job public.domain_provisioning_jobs%ROWTYPE;
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id,ARRAY['owner']) THEN
    RAISE EXCEPTION '403: workspace owner required' USING ERRCODE='42501';
  END IF;
  IF NOT public.organization_write_access_allowed(active_organization_id) THEN
    RAISE EXCEPTION 'Workspace is read-only for the current subscription' USING ERRCODE='42501';
  END IF;
  PERFORM 1 FROM public.organizations organization WHERE organization.id=active_organization_id FOR UPDATE;
  SELECT * INTO domain FROM public.organization_domains candidate
  WHERE candidate.id=p_domain_id AND candidate.organization_id=active_organization_id
    AND candidate.domain_type='custom' AND candidate.status IN ('verified','active')
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'DNS-verified custom domain required' USING ERRCODE='P0002'; END IF;
  SELECT * INTO job FROM public.domain_provisioning_jobs candidate
  WHERE candidate.domain_id=domain.id AND candidate.status IN ('queued','processing') LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('jobId',job.id,'duplicate',true,'operation',job.operation,
      'organizationId',active_organization_id,'hostname',domain.hostname,
      'providerHostnameId',domain.provider_hostname_id);
  END IF;
  INSERT INTO public.domain_provisioning_jobs(
    organization_id,domain_id,operation,requested_by
  ) VALUES(active_organization_id,domain.id,
    CASE WHEN domain.provider_hostname_id IS NULL THEN 'create' ELSE 'sync' END,auth.uid())
  RETURNING * INTO job;
  RETURN jsonb_build_object('jobId',job.id,'duplicate',false,'operation',job.operation,
    'organizationId',active_organization_id,'hostname',domain.hostname,
    'providerHostnameId',domain.provider_hostname_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_finish_domain_ssl_provisioning(
  p_job_id uuid,p_event_key text,p_provider_hostname_id text,
  p_hostname_status text,p_ssl_status text,p_evidence_hash text DEFAULT NULL,
  p_error_message text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.domain_provisioning_jobs%ROWTYPE;
DECLARE domain public.organization_domains%ROWTYPE;
DECLARE normalized_event_key text:=btrim(COALESCE(p_event_key,''));
DECLARE hostname_ready boolean:=lower(COALESCE(p_hostname_status,''))='active';
DECLARE ssl_ready boolean:=lower(COALESCE(p_ssl_status,''))='active';
DECLARE verification_result jsonb;
BEGIN
  IF char_length(normalized_event_key) NOT BETWEEN 4 AND 240 THEN
    RAISE EXCEPTION 'Provisioning event key required' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM public.domain_provisioning_events event WHERE event.event_key=normalized_event_key) THEN
    RETURN jsonb_build_object('duplicate',true,'eventKey',normalized_event_key);
  END IF;
  SELECT * INTO job FROM public.domain_provisioning_jobs candidate WHERE candidate.id=p_job_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Provisioning job not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO domain FROM public.organization_domains candidate WHERE candidate.id=job.domain_id FOR UPDATE;
  IF job.status NOT IN ('queued','processing') THEN
    RETURN jsonb_build_object('duplicate',true,'jobId',job.id,'status',job.status);
  END IF;
  UPDATE public.organization_domains SET provider='cloudflare',
    provider_hostname_id=COALESCE(NULLIF(p_provider_hostname_id,''),provider_hostname_id),
    provider_status=NULLIF(lower(COALESCE(p_hostname_status,'')),''),
    provider_ssl_status=NULLIF(lower(COALESCE(p_ssl_status,'')),''),
    provider_updated_at=now(),updated_at=now()
  WHERE id=domain.id;
  IF p_error_message IS NULL AND hostname_ready AND ssl_ready THEN
    verification_result:=public.rpc_apply_domain_verification(
      'cloudflare-job:'||job.id,domain.id,true,hostname_ready AND ssl_ready,
      'cloudflare',p_evidence_hash
    );
  END IF;
  UPDATE public.domain_provisioning_jobs SET
    status=CASE WHEN p_error_message IS NOT NULL THEN 'failed'
      WHEN hostname_ready AND ssl_ready THEN 'succeeded' ELSE 'waiting' END,
    error_message=NULLIF(left(COALESCE(p_error_message,''),500),''),completed_at=now()
  WHERE id=job.id;
  INSERT INTO public.domain_provisioning_events(
    organization_id,domain_id,job_id,event_key,provider,hostname_status,ssl_status,evidence_hash
  ) VALUES(job.organization_id,job.domain_id,job.id,normalized_event_key,'cloudflare',
    NULLIF(lower(COALESCE(p_hostname_status,'')),''),NULLIF(lower(COALESCE(p_ssl_status,'')),''),
    NULLIF(p_evidence_hash,''));
  RETURN jsonb_build_object('duplicate',false,'jobId',job.id,'domainId',domain.id,
    'hostnameStatus',p_hostname_status,'sslStatus',p_ssl_status,
    'ready',hostname_ready AND ssl_ready,'verification',verification_result);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_begin_domain_ssl_provisioning(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_begin_domain_ssl_provisioning(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_finish_domain_ssl_provisioning(uuid,text,text,text,text,text,text)
  FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_finish_domain_ssl_provisioning(uuid,text,text,text,text,text,text)
  TO service_role;

INSERT INTO public.schema_migrations(version,description)
VALUES ('0074','Add Cloudflare custom hostname SSL provisioning jobs and service results')
ON CONFLICT(version) DO NOTHING;
COMMIT;
