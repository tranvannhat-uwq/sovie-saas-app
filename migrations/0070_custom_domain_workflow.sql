BEGIN;

CREATE TABLE public.domain_verification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  domain_id uuid NOT NULL REFERENCES public.organization_domains(id) ON DELETE CASCADE,
  event_key text NOT NULL UNIQUE,
  verified boolean NOT NULL,
  ssl_active boolean NOT NULL,
  evidence_hash text,
  source text NOT NULL DEFAULT 'cloudflare'
    CHECK (source IN ('cloudflare','manual','system')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX domain_verification_events_tenant_domain_idx
  ON public.domain_verification_events (organization_id, domain_id, created_at DESC);

ALTER TABLE public.domain_verification_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.domain_verification_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.domain_verification_events TO authenticated;
CREATE POLICY domain_verification_events_owner_read ON public.domain_verification_events
FOR SELECT TO authenticated USING (
  public.has_organization_role(organization_id, ARRAY['owner'])
);

CREATE OR REPLACE FUNCTION public.rpc_request_custom_domain(p_hostname text)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  normalized_hostname text := lower(trim(trailing '.' FROM btrim(COALESCE(p_hostname, ''))));
  domain_limit integer;
  domain_count integer;
  created_domain public.organization_domains%ROWTYPE;
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id, ARRAY['owner']) THEN
    RAISE EXCEPTION '403: workspace owner required' USING ERRCODE = '42501';
  END IF;
  IF NOT public.organization_write_access_allowed(active_organization_id) THEN
    RAISE EXCEPTION 'Workspace is read-only for the current subscription'
      USING ERRCODE = '42501';
  END IF;
  IF normalized_hostname !~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'
    OR normalized_hostname LIKE '%.sovie.vn'
    OR normalized_hostname = 'sovie.vn' THEN
    RAISE EXCEPTION 'A valid external custom hostname is required' USING ERRCODE = '22023';
  END IF;

  PERFORM 1 FROM public.organizations organization
  WHERE organization.id = active_organization_id FOR UPDATE;

  SELECT COALESCE((plan.limits->>'custom_domains')::integer, 0)
  INTO domain_limit
  FROM public.organization_subscriptions subscription
  JOIN public.saas_plans plan ON plan.id = subscription.plan_id
  WHERE subscription.organization_id = active_organization_id
  ORDER BY subscription.updated_at DESC, subscription.created_at DESC LIMIT 1;
  domain_limit := COALESCE(domain_limit, 0);

  SELECT count(*) INTO domain_count
  FROM public.organization_domains domain
  WHERE domain.organization_id = active_organization_id
    AND domain.domain_type = 'custom' AND domain.status <> 'disabled';
  IF domain_count >= domain_limit THEN
    RAISE EXCEPTION 'Custom domain limit reached (% domains)', domain_limit
      USING ERRCODE = 'P0001';
  END IF;

  INSERT INTO public.organization_domains (
    organization_id, hostname, domain_type, status, is_primary, ssl_status
  ) VALUES (
    active_organization_id, normalized_hostname, 'custom', 'pending', false, 'pending'
  ) RETURNING * INTO created_domain;

  RETURN jsonb_build_object(
    'domainId', created_domain.id,
    'hostname', created_domain.hostname,
    'status', created_domain.status,
    'verification', jsonb_build_object(
      'type', 'TXT',
      'name', '_sovie-verification.' || created_domain.hostname,
      'value', created_domain.verification_token
    )
  );
