BEGIN;

CREATE INDEX IF NOT EXISTS orders_organization_confirmed_month_idx
  ON public.orders (organization_id, confirmed_at)
  WHERE status NOT IN ('draft','cancelled','canceled');

CREATE OR REPLACE FUNCTION public.enforce_monthly_order_quota()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  order_limit integer;
  order_count integer;
  month_start timestamptz;
  month_end timestamptz;
BEGIN
  IF lower(COALESCE(NEW.status, 'settled')) IN ('draft','cancelled','canceled') THEN
    RETURN NEW;
  END IF;
  IF NEW.organization_id IS NULL OR NEW.organization_id <> public.current_organization_id() THEN
    RAISE EXCEPTION '403: active organization does not match order tenant'
      USING ERRCODE = '42501';
  END IF;

  -- Serialize consumption so two confirmations cannot both claim the final
  -- slot in the same plan allowance.
  PERFORM 1 FROM public.organizations organization
  WHERE organization.id = NEW.organization_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Organization not found' USING ERRCODE = 'P0002';
  END IF;

  SELECT COALESCE((plan.limits->>'monthly_orders')::integer, 500)
  INTO order_limit
  FROM public.organization_subscriptions subscription
  JOIN public.saas_plans plan ON plan.id = subscription.plan_id
  WHERE subscription.organization_id = NEW.organization_id
  ORDER BY subscription.updated_at DESC, subscription.created_at DESC
  LIMIT 1;
  order_limit := COALESCE(order_limit, 500);

  IF order_limit < 0 THEN RETURN NEW; END IF;

  month_start := date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok')
    AT TIME ZONE 'Asia/Bangkok';
  month_end := month_start + interval '1 month';

  SELECT count(*) INTO order_count
  FROM public.orders sale
  WHERE sale.organization_id = NEW.organization_id
    AND lower(COALESCE(sale.status, 'settled')) NOT IN ('draft','cancelled','canceled')
    AND COALESCE(sale.confirmed_at, sale.created_at) >= month_start
    AND COALESCE(sale.confirmed_at, sale.created_at) < month_end;

  IF order_count >= order_limit THEN
    RAISE EXCEPTION 'Monthly order limit reached (% orders)', order_limit
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS orders_enforce_monthly_quota ON public.orders;
CREATE TRIGGER orders_enforce_monthly_quota
BEFORE INSERT ON public.orders
FOR EACH ROW EXECUTE FUNCTION public.enforce_monthly_order_quota();

REVOKE ALL ON FUNCTION public.enforce_monthly_order_quota()
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.rpc_my_plan_usage()
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  active_organization_id uuid := public.current_organization_id();
  plan_id text;
  plan_limits jsonb := '{}'::jsonb;
  members_used integer := 0;
  orders_used integer := 0;
  month_start timestamptz;
  month_end timestamptz;
BEGIN
  IF active_organization_id IS NULL THEN
    RAISE EXCEPTION '403: active organization membership required' USING ERRCODE = '42501';
  END IF;
  month_start := date_trunc('month', now() AT TIME ZONE 'Asia/Bangkok')
    AT TIME ZONE 'Asia/Bangkok';
  month_end := month_start + interval '1 month';

  SELECT plan.id, plan.limits INTO plan_id, plan_limits
  FROM public.organization_subscriptions subscription
  JOIN public.saas_plans plan ON plan.id = subscription.plan_id
  WHERE subscription.organization_id = active_organization_id
  ORDER BY subscription.updated_at DESC, subscription.created_at DESC LIMIT 1;

  SELECT count(*) INTO members_used
  FROM public.organization_memberships membership
  WHERE membership.organization_id = active_organization_id
    AND membership.status IN ('active','invited');

  SELECT count(*) INTO orders_used
  FROM public.orders sale
  WHERE sale.organization_id = active_organization_id
    AND lower(COALESCE(sale.status, 'settled')) NOT IN ('draft','cancelled','canceled')
    AND COALESCE(sale.confirmed_at, sale.created_at) >= month_start
    AND COALESCE(sale.confirmed_at, sale.created_at) < month_end;

  RETURN jsonb_build_object(
    'organizationId', active_organization_id,
    'planId', plan_id,
    'periodStart', month_start,
    'periodEnd', month_end,
    'members', jsonb_build_object(
      'used', members_used, 'limit', COALESCE((plan_limits->>'users')::integer, 5)
    ),
    'orders', jsonb_build_object(
      'used', orders_used, 'limit', COALESCE((plan_limits->>'monthly_orders')::integer, 500)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_my_plan_usage() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_my_plan_usage() TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0069', 'Enforce serialized monthly order quota and expose tenant plan usage')
ON CONFLICT (version) DO NOTHING;

COMMIT;
