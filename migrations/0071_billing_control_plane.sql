BEGIN;

CREATE TABLE public.billing_checkout_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  requested_plan_id text NOT NULL REFERENCES public.saas_plans(id),
  request_key text NOT NULL,
  billing_cycle text NOT NULL DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly','yearly')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','processing','completed','cancelled','expired')),
  provider text,
  provider_checkout_id text,
  hosted_checkout_url text,
  created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '24 hours'),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, request_key)
);
CREATE INDEX billing_checkout_requests_tenant_idx
  ON public.billing_checkout_requests (organization_id, created_at DESC);
CREATE UNIQUE INDEX billing_checkout_requests_one_open_uidx
  ON public.billing_checkout_requests (organization_id)
  WHERE status IN ('pending','processing');

CREATE TABLE public.billing_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  provider text NOT NULL,
  provider_invoice_id text NOT NULL,
  invoice_number text,
  status text NOT NULL CHECK (status IN ('draft','open','paid','void','uncollectible')),
  currency text NOT NULL DEFAULT 'VND',
  subtotal numeric(14,2) NOT NULL DEFAULT 0 CHECK (subtotal >= 0),
  tax numeric(14,2) NOT NULL DEFAULT 0 CHECK (tax >= 0),
  total numeric(14,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  period_start timestamptz,
  period_end timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  hosted_invoice_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_invoice_id)
);
CREATE INDEX billing_invoices_tenant_idx
  ON public.billing_invoices (organization_id, created_at DESC);

CREATE TABLE public.billing_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_key text NOT NULL UNIQUE,
  provider text NOT NULL,
  event_type text NOT NULL,
  payload_hash text,
  applied_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX billing_webhook_events_tenant_idx
  ON public.billing_webhook_events (organization_id, applied_at DESC);

ALTER TABLE public.billing_checkout_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_webhook_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_checkout_requests, public.billing_invoices,
  public.billing_webhook_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.billing_checkout_requests, public.billing_invoices,
  public.billing_webhook_events TO authenticated;
CREATE POLICY billing_checkout_requests_owner_read ON public.billing_checkout_requests
FOR SELECT TO authenticated USING (public.has_organization_role(organization_id, ARRAY['owner']));
CREATE POLICY billing_invoices_owner_read ON public.billing_invoices
FOR SELECT TO authenticated USING (public.has_organization_role(organization_id, ARRAY['owner']));
CREATE POLICY billing_webhook_events_owner_read ON public.billing_webhook_events
FOR SELECT TO authenticated USING (public.has_organization_role(organization_id, ARRAY['owner']));

CREATE OR REPLACE FUNCTION public.rpc_request_plan_change(
  p_plan_id text, p_request_key text, p_billing_cycle text DEFAULT 'monthly'
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE active_organization_id uuid := public.current_organization_id();
DECLARE normalized_key text := btrim(COALESCE(p_request_key, ''));
DECLARE normalized_cycle text := lower(btrim(COALESCE(p_billing_cycle, 'monthly')));
DECLARE request public.billing_checkout_requests%ROWTYPE;
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id, ARRAY['owner']) THEN
    RAISE EXCEPTION '403: workspace owner required' USING ERRCODE = '42501';
  END IF;
  IF char_length(normalized_key) NOT BETWEEN 8 AND 120 OR normalized_cycle NOT IN ('monthly','yearly') THEN
    RAISE EXCEPTION 'Valid request key and billing cycle required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.saas_plans plan
    WHERE plan.id = p_plan_id AND plan.is_active AND plan.is_public) THEN
    RAISE EXCEPTION 'Public active SaaS plan not found' USING ERRCODE = 'P0002';
  END IF;
  SELECT * INTO request FROM public.billing_checkout_requests candidate
  WHERE candidate.request_key = normalized_key AND candidate.organization_id = active_organization_id;
  IF FOUND THEN
    RETURN jsonb_build_object('requestId', request.id, 'status', request.status,
      'planId', request.requested_plan_id, 'duplicate', true);
  END IF;
  PERFORM 1 FROM public.organizations organization
  WHERE organization.id = active_organization_id FOR UPDATE;
  UPDATE public.billing_checkout_requests SET status = 'expired', updated_at = now()
  WHERE organization_id = active_organization_id AND status IN ('pending','processing')
    AND expires_at <= now();
  SELECT * INTO request FROM public.billing_checkout_requests candidate
  WHERE candidate.organization_id = active_organization_id
    AND candidate.status IN ('pending','processing') LIMIT 1;
  IF FOUND THEN
    RETURN jsonb_build_object('requestId', request.id, 'status', request.status,
      'planId', request.requested_plan_id, 'duplicate', true);
  END IF;
  INSERT INTO public.billing_checkout_requests (
    organization_id, requested_plan_id, request_key, billing_cycle, created_by
  ) VALUES (
    active_organization_id, p_plan_id, normalized_key, normalized_cycle, auth.uid()
  ) RETURNING * INTO request;
  RETURN jsonb_build_object('requestId', request.id, 'status', request.status,
    'planId', request.requested_plan_id, 'billingCycle', request.billing_cycle,
    'duplicate', false);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_my_billing_summary()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE active_organization_id uuid := public.current_organization_id();