EXCEPTION WHEN unique_violation THEN
  RAISE EXCEPTION 'Hostname is already registered' USING ERRCODE = '23505';
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_my_custom_domain_verification(p_domain_id uuid)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  domain public.organization_domains%ROWTYPE;
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id, ARRAY['owner']) THEN
    RAISE EXCEPTION '403: workspace owner required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO domain FROM public.organization_domains candidate
  WHERE candidate.id = p_domain_id
    AND candidate.organization_id = active_organization_id
    AND candidate.domain_type = 'custom' AND candidate.status <> 'disabled';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Custom domain not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  RETURN jsonb_build_object(
    'domainId', domain.id, 'hostname', domain.hostname,
    'status', domain.status, 'sslStatus', domain.ssl_status,
    'verification', jsonb_build_object(
      'type', 'TXT', 'name', '_sovie-verification.' || domain.hostname,
      'value', domain.verification_token
    )
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_apply_domain_verification(
  p_event_key text,
  p_domain_id uuid,
  p_verified boolean,
  p_ssl_active boolean,
  p_source text DEFAULT 'cloudflare',
  p_evidence_hash text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized_event_key text := btrim(COALESCE(p_event_key, ''));
  normalized_source text := lower(btrim(COALESCE(p_source, 'cloudflare')));
  domain public.organization_domains%ROWTYPE;
BEGIN
  IF char_length(normalized_event_key) NOT BETWEEN 4 AND 240 THEN
    RAISE EXCEPTION 'Domain verification event key is required' USING ERRCODE = '22023';
  END IF;
  IF normalized_source NOT IN ('cloudflare','manual','system') THEN
    RAISE EXCEPTION 'Unsupported domain verification source' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.domain_verification_events event WHERE event.event_key = normalized_event_key) THEN
    RETURN jsonb_build_object('duplicate', true, 'eventKey', normalized_event_key);
  END IF;

  SELECT * INTO domain FROM public.organization_domains candidate
  WHERE candidate.id = p_domain_id AND candidate.domain_type = 'custom'
    AND candidate.status <> 'disabled'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Custom domain not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.domain_verification_events event WHERE event.event_key = normalized_event_key) THEN
    RETURN jsonb_build_object('duplicate', true, 'eventKey', normalized_event_key);
  END IF;

  INSERT INTO public.domain_verification_events (
    organization_id, domain_id, event_key, verified, ssl_active, evidence_hash, source
  ) VALUES (
    domain.organization_id, domain.id, normalized_event_key,
    COALESCE(p_verified, false), COALESCE(p_ssl_active, false),
    NULLIF(p_evidence_hash, ''), normalized_source
  );

  UPDATE public.organization_domains
  SET status = CASE
        WHEN COALESCE(p_verified, false) AND COALESCE(p_ssl_active, false) THEN 'active'
        WHEN COALESCE(p_verified, false) THEN 'verified'
        ELSE 'failed'
      END,
      verified_at = CASE WHEN COALESCE(p_verified, false) THEN COALESCE(verified_at, now()) ELSE NULL END,
      ssl_status = CASE WHEN COALESCE(p_ssl_active, false) THEN 'active'
        WHEN COALESCE(p_verified, false) THEN 'pending' ELSE 'failed' END,
      updated_at = now()
  WHERE id = domain.id
  RETURNING * INTO domain;

  RETURN jsonb_build_object(
    'duplicate', false, 'eventKey', normalized_event_key,
    'domainId', domain.id, 'hostname', domain.hostname,
    'status', domain.status, 'sslStatus', domain.ssl_status
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_set_primary_custom_domain(p_domain_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE active_organization_id uuid := public.current_organization_id();
DECLARE domain public.organization_domains%ROWTYPE;
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
  WHERE candidate.id = p_domain_id AND candidate.organization_id = active_organization_id
    AND candidate.domain_type = 'custom' AND candidate.status = 'active'
    AND candidate.ssl_status = 'active';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Verified custom domain with active SSL required' USING ERRCODE = '22023';
  END IF;
  UPDATE public.organization_domains SET is_primary = false, updated_at = now()
  WHERE organization_id = active_organization_id AND is_primary;
  UPDATE public.organization_domains SET is_primary = true, updated_at = now()
  WHERE id = domain.id;
  RETURN jsonb_build_object('domainId', domain.id, 'hostname', domain.hostname, 'isPrimary', true);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_disable_custom_domain(p_domain_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE active_organization_id uuid := public.current_organization_id();
DECLARE domain public.organization_domains%ROWTYPE;
DECLARE was_primary boolean := false;
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
  WHERE candidate.id = p_domain_id AND candidate.organization_id = active_organization_id
    AND candidate.domain_type = 'custom' AND candidate.status <> 'disabled'
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Custom domain not found in this workspace' USING ERRCODE = 'P0002';
  END IF;
  was_primary := domain.is_primary;
  UPDATE public.organization_domains
  SET status = 'disabled', is_primary = false, updated_at = now()
  WHERE id = domain.id;
  IF was_primary THEN
    UPDATE public.organization_domains SET is_primary = true, updated_at = now()
    WHERE organization_id = active_organization_id
      AND domain_type = 'sovie_subdomain' AND status = 'active';
  END IF;
  RETURN jsonb_build_object('domainId', domain.id, 'hostname', domain.hostname, 'status', 'disabled');
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_request_custom_domain(text),
  public.rpc_my_custom_domain_verification(uuid),
  public.rpc_set_primary_custom_domain(uuid),
  public.rpc_disable_custom_domain(uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_request_custom_domain(text),
  public.rpc_my_custom_domain_verification(uuid),
  public.rpc_set_primary_custom_domain(uuid),
  public.rpc_disable_custom_domain(uuid)
  TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_apply_domain_verification(text,uuid,boolean,boolean,text,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_apply_domain_verification(text,uuid,boolean,boolean,text,text)
  TO service_role;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0070', 'Add plan-gated custom domain request, verification and primary workflow')
ON CONFLICT (version) DO NOTHING;

COMMIT;
