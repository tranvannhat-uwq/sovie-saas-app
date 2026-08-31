BEGIN;

ALTER TABLE public.organization_subscriptions
  ADD COLUMN IF NOT EXISTS grace_ends_at timestamptz,
  ADD COLUMN IF NOT EXISTS read_only_ends_at timestamptz;

CREATE TABLE public.subscription_state_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_key text NOT NULL UNIQUE,
  source text NOT NULL,
  from_status text,
  to_status text NOT NULL,
  plan_id text NOT NULL REFERENCES public.saas_plans(id),
  payload_hash text,
  applied_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT subscription_state_events_status_check
    CHECK (to_status IN ('trialing','active','past_due','paused','cancelled')),
  CONSTRAINT subscription_state_events_source_check
    CHECK (source IN ('stripe','manual','migration','system'))
);
CREATE INDEX subscription_state_events_organization_idx
  ON public.subscription_state_events (organization_id, applied_at DESC);

ALTER TABLE public.subscription_state_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.subscription_state_events FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.subscription_state_events TO authenticated;
CREATE POLICY subscription_state_events_owner_read ON public.subscription_state_events
FOR SELECT TO authenticated USING (
  public.has_organization_role(organization_id, ARRAY['owner'])
);

UPDATE public.organization_subscriptions
SET grace_ends_at = COALESCE(grace_ends_at, current_period_end, updated_at) + interval '7 days'
WHERE status = 'past_due' AND grace_ends_at IS NULL;
UPDATE public.organization_subscriptions
SET read_only_ends_at = COALESCE(read_only_ends_at, updated_at + interval '30 days')
WHERE status = 'cancelled' AND read_only_ends_at IS NULL;