DECLARE result jsonb;
BEGIN
  IF active_organization_id IS NULL
    OR NOT public.has_organization_role(active_organization_id, ARRAY['owner']) THEN
    RAISE EXCEPTION '403: workspace owner required' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'organizationId', active_organization_id,
    'plans', COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id', plan.id, 'name', plan.name, 'description', plan.description,
      'priceMonthly', plan.price_monthly, 'currency', plan.currency, 'limits', plan.limits
    ) ORDER BY plan.price_monthly) FROM public.saas_plans plan
      WHERE plan.is_active AND plan.is_public), '[]'::jsonb),
    'subscription', (SELECT to_jsonb(subscription) - 'organization_id'
      FROM public.organization_subscriptions subscription
      WHERE subscription.organization_id = active_organization_id
      ORDER BY subscription.updated_at DESC LIMIT 1),
    'checkoutRequest', (SELECT to_jsonb(request) - 'organization_id' - 'created_by'
      FROM public.billing_checkout_requests request
      WHERE request.organization_id = active_organization_id
      ORDER BY request.created_at DESC LIMIT 1),
    'invoices', COALESCE((SELECT jsonb_agg(to_jsonb(invoice) - 'organization_id'
      ORDER BY invoice.created_at DESC) FROM (SELECT * FROM public.billing_invoices
        WHERE organization_id = active_organization_id ORDER BY created_at DESC LIMIT 12) invoice), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_apply_billing_event(
  p_event_key text, p_organization_id uuid, p_provider text, p_event_type text,
  p_plan_id text, p_provider_invoice_id text DEFAULT NULL,
  p_invoice_number text DEFAULT NULL, p_total numeric DEFAULT 0,
  p_currency text DEFAULT 'VND', p_period_start timestamptz DEFAULT NULL,
  p_period_end timestamptz DEFAULT NULL, p_request_id uuid DEFAULT NULL,
  p_hosted_invoice_url text DEFAULT NULL, p_payload_hash text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE normalized_key text := btrim(COALESCE(p_event_key, ''));
DECLARE normalized_provider text := lower(btrim(COALESCE(p_provider, '')));
DECLARE normalized_type text := lower(btrim(COALESCE(p_event_type, '')));
DECLARE subscription_status text;
DECLARE invoice_status text;
BEGIN
  IF char_length(normalized_key) NOT BETWEEN 4 AND 240 THEN
    RAISE EXCEPTION 'Billing event key is required' USING ERRCODE = '22023';
  END IF;
  IF normalized_provider NOT IN ('stripe','manual','paddle','payos','vnpay','momo','system')
    OR normalized_type NOT IN ('checkout_completed','invoice_open','invoice_paid','invoice_failed','invoice_void') THEN
    RAISE EXCEPTION 'Unsupported billing provider or event' USING ERRCODE = '22023';
  END IF;
  IF p_total < 0 OR upper(btrim(COALESCE(p_currency, ''))) !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Invalid billing amount or currency' USING ERRCODE = '22023';
  END IF;
  IF NULLIF(btrim(COALESCE(p_hosted_invoice_url, '')), '') IS NOT NULL
    AND p_hosted_invoice_url !~ '^https://' THEN
    RAISE EXCEPTION 'Hosted invoice URL must use HTTPS' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.saas_plans plan WHERE plan.id = p_plan_id AND plan.is_active) THEN
    RAISE EXCEPTION 'Active SaaS plan not found' USING ERRCODE = 'P0002';
  END IF;
  IF EXISTS (SELECT 1 FROM public.billing_webhook_events event WHERE event.event_key = normalized_key) THEN
    RETURN jsonb_build_object('duplicate', true, 'eventKey', normalized_key);
  END IF;
  PERFORM 1 FROM public.organizations organization
  WHERE organization.id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Organization not found' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS (SELECT 1 FROM public.billing_webhook_events event WHERE event.event_key = normalized_key) THEN
    RETURN jsonb_build_object('duplicate', true, 'eventKey', normalized_key);
  END IF;

  invoice_status := CASE normalized_type WHEN 'invoice_open' THEN 'open'
    WHEN 'invoice_paid' THEN 'paid' WHEN 'invoice_failed' THEN 'uncollectible'
    WHEN 'invoice_void' THEN 'void' ELSE NULL END;
  IF invoice_status IS NOT NULL THEN
    IF NULLIF(btrim(COALESCE(p_provider_invoice_id, '')), '') IS NULL THEN
      RAISE EXCEPTION 'Provider invoice id is required' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM public.billing_invoices invoice
      WHERE invoice.provider = normalized_provider
        AND invoice.provider_invoice_id = p_provider_invoice_id
        AND invoice.organization_id <> p_organization_id) THEN
      RAISE EXCEPTION 'Provider invoice belongs to another organization' USING ERRCODE = '23505';
    END IF;
    INSERT INTO public.billing_invoices (
      organization_id, provider, provider_invoice_id, invoice_number, status,
      currency, subtotal, total, period_start, period_end, paid_at, hosted_invoice_url
    ) VALUES (
      p_organization_id, normalized_provider, p_provider_invoice_id,
      NULLIF(p_invoice_number, ''), invoice_status, upper(p_currency), p_total, p_total,
      p_period_start, p_period_end,
      CASE WHEN invoice_status = 'paid' THEN now() END, NULLIF(p_hosted_invoice_url, '')
    ) ON CONFLICT (provider, provider_invoice_id) DO UPDATE SET
      status = CASE WHEN billing_invoices.status = 'paid' AND EXCLUDED.status <> 'paid'
        THEN billing_invoices.status ELSE EXCLUDED.status END,
      invoice_number = COALESCE(EXCLUDED.invoice_number, billing_invoices.invoice_number),
      currency = EXCLUDED.currency, subtotal = EXCLUDED.subtotal, total = EXCLUDED.total,
      period_start = COALESCE(EXCLUDED.period_start, billing_invoices.period_start),
      period_end = COALESCE(EXCLUDED.period_end, billing_invoices.period_end),
      paid_at = COALESCE(EXCLUDED.paid_at, billing_invoices.paid_at),
      hosted_invoice_url = COALESCE(EXCLUDED.hosted_invoice_url, billing_invoices.hosted_invoice_url),
      updated_at = now()
    WHERE billing_invoices.organization_id = EXCLUDED.organization_id;
  END IF;

  subscription_status := CASE normalized_type
    WHEN 'checkout_completed' THEN 'active' WHEN 'invoice_paid' THEN 'active'
    WHEN 'invoice_failed' THEN 'past_due' ELSE NULL END;
  IF subscription_status IS NOT NULL THEN
    PERFORM public.rpc_apply_subscription_state(
      'billing:' || normalized_key, p_organization_id, p_plan_id, subscription_status,
      CASE WHEN normalized_provider = 'stripe' THEN 'stripe' ELSE 'system' END,
      p_period_start, p_period_end, normalized_provider, NULL, NULL, p_payload_hash
    );
  END IF;
  IF p_request_id IS NOT NULL THEN
    UPDATE public.billing_checkout_requests SET
      status = CASE WHEN normalized_type IN ('checkout_completed','invoice_paid') THEN 'completed' ELSE status END,
      provider = normalized_provider,
      completed_at = CASE WHEN normalized_type IN ('checkout_completed','invoice_paid') THEN now() ELSE completed_at END,
      updated_at = now()
    WHERE id = p_request_id AND organization_id = p_organization_id;
  END IF;
  INSERT INTO public.billing_webhook_events (
    organization_id, event_key, provider, event_type, payload_hash
  ) VALUES (p_organization_id, normalized_key, normalized_provider, normalized_type, NULLIF(p_payload_hash, ''));
  RETURN jsonb_build_object('duplicate', false, 'eventKey', normalized_key,
    'organizationId', p_organization_id, 'eventType', normalized_type,
    'subscriptionStatus', subscription_status, 'invoiceStatus', invoice_status);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_request_plan_change(text,text,text),
  public.rpc_my_billing_summary() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_request_plan_change(text,text,text),
  public.rpc_my_billing_summary() TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_apply_billing_event(
  text,uuid,text,text,text,text,text,numeric,text,timestamptz,timestamptz,uuid,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_apply_billing_event(
  text,uuid,text,text,text,text,text,numeric,text,timestamptz,timestamptz,uuid,text,text
) TO service_role;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0071', 'Add provider-neutral billing requests, invoices and idempotent service events')
ON CONFLICT (version) DO NOTHING;

COMMIT;
