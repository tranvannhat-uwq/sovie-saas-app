BEGIN;

ALTER TABLE public.organization_subscriptions
  ADD COLUMN IF NOT EXISTS billing_event_at timestamptz;
ALTER TABLE public.billing_invoices
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz;
ALTER TABLE public.billing_webhook_events
  ADD COLUMN IF NOT EXISTS event_occurred_at timestamptz,
  ADD COLUMN IF NOT EXISTS signature_version text,
  ADD COLUMN IF NOT EXISTS applied boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS ignored_reason text;

UPDATE public.billing_invoices
SET last_event_at = COALESCE(last_event_at, updated_at, created_at)
WHERE last_event_at IS NULL;
UPDATE public.billing_webhook_events
SET event_occurred_at = COALESCE(event_occurred_at, applied_at)
WHERE event_occurred_at IS NULL;

ALTER TABLE public.billing_invoices ALTER COLUMN last_event_at SET DEFAULT now();
ALTER TABLE public.billing_invoices ALTER COLUMN last_event_at SET NOT NULL;
ALTER TABLE public.billing_webhook_events ALTER COLUMN event_occurred_at SET DEFAULT now();
ALTER TABLE public.billing_webhook_events ALTER COLUMN event_occurred_at SET NOT NULL;

-- The unsigned compatibility RPC remains defined for migration history, but is
-- no longer callable by service_role after the signed webhook path is installed.
REVOKE EXECUTE ON FUNCTION public.rpc_apply_billing_event(
  text,uuid,text,text,text,text,text,numeric,text,timestamptz,timestamptz,uuid,text,text
) FROM service_role;

