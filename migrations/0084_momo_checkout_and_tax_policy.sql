BEGIN;

CREATE TABLE public.billing_platform_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  provider text NOT NULL DEFAULT 'momo' CHECK (provider = 'momo'),
  tax_mode text NOT NULL DEFAULT 'exclusive' CHECK (tax_mode IN ('exclusive','not_subject')),
  vat_rate numeric(5,2),
  issuer_name text NOT NULL DEFAULT '',
  issuer_tax_code text NOT NULL DEFAULT '',
  billing_enabled boolean NOT NULL DEFAULT false,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_platform_settings_vat_check CHECK (
    (tax_mode = 'not_subject' AND COALESCE(vat_rate, 0) = 0)
    OR (tax_mode = 'exclusive' AND (vat_rate IS NULL OR vat_rate > 0 AND vat_rate <= 100))
  )
);
INSERT INTO public.billing_platform_settings(singleton) VALUES (true)
ON CONFLICT (singleton) DO NOTHING;
ALTER TABLE public.billing_platform_settings ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.billing_platform_settings FROM PUBLIC, anon, authenticated;

ALTER TABLE public.billing_checkout_requests
  ADD COLUMN IF NOT EXISTS subtotal numeric(14,2) CHECK (subtotal >= 0),
  ADD COLUMN IF NOT EXISTS tax_rate numeric(5,2) CHECK (tax_rate >= 0 AND tax_rate <= 100),
  ADD COLUMN IF NOT EXISTS tax numeric(14,2) CHECK (tax >= 0),
  ADD COLUMN IF NOT EXISTS total numeric(14,2) CHECK (total >= 0),
  ADD COLUMN IF NOT EXISTS period_start timestamptz,
  ADD COLUMN IF NOT EXISTS period_end timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS billing_checkout_requests_provider_order_uidx
  ON public.billing_checkout_requests(provider, provider_checkout_id)
  WHERE provider IS NOT NULL AND provider_checkout_id IS NOT NULL;

ALTER TABLE public.platform_customer_events
  DROP CONSTRAINT IF EXISTS platform_customer_events_event_type_check;
ALTER TABLE public.platform_customer_events
  ADD CONSTRAINT platform_customer_events_event_type_check CHECK (event_type IN (
    'customer_provisioned','plan_changed','trial_extended',
    'customer_suspended','customer_reactivated','customer_cancelled',
    'plan_catalog_updated','billing_configuration_updated'
  ));