CREATE OR REPLACE FUNCTION public.organization_write_access_allowed(p_organization_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT COALESCE(
    p_organization_id = public.current_organization_id()
    AND organization.status NOT IN ('suspended','cancelled')
    AND CASE subscription.status
      WHEN 'active' THEN true
      WHEN 'trialing' THEN now() <= COALESCE(
        subscription.current_period_end, organization.trial_ends_at, subscription.created_at
      )
      WHEN 'past_due' THEN now() <= COALESCE(
        subscription.grace_ends_at,
        subscription.current_period_end + interval '7 days',
        subscription.updated_at + interval '7 days'
      )
      ELSE false
    END,
    false
  )
  FROM public.organizations organization
  LEFT JOIN LATERAL (
    SELECT candidate.*
    FROM public.organization_subscriptions candidate
    WHERE candidate.organization_id = organization.id
    ORDER BY candidate.updated_at DESC, candidate.created_at DESC
    LIMIT 1
  ) subscription ON true
  WHERE organization.id = p_organization_id
$$;

REVOKE ALL ON FUNCTION public.organization_write_access_allowed(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.organization_write_access_allowed(uuid)
  TO authenticated, saas_rpc_executor;

-- Reads remain available. Every business mutation receives an additional
-- restrictive subscription guard, including writes performed by the
-- NOLOGIN/NOBYPASSRLS RPC executor.
DO $subscription_guards$
DECLARE
  table_name text;
  business_tables constant text[] := ARRAY[
    'companies', 'customers', 'brands', 'product_groups', 'products',
    'pricelists', 'price_list_items', 'orders', 'draft_orders', 'order_items',
    'cashbook_transactions', 'payments', 'sales_returns', 'sales_return_items',
    'customer_debt_transactions', 'finished_goods_stock', 'raw_materials',
    'semi_finished', 'recipes', 'production_logs', 'audit_logs',
    'commission_transactions', 'customer_assignments', 'commission_rules',
    'starting_balances', 'suppliers', 'purchases', 'purchase_items',
    'purchase_payments', 'supplier_debt_transactions', 'kpi_targets',
    'payroll_periods', 'payroll_adjustments', 'payroll_entries', 'activity_logs'
  ];
BEGIN
  FOREACH table_name IN ARRAY business_tables LOOP
    EXECUTE format('DROP POLICY IF EXISTS subscription_insert_guard ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS subscription_update_guard ON public.%I', table_name);
    EXECUTE format('DROP POLICY IF EXISTS subscription_delete_guard ON public.%I', table_name);
    EXECUTE format(
      'CREATE POLICY subscription_insert_guard ON public.%I AS RESTRICTIVE FOR INSERT TO authenticated, saas_rpc_executor WITH CHECK (public.organization_write_access_allowed(organization_id))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY subscription_update_guard ON public.%I AS RESTRICTIVE FOR UPDATE TO authenticated, saas_rpc_executor USING (public.organization_write_access_allowed(organization_id)) WITH CHECK (public.organization_write_access_allowed(organization_id))',
      table_name
    );
    EXECUTE format(
      'CREATE POLICY subscription_delete_guard ON public.%I AS RESTRICTIVE FOR DELETE TO authenticated, saas_rpc_executor USING (public.organization_write_access_allowed(organization_id))',
      table_name
    );
  END LOOP;
END;
$subscription_guards$;

CREATE OR REPLACE FUNCTION public.rpc_apply_subscription_state(
  p_event_key text,
  p_organization_id uuid,
  p_plan_id text,
  p_status text,
  p_source text DEFAULT 'stripe',
  p_current_period_start timestamptz DEFAULT NULL,
  p_current_period_end timestamptz DEFAULT NULL,
  p_provider text DEFAULT NULL,
  p_provider_customer_id text DEFAULT NULL,
  p_provider_subscription_id text DEFAULT NULL,
  p_payload_hash text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized_event_key text := btrim(COALESCE(p_event_key, ''));
  normalized_status text := lower(btrim(COALESCE(p_status, '')));
  normalized_source text := lower(btrim(COALESCE(p_source, 'stripe')));
  prior_status text;
  current_subscription public.organization_subscriptions%ROWTYPE;
BEGIN
  IF char_length(normalized_event_key) NOT BETWEEN 4 AND 240 THEN
    RAISE EXCEPTION 'Subscription event key is required' USING ERRCODE = '22023';
  END IF;
  IF normalized_status NOT IN ('trialing','active','past_due','paused','cancelled') THEN
    RAISE EXCEPTION 'Unsupported subscription status' USING ERRCODE = '22023';
  END IF;
  IF normalized_source NOT IN ('stripe','manual','migration','system') THEN
    RAISE EXCEPTION 'Unsupported subscription event source' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.saas_plans plan WHERE plan.id = p_plan_id AND plan.is_active) THEN
    RAISE EXCEPTION 'Active SaaS plan not found' USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (SELECT 1 FROM public.subscription_state_events event WHERE event.event_key = normalized_event_key) THEN
    RETURN jsonb_build_object('duplicate', true, 'eventKey', normalized_event_key);
  END IF;

  PERFORM 1 FROM public.organizations organization
  WHERE organization.id = p_organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE = 'P0002';
  END IF;

  -- Recheck after the organization lock so concurrent deliveries of the same
  -- provider event cannot both pass the optimistic check above.
  IF EXISTS (SELECT 1 FROM public.subscription_state_events event WHERE event.event_key = normalized_event_key) THEN
    RETURN jsonb_build_object('duplicate', true, 'eventKey', normalized_event_key);
  END IF;

  SELECT subscription.* INTO current_subscription
  FROM public.organization_subscriptions subscription
  WHERE subscription.organization_id = p_organization_id
    AND subscription.status IN ('trialing','active','past_due','paused')
  ORDER BY subscription.updated_at DESC, subscription.created_at DESC LIMIT 1
  FOR UPDATE;
  prior_status := current_subscription.status;

  IF FOUND THEN
    UPDATE public.organization_subscriptions
    SET plan_id = p_plan_id,
        status = normalized_status,
        provider = COALESCE(NULLIF(p_provider, ''), provider),
        provider_customer_id = COALESCE(NULLIF(p_provider_customer_id, ''), provider_customer_id),
        provider_subscription_id = COALESCE(NULLIF(p_provider_subscription_id, ''), provider_subscription_id),
        current_period_start = COALESCE(p_current_period_start, current_period_start),
        current_period_end = COALESCE(p_current_period_end, current_period_end),
        grace_ends_at = CASE WHEN normalized_status = 'past_due'
          THEN COALESCE(p_current_period_end, now()) + interval '7 days' ELSE NULL END,
        read_only_ends_at = CASE WHEN normalized_status = 'cancelled'
          THEN now() + interval '30 days' ELSE NULL END,
        updated_at = now()
    WHERE id = current_subscription.id;
  ELSE
    INSERT INTO public.organization_subscriptions (
      organization_id, plan_id, status, provider, provider_customer_id,
      provider_subscription_id, current_period_start, current_period_end,
      grace_ends_at, read_only_ends_at
    ) VALUES (
      p_organization_id, p_plan_id, normalized_status, NULLIF(p_provider, ''),
      NULLIF(p_provider_customer_id, ''), NULLIF(p_provider_subscription_id, ''),
      p_current_period_start, p_current_period_end,
      CASE WHEN normalized_status = 'past_due'
        THEN COALESCE(p_current_period_end, now()) + interval '7 days' END,
      NULL
    );
  END IF;

  UPDATE public.organizations
  SET status = CASE normalized_status
      WHEN 'paused' THEN 'suspended'
      WHEN 'cancelled' THEN 'cancelled'
      ELSE normalized_status
    END,
    updated_at = now()
  WHERE id = p_organization_id;

  INSERT INTO public.subscription_state_events (
    organization_id, event_key, source, from_status, to_status, plan_id, payload_hash
  ) VALUES (
    p_organization_id, normalized_event_key, normalized_source,
    prior_status, normalized_status, p_plan_id, NULLIF(p_payload_hash, '')
  );

  RETURN jsonb_build_object(
    'duplicate', false, 'eventKey', normalized_event_key,
    'organizationId', p_organization_id, 'fromStatus', prior_status,
    'status', normalized_status, 'planId', p_plan_id,
    'writeAllowed', normalized_status IN ('trialing','active','past_due')
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_apply_subscription_state(
  text,uuid,text,text,text,timestamptz,timestamptz,text,text,text,text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_apply_subscription_state(
  text,uuid,text,text,text,timestamptz,timestamptz,text,text,text,text
) TO service_role;

CREATE OR REPLACE FUNCTION public.rpc_my_subscription_access()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  result jsonb;
BEGIN
  IF active_organization_id IS NULL THEN
    RAISE EXCEPTION '403: active organization membership required' USING ERRCODE = '42501';
  END IF;
  SELECT jsonb_build_object(
    'organizationId', organization.id,
    'organizationStatus', organization.status,
    'planId', subscription.plan_id,
    'status', subscription.status,
    'writeAllowed', public.organization_write_access_allowed(organization.id),
    'accessMode', CASE
      WHEN public.organization_write_access_allowed(organization.id) AND subscription.status = 'past_due' THEN 'grace'
      WHEN public.organization_write_access_allowed(organization.id) THEN 'full'
      ELSE 'read_only'
    END,
    'currentPeriodEnd', subscription.current_period_end,
    'graceEndsAt', subscription.grace_ends_at,
    'readOnlyEndsAt', subscription.read_only_ends_at
  ) INTO result
  FROM public.organizations organization
  LEFT JOIN LATERAL (
    SELECT candidate.* FROM public.organization_subscriptions candidate
    WHERE candidate.organization_id = organization.id
    ORDER BY candidate.updated_at DESC, candidate.created_at DESC LIMIT 1
  ) subscription ON true
  WHERE organization.id = active_organization_id;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_my_subscription_access() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_my_subscription_access() TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0068', 'Enforce subscription lifecycle write access and idempotent provider events')
ON CONFLICT (version) DO NOTHING;

COMMIT;
