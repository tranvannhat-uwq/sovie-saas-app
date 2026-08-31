BEGIN;

ALTER TABLE public.saas_plans
  ADD COLUMN IF NOT EXISTS price_yearly numeric(14,2) NOT NULL DEFAULT 0
    CHECK (price_yearly >= 0),
  ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 100
    CHECK (sort_order BETWEEN 0 AND 10000);

UPDATE public.saas_plans
SET sort_order = CASE id WHEN 'starter' THEN 10 WHEN 'pro' THEN 20 WHEN 'business' THEN 30 ELSE sort_order END
WHERE id IN ('starter','pro','business');

ALTER TABLE public.platform_customer_events
  DROP CONSTRAINT IF EXISTS platform_customer_events_event_type_check;
ALTER TABLE public.platform_customer_events
  ADD CONSTRAINT platform_customer_events_event_type_check CHECK (event_type IN (
    'customer_provisioned','plan_changed','trial_extended',
    'customer_suspended','customer_reactivated','customer_cancelled',
    'plan_catalog_updated'
  ));

CREATE OR REPLACE FUNCTION public.rpc_platform_plan_catalog()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.is_platform_staff(ARRAY['platform_owner','billing','analyst']) THEN
    RAISE EXCEPTION '403: platform pricing access required' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', plan.id,
      'name', plan.name,
      'description', plan.description,
      'priceMonthly', plan.price_monthly,
      'priceYearly', plan.price_yearly,
      'currency', plan.currency,
      'limits', plan.limits,
      'isPublic', plan.is_public,
      'isActive', plan.is_active,
      'sortOrder', plan.sort_order,
      'updatedAt', plan.updated_at
    ) ORDER BY plan.sort_order, plan.price_monthly, plan.id)
    FROM public.saas_plans plan
  ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_platform_update_plan(
  p_plan_id text,
  p_name text,
  p_description text,
  p_price_monthly numeric,
  p_price_yearly numeric,
  p_currency text,
  p_limits jsonb,
  p_is_public boolean,
  p_is_active boolean,
  p_sort_order integer DEFAULT 100
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := auth.uid();
  normalized_plan_id text := lower(btrim(COALESCE(p_plan_id, '')));
  normalized_name text := btrim(COALESCE(p_name, ''));
  normalized_description text := btrim(COALESCE(p_description, ''));
  normalized_currency text := upper(btrim(COALESCE(p_currency, 'VND')));
  previous_plan public.saas_plans%ROWTYPE;
  updated_plan public.saas_plans%ROWTYPE;
  limit_key text;
  limit_value integer;
  allowed_limits constant text[] := ARRAY['users','branches','warehouses','monthly_orders','custom_domains'];
BEGIN
  IF actor_id IS NULL OR NOT public.is_platform_staff(ARRAY['platform_owner']) THEN
    RAISE EXCEPTION '403: platform owner required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO previous_plan FROM public.saas_plans plan
  WHERE plan.id = normalized_plan_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'SaaS plan not found' USING ERRCODE = 'P0002';
  END IF;
  IF char_length(normalized_name) NOT BETWEEN 2 AND 80
    OR char_length(normalized_description) > 500 THEN
    RAISE EXCEPTION 'Valid plan name and description required' USING ERRCODE = '22023';
  END IF;
  IF COALESCE(p_price_monthly, -1) < 0 OR COALESCE(p_price_monthly, 0) > 1000000000
    OR COALESCE(p_price_yearly, -1) < 0 OR COALESCE(p_price_yearly, 0) > 12000000000 THEN
    RAISE EXCEPTION 'Plan prices are outside the supported range' USING ERRCODE = '22023';
  END IF;
  IF normalized_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'Currency must use a three-letter ISO code' USING ERRCODE = '22023';
  END IF;
  IF p_sort_order IS NULL OR p_sort_order NOT BETWEEN 0 AND 10000 THEN
    RAISE EXCEPTION 'Plan sort order must contain 0 to 10000' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(COALESCE(p_limits, 'null'::jsonb)) <> 'object' THEN
    RAISE EXCEPTION 'Plan limits must be a JSON object' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_object_keys(p_limits) AS keys(limit_name)
    WHERE limit_name <> ALL(allowed_limits)
  ) THEN
    RAISE EXCEPTION 'Unsupported plan limit key' USING ERRCODE = '22023';
  END IF;
  FOREACH limit_key IN ARRAY allowed_limits LOOP
    IF NOT p_limits ? limit_key OR (p_limits->>limit_key) !~ '^-?[0-9]+$' THEN
      RAISE EXCEPTION 'Every supported plan limit must be an integer' USING ERRCODE = '22023';
    END IF;
    limit_value := (p_limits->>limit_key)::integer;
    IF (limit_key = 'custom_domains' AND limit_value NOT BETWEEN 0 AND 100)
      OR (limit_key <> 'custom_domains' AND limit_value NOT BETWEEN 1 AND 10000000) THEN
      RAISE EXCEPTION 'Plan limit is outside the supported range' USING ERRCODE = '22023';
    END IF;
  END LOOP;
  IF COALESCE(p_is_public, false) AND NOT COALESCE(p_is_active, false) THEN
    RAISE EXCEPTION 'A public plan must also be active' USING ERRCODE = '22023';
  END IF;

  UPDATE public.saas_plans
  SET name = normalized_name,
      description = normalized_description,
      price_monthly = p_price_monthly,
      price_yearly = p_price_yearly,
      currency = normalized_currency,
      limits = p_limits,
      is_public = COALESCE(p_is_public, false),
      is_active = COALESCE(p_is_active, false),
      sort_order = p_sort_order,
      updated_at = now()
  WHERE id = normalized_plan_id
  RETURNING * INTO updated_plan;

  INSERT INTO public.platform_customer_events (
    actor_auth_user_id, organization_id, event_type, payload
  ) VALUES (
    actor_id, NULL, 'plan_catalog_updated',
    jsonb_build_object(
      'planId', updated_plan.id,
      'before', jsonb_build_object(
        'name', previous_plan.name, 'priceMonthly', previous_plan.price_monthly,
        'priceYearly', previous_plan.price_yearly, 'currency', previous_plan.currency,
        'limits', previous_plan.limits, 'isPublic', previous_plan.is_public,
        'isActive', previous_plan.is_active, 'sortOrder', previous_plan.sort_order
      ),
      'after', jsonb_build_object(
        'name', updated_plan.name, 'priceMonthly', updated_plan.price_monthly,
        'priceYearly', updated_plan.price_yearly, 'currency', updated_plan.currency,
        'limits', updated_plan.limits, 'isPublic', updated_plan.is_public,
        'isActive', updated_plan.is_active, 'sortOrder', updated_plan.sort_order
      )
    )
  );

  RETURN jsonb_build_object(
    'id', updated_plan.id, 'name', updated_plan.name,
    'description', updated_plan.description,
    'priceMonthly', updated_plan.price_monthly,
    'priceYearly', updated_plan.price_yearly,
    'currency', updated_plan.currency, 'limits', updated_plan.limits,
    'isPublic', updated_plan.is_public, 'isActive', updated_plan.is_active,
    'sortOrder', updated_plan.sort_order, 'updatedAt', updated_plan.updated_at
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_platform_active_plans()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NOT public.is_platform_staff(ARRAY['platform_owner','billing']) THEN
    RAISE EXCEPTION '403: platform billing access required' USING ERRCODE = '42501';
  END IF;
  RETURN COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'id', plan.id, 'name', plan.name, 'description', plan.description,
      'priceMonthly', plan.price_monthly, 'priceYearly', plan.price_yearly,
      'currency', plan.currency, 'limits', plan.limits,
      'isPublic', plan.is_public, 'isActive', plan.is_active,
      'sortOrder', plan.sort_order
    ) ORDER BY plan.sort_order, plan.price_monthly, plan.id)
    FROM public.saas_plans plan WHERE plan.is_active
  ), '[]'::jsonb);
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
      'priceMonthly', plan.price_monthly, 'priceYearly', plan.price_yearly,
      'currency', plan.currency, 'limits', plan.limits
    ) ORDER BY plan.sort_order, plan.price_monthly) FROM public.saas_plans plan
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

REVOKE ALL ON FUNCTION public.rpc_platform_plan_catalog(),
  public.rpc_platform_update_plan(text,text,text,numeric,numeric,text,jsonb,boolean,boolean,integer)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_platform_plan_catalog(),
  public.rpc_platform_update_plan(text,text,text,numeric,numeric,text,jsonb,boolean,boolean,integer)
  TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0083', 'Add platform-owned commercial plan catalog and annual pricing')
ON CONFLICT (version) DO NOTHING;

COMMIT;