CREATE OR REPLACE FUNCTION public.rpc_platform_billing_configuration()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE settings public.billing_platform_settings%ROWTYPE;
DECLARE prices_ready boolean;
BEGIN
  IF NOT public.is_platform_staff(ARRAY['platform_owner','billing']) THEN
    RAISE EXCEPTION '403: platform billing access required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO settings FROM public.billing_platform_settings WHERE singleton;
  SELECT count(*) > 0 AND bool_and(plan.price_monthly > 0 AND plan.price_yearly > 0)
  INTO prices_ready FROM public.saas_plans plan WHERE plan.is_active AND plan.is_public;
  RETURN jsonb_build_object(
    'provider', settings.provider, 'taxMode', settings.tax_mode,
    'vatRate', settings.vat_rate, 'issuerName', settings.issuer_name,
    'issuerTaxCode', settings.issuer_tax_code,
    'billingEnabled', settings.billing_enabled,
    'pricesReady', COALESCE(prices_ready, false),
    'taxReady', settings.tax_mode = 'not_subject' OR settings.vat_rate IS NOT NULL,
    'updatedAt', settings.updated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_platform_update_billing_configuration(
  p_tax_mode text,
  p_vat_rate numeric DEFAULT NULL,
  p_issuer_name text DEFAULT '',
  p_issuer_tax_code text DEFAULT '',
  p_billing_enabled boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE actor_id uuid := auth.uid();
DECLARE normalized_tax_mode text := lower(btrim(COALESCE(p_tax_mode, '')));
DECLARE normalized_issuer_name text := btrim(COALESCE(p_issuer_name, ''));
DECLARE normalized_tax_code text := upper(btrim(COALESCE(p_issuer_tax_code, '')));
DECLARE prices_ready boolean;
DECLARE updated_settings public.billing_platform_settings%ROWTYPE;
BEGIN
  IF actor_id IS NULL OR NOT public.is_platform_staff(ARRAY['platform_owner']) THEN
    RAISE EXCEPTION '403: platform owner required' USING ERRCODE = '42501';
  END IF;
  IF normalized_tax_mode NOT IN ('exclusive','not_subject') THEN
    RAISE EXCEPTION 'Unsupported billing tax mode' USING ERRCODE = '22023';
  END IF;
  IF normalized_tax_mode = 'exclusive' AND (p_vat_rate IS NULL OR p_vat_rate <= 0 OR p_vat_rate > 100) THEN
    RAISE EXCEPTION 'A valid VAT rate is required for VAT-exclusive pricing' USING ERRCODE = '22023';
  END IF;
  IF char_length(normalized_issuer_name) NOT BETWEEN 2 AND 160
    OR normalized_tax_code !~ '^[0-9A-Z-]{8,20}$' THEN
    RAISE EXCEPTION 'Valid invoice issuer name and tax code required' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) > 0 AND bool_and(plan.price_monthly > 0 AND plan.price_yearly > 0)
  INTO prices_ready FROM public.saas_plans plan WHERE plan.is_active AND plan.is_public;
  IF COALESCE(p_billing_enabled, false) AND NOT COALESCE(prices_ready, false) THEN
    RAISE EXCEPTION 'Every public plan needs approved monthly and yearly prices' USING ERRCODE = '55000';
  END IF;

  UPDATE public.billing_platform_settings
  SET tax_mode = normalized_tax_mode,
      vat_rate = CASE WHEN normalized_tax_mode = 'not_subject' THEN 0 ELSE p_vat_rate END,
      issuer_name = normalized_issuer_name,
      issuer_tax_code = normalized_tax_code,
      billing_enabled = COALESCE(p_billing_enabled, false),
      updated_by = actor_id,
      updated_at = now()
  WHERE singleton RETURNING * INTO updated_settings;

  INSERT INTO public.platform_customer_events(
    actor_auth_user_id, organization_id, event_type, payload
  ) VALUES (
    actor_id, NULL, 'billing_configuration_updated',
    jsonb_build_object(
      'provider', 'momo', 'taxMode', updated_settings.tax_mode,
      'vatRate', updated_settings.vat_rate,
      'issuerName', updated_settings.issuer_name,
      'issuerTaxCode', updated_settings.issuer_tax_code,
      'billingEnabled', updated_settings.billing_enabled
    )
  );
  RETURN public.rpc_platform_billing_configuration();
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_prepare_my_momo_checkout(p_request_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE request public.billing_checkout_requests%ROWTYPE;
DECLARE plan public.saas_plans%ROWTYPE;
DECLARE organization public.organizations%ROWTYPE;
DECLARE settings public.billing_platform_settings%ROWTYPE;
DECLARE calculated_subtotal numeric(14,2);
DECLARE calculated_tax numeric(14,2);
DECLARE calculated_total numeric(14,2);
DECLARE calculated_period_start timestamptz := now();
DECLARE calculated_period_end timestamptz;
DECLARE order_id text;
BEGIN
  SELECT * INTO request FROM public.billing_checkout_requests candidate
  WHERE candidate.id = p_request_id FOR UPDATE;
  IF NOT FOUND OR NOT public.has_organization_role(request.organization_id, ARRAY['owner']) THEN
    RAISE EXCEPTION '403: checkout request owner required' USING ERRCODE = '42501';
  END IF;
  IF request.status NOT IN ('pending','processing') OR request.expires_at <= now() THEN
    RAISE EXCEPTION 'Checkout request is no longer payable' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO settings FROM public.billing_platform_settings WHERE singleton;
  IF NOT settings.billing_enabled
    OR (settings.tax_mode = 'exclusive' AND settings.vat_rate IS NULL) THEN
    RAISE EXCEPTION 'MoMo billing is not commercially enabled' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO plan FROM public.saas_plans candidate
  WHERE candidate.id = request.requested_plan_id AND candidate.is_active AND candidate.is_public;
  IF NOT FOUND THEN RAISE EXCEPTION 'Public active SaaS plan not found' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO organization FROM public.organizations candidate
  WHERE candidate.id = request.organization_id;
  IF organization.status IN ('cancelled','archived') THEN
    RAISE EXCEPTION 'Cancelled or archived customers cannot start checkout' USING ERRCODE = '55000';
  END IF;

  calculated_subtotal := CASE request.billing_cycle
    WHEN 'yearly' THEN plan.price_yearly ELSE plan.price_monthly END;
  IF calculated_subtotal <= 0 THEN
    RAISE EXCEPTION 'Approved plan price is required before checkout' USING ERRCODE = '55000';
  END IF;
  calculated_tax := CASE settings.tax_mode WHEN 'exclusive'
    THEN round(calculated_subtotal * settings.vat_rate / 100, 0) ELSE 0 END;
  calculated_total := calculated_subtotal + calculated_tax;
  IF calculated_total < 1000 OR calculated_total > 50000000 OR calculated_total <> trunc(calculated_total) THEN
    RAISE EXCEPTION 'MoMo checkout total must be an integer from 1,000 to 50,000,000 VND' USING ERRCODE = '22023';
  END IF;
  calculated_period_end := CASE request.billing_cycle
    WHEN 'yearly' THEN calculated_period_start + interval '1 year'
    ELSE calculated_period_start + interval '1 month' END;
  order_id := COALESCE(request.provider_checkout_id, 'sovie-' || request.id::text);

  UPDATE public.billing_checkout_requests
  SET status = 'processing', provider = 'momo', provider_checkout_id = order_id,
      subtotal = calculated_subtotal, tax_rate = COALESCE(settings.vat_rate, 0),
      tax = calculated_tax, total = calculated_total,
      period_start = calculated_period_start, period_end = calculated_period_end,
      updated_at = now()
  WHERE id = request.id;
  RETURN jsonb_build_object(
    'requestId', request.id, 'organizationId', request.organization_id,
    'organizationName', organization.name, 'planId', plan.id, 'planName', plan.name,
    'billingCycle', request.billing_cycle, 'orderId', order_id,
    'subtotal', calculated_subtotal, 'taxRate', COALESCE(settings.vat_rate, 0),
    'tax', calculated_tax, 'total', calculated_total, 'currency', plan.currency,
    'periodStart', calculated_period_start, 'periodEnd', calculated_period_end,
    'issuerName', settings.issuer_name, 'issuerTaxCode', settings.issuer_tax_code
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_record_momo_checkout_response(
  p_request_id uuid, p_order_id text, p_result_code integer,
  p_pay_url text DEFAULT NULL
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION '403: service role required' USING ERRCODE = '42501';
  END IF;
  IF NULLIF(p_pay_url, '') IS NOT NULL AND p_pay_url !~ '^https://(?:test-payment|payment)\.momo\.vn/' THEN
    RAISE EXCEPTION 'Invalid MoMo checkout URL' USING ERRCODE = '22023';
  END IF;
  UPDATE public.billing_checkout_requests
  SET status = CASE WHEN p_result_code = 0 THEN 'processing' ELSE 'cancelled' END,
      hosted_checkout_url = CASE WHEN p_result_code = 0 THEN NULLIF(p_pay_url, '') ELSE NULL END,
      updated_at = now()
  WHERE id = p_request_id AND provider = 'momo' AND provider_checkout_id = p_order_id
    AND status IN ('pending','processing');
  IF NOT FOUND THEN RAISE EXCEPTION 'Matching MoMo checkout request not found' USING ERRCODE = 'P0002'; END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_apply_momo_ipn(
  p_order_id text, p_amount numeric, p_result_code integer,
  p_trans_id text, p_response_time timestamptz, p_payload_hash text
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE request public.billing_checkout_requests%ROWTYPE;
DECLARE event_key text;
DECLARE event_status text;
BEGIN
  IF auth.role() <> 'service_role' THEN
    RAISE EXCEPTION '403: service role required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO request FROM public.billing_checkout_requests candidate
  WHERE candidate.provider = 'momo' AND candidate.provider_checkout_id = p_order_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'MoMo checkout order not found' USING ERRCODE = 'P0002'; END IF;
  IF request.total IS NULL OR p_amount <> request.total THEN
    RAISE EXCEPTION 'MoMo IPN amount does not match checkout total' USING ERRCODE = '22023';
  END IF;
  IF p_response_time IS NULL OR p_response_time > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'Invalid MoMo response time' USING ERRCODE = '22023';
  END IF;
  event_key := 'momo:' || p_order_id || ':' || COALESCE(NULLIF(p_trans_id, ''), 'none') || ':' || p_result_code::text;
  IF EXISTS (SELECT 1 FROM public.billing_webhook_events event WHERE event.event_key = event_key) THEN
    RETURN jsonb_build_object('duplicate', true, 'eventKey', event_key);
  END IF;

  IF p_result_code = 0 THEN
    INSERT INTO public.billing_invoices(
      organization_id, provider, provider_invoice_id, invoice_number, status,
      currency, subtotal, tax, total, period_start, period_end, paid_at,
      last_event_at
    ) VALUES (
      request.organization_id, 'momo', COALESCE(NULLIF(p_trans_id, ''), p_order_id),
      p_order_id, 'paid', 'VND', request.subtotal, request.tax, request.total,
      request.period_start, request.period_end, p_response_time, p_response_time
    ) ON CONFLICT(provider, provider_invoice_id) DO UPDATE SET
      status = 'paid', subtotal = EXCLUDED.subtotal, tax = EXCLUDED.tax,
      total = EXCLUDED.total, period_start = EXCLUDED.period_start,
      period_end = EXCLUDED.period_end, paid_at = EXCLUDED.paid_at,
      last_event_at = EXCLUDED.last_event_at, updated_at = now()
    WHERE billing_invoices.organization_id = EXCLUDED.organization_id
      AND billing_invoices.last_event_at <= EXCLUDED.last_event_at;
    PERFORM public.rpc_apply_subscription_state(
      'momo-subscription:' || event_key, request.organization_id,
      request.requested_plan_id, 'active', 'system',
      request.period_start, request.period_end, 'momo', NULL,
      COALESCE(NULLIF(p_trans_id, ''), p_order_id), p_payload_hash
    );
    UPDATE public.organization_subscriptions SET billing_event_at = p_response_time
    WHERE id = (SELECT subscription.id FROM public.organization_subscriptions subscription
      WHERE subscription.organization_id = request.organization_id
      ORDER BY subscription.updated_at DESC, subscription.created_at DESC LIMIT 1);
    UPDATE public.billing_checkout_requests
    SET status = 'completed', completed_at = p_response_time, updated_at = now()
    WHERE id = request.id;
    event_status := 'invoice_paid';
  ELSIF p_result_code IN (7000,7002,9000) THEN
    event_status := 'momo_checkout_pending';
  ELSE
    UPDATE public.billing_checkout_requests SET status = 'cancelled', updated_at = now()
    WHERE id = request.id AND status <> 'completed';
    event_status := 'momo_checkout_failed';
  END IF;

  INSERT INTO public.billing_webhook_events(
    organization_id, event_key, provider, event_type, payload_hash,
    event_occurred_at, signature_version, applied, ignored_reason
  ) VALUES (
    request.organization_id, event_key, 'momo', event_status,
    NULLIF(p_payload_hash, ''), p_response_time, 'momo-hmac-sha256',
    p_result_code = 0, CASE WHEN p_result_code = 0 THEN NULL ELSE event_status END
  );
  RETURN jsonb_build_object(
    'duplicate', false, 'eventKey', event_key, 'requestId', request.id,
    'organizationId', request.organization_id, 'resultCode', p_result_code,
    'status', event_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_platform_billing_configuration(),
  public.rpc_platform_update_billing_configuration(text,numeric,text,text,boolean),
  public.rpc_prepare_my_momo_checkout(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_platform_billing_configuration(),
  public.rpc_platform_update_billing_configuration(text,numeric,text,text,boolean),
  public.rpc_prepare_my_momo_checkout(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_record_momo_checkout_response(uuid,text,integer,text),
  public.rpc_apply_momo_ipn(text,numeric,integer,text,timestamptz,text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_record_momo_checkout_response(uuid,text,integer,text),
  public.rpc_apply_momo_ipn(text,numeric,integer,text,timestamptz,text)
  TO service_role;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0084', 'Add MoMo checkout, signed IPN application and explicit tax policy')
ON CONFLICT (version) DO NOTHING;

COMMIT;