CREATE OR REPLACE FUNCTION public.rpc_apply_signed_billing_event(
  p_event_key text,
  p_occurred_at timestamptz,
  p_organization_id uuid,
  p_provider text,
  p_event_type text,
  p_plan_id text,
  p_provider_invoice_id text DEFAULT NULL,
  p_invoice_number text DEFAULT NULL,
  p_total numeric DEFAULT 0,
  p_currency text DEFAULT 'VND',
  p_period_start timestamptz DEFAULT NULL,
  p_period_end timestamptz DEFAULT NULL,
  p_request_id uuid DEFAULT NULL,
  p_hosted_invoice_url text DEFAULT NULL,
  p_payload_hash text DEFAULT NULL,
  p_signature_version text DEFAULT 'v1'
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE normalized_key text := btrim(COALESCE(p_event_key, ''));
DECLARE normalized_provider text := lower(btrim(COALESCE(p_provider, '')));
DECLARE normalized_type text := lower(btrim(COALESCE(p_event_type, '')));
DECLARE normalized_signature text := lower(btrim(COALESCE(p_signature_version, '')));
DECLARE invoice_status text;
DECLARE subscription_status text;
DECLARE latest_subscription_event_at timestamptz;
DECLARE invoice_rows integer := 0;
DECLARE subscription_applied boolean := false;
DECLARE event_applied boolean := false;
DECLARE ignored_reason text;
BEGIN
  IF char_length(normalized_key) NOT BETWEEN 4 AND 240
    OR p_occurred_at IS NULL OR p_occurred_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Valid billing event identity and time required' USING ERRCODE = '22023';
  END IF;
  IF normalized_signature <> 'v1' THEN
    RAISE EXCEPTION 'Unsupported billing signature version' USING ERRCODE = '22023';
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

  invoice_status := CASE normalized_type
    WHEN 'invoice_open' THEN 'open' WHEN 'invoice_paid' THEN 'paid'
    WHEN 'invoice_failed' THEN 'open' WHEN 'invoice_void' THEN 'void' ELSE NULL END;
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
      currency, subtotal, total, period_start, period_end, paid_at,
      hosted_invoice_url, last_event_at
    ) VALUES (
      p_organization_id, normalized_provider, p_provider_invoice_id,
      NULLIF(p_invoice_number, ''), invoice_status, upper(p_currency), p_total, p_total,
      p_period_start, p_period_end, CASE WHEN invoice_status = 'paid' THEN p_occurred_at END,
      NULLIF(p_hosted_invoice_url, ''), p_occurred_at
    ) ON CONFLICT (provider, provider_invoice_id) DO UPDATE SET
      status = EXCLUDED.status,
      invoice_number = COALESCE(EXCLUDED.invoice_number, billing_invoices.invoice_number),
      currency = EXCLUDED.currency, subtotal = EXCLUDED.subtotal, total = EXCLUDED.total,
      period_start = COALESCE(EXCLUDED.period_start, billing_invoices.period_start),
      period_end = COALESCE(EXCLUDED.period_end, billing_invoices.period_end),
      paid_at = COALESCE(EXCLUDED.paid_at, billing_invoices.paid_at),
      hosted_invoice_url = COALESCE(EXCLUDED.hosted_invoice_url, billing_invoices.hosted_invoice_url),
      last_event_at = EXCLUDED.last_event_at, updated_at = now()
    WHERE billing_invoices.organization_id = EXCLUDED.organization_id
      AND billing_invoices.last_event_at <= EXCLUDED.last_event_at;
    GET DIAGNOSTICS invoice_rows = ROW_COUNT;
  END IF;

  subscription_status := CASE normalized_type
    WHEN 'checkout_completed' THEN 'active' WHEN 'invoice_paid' THEN 'active'
    WHEN 'invoice_failed' THEN 'past_due' ELSE NULL END;
  IF subscription_status IS NOT NULL THEN
    SELECT subscription.billing_event_at INTO latest_subscription_event_at
    FROM public.organization_subscriptions subscription
    WHERE subscription.organization_id = p_organization_id
    ORDER BY subscription.updated_at DESC, subscription.created_at DESC LIMIT 1;
    IF latest_subscription_event_at IS NULL OR latest_subscription_event_at <= p_occurred_at THEN
      PERFORM public.rpc_apply_subscription_state(
        'billing-signed:' || normalized_key, p_organization_id, p_plan_id, subscription_status,
        CASE WHEN normalized_provider = 'stripe' THEN 'stripe' ELSE 'system' END,
        p_period_start, p_period_end, normalized_provider, NULL, NULL, p_payload_hash
      );
      UPDATE public.organization_subscriptions SET billing_event_at = p_occurred_at
      WHERE id = (SELECT subscription.id FROM public.organization_subscriptions subscription
        WHERE subscription.organization_id = p_organization_id
        ORDER BY subscription.updated_at DESC, subscription.created_at DESC LIMIT 1);
      subscription_applied := true;
    END IF;
  END IF;

  IF p_request_id IS NOT NULL AND subscription_applied
    AND normalized_type IN ('checkout_completed','invoice_paid') THEN
    UPDATE public.billing_checkout_requests SET status = 'completed',
      provider = normalized_provider, completed_at = p_occurred_at, updated_at = now()
    WHERE id = p_request_id AND organization_id = p_organization_id;
  END IF;

  event_applied := invoice_rows > 0 OR subscription_applied;
  IF NOT event_applied THEN ignored_reason := 'stale_event'; END IF;
  INSERT INTO public.billing_webhook_events (
    organization_id, event_key, provider, event_type, payload_hash,
    event_occurred_at, signature_version, applied, ignored_reason
  ) VALUES (
    p_organization_id, normalized_key, normalized_provider, normalized_type,
    NULLIF(p_payload_hash, ''), p_occurred_at, normalized_signature,
    event_applied, ignored_reason
  );
  RETURN jsonb_build_object('duplicate', false, 'eventKey', normalized_key,
    'organizationId', p_organization_id, 'eventType', normalized_type,
    'invoiceApplied', invoice_rows > 0, 'subscriptionApplied', subscription_applied,
    'ignoredReason', ignored_reason);
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_apply_signed_billing_event(
  text,timestamptz,uuid,text,text,text,text,text,numeric,text,timestamptz,timestamptz,uuid,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_apply_signed_billing_event(
  text,timestamptz,uuid,text,text,text,text,text,numeric,text,timestamptz,timestamptz,uuid,text,text,text
) TO service_role;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0072', 'Add signed billing event ordering and stale webhook protection')
ON CONFLICT (version) DO NOTHING;

COMMIT;
