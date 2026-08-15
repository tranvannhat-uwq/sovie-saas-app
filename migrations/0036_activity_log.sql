BEGIN;

-- User-facing activity history is separate from the existing low-level
-- audit_logs table. Existing audit rows and every business row stay untouched.
CREATE TABLE IF NOT EXISTS public.activity_logs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  operation_key text NOT NULL,
  actor_id uuid NOT NULL,
  actor_profile_id text,
  actor_username text,
  actor_name text NOT NULL,
  actor_role text,
  action text NOT NULL,
  module text NOT NULL,
  target_type text NOT NULL,
  target_id text NOT NULL,
  target_name text,
  order_id text,
  customer_id text,
  company_id text,
  description text,
  old_value jsonb,
  new_value jsonb,
  changes jsonb NOT NULL DEFAULT '{}'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT activity_logs_one_target_per_operation_uidx
    UNIQUE (operation_key, module, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS activity_logs_created_at_idx ON public.activity_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS activity_logs_actor_idx ON public.activity_logs(actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_logs_module_idx ON public.activity_logs(module, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_logs_action_idx ON public.activity_logs(action, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_logs_target_idx ON public.activity_logs(target_type, target_id, created_at DESC);
CREATE INDEX IF NOT EXISTS activity_logs_order_idx ON public.activity_logs(order_id, created_at DESC) WHERE order_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activity_logs_customer_idx ON public.activity_logs(customer_id, created_at DESC) WHERE customer_id IS NOT NULL;

ALTER TABLE public.activity_logs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.activity_logs FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.p36_activity_changes(p_old jsonb, p_new jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  WITH ignored(key) AS (VALUES
    ('created_at'), ('updated_at'), ('updated_by'), ('created_by'),
    ('cancelled_at'), ('cancelled_by'), ('canceled_at'), ('canceled_by'),
    ('idempotency_key'), ('request_fingerprint'), ('password'),
    ('password_hash'), ('token'), ('auth_user_id')
  ), keys AS (
    SELECT key FROM jsonb_object_keys(COALESCE(p_old, '{}'::jsonb)) key
    UNION
    SELECT key FROM jsonb_object_keys(COALESCE(p_new, '{}'::jsonb)) key
  )
  SELECT COALESCE(jsonb_object_agg(keys.key, jsonb_build_object(
    'old', p_old->keys.key, 'new', p_new->keys.key
  )), '{}'::jsonb)
  FROM keys
  WHERE NOT EXISTS (SELECT 1 FROM ignored WHERE ignored.key = keys.key)
    AND p_old->keys.key IS DISTINCT FROM p_new->keys.key
$$;

CREATE OR REPLACE FUNCTION public.p36_log_activity_row()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  old_row jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  diff jsonb;
  old_summary jsonb;
  new_summary jsonb;
  source jsonb;
  activity_action text;
  activity_module text;
  activity_target_type text;
  activity_target_id text;
  activity_target_name text;
  activity_order_id text;
  activity_customer_id text;
  activity_company_id text;
  activity_description text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT * INTO actor FROM public.profiles
  WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF;

  diff := public.p36_activity_changes(old_row, new_row);
  IF TG_OP = 'UPDATE' AND diff = '{}'::jsonb THEN RETURN NEW; END IF;
  SELECT COALESCE(jsonb_object_agg(key, value->'old'),'{}'::jsonb),
         COALESCE(jsonb_object_agg(key, value->'new'),'{}'::jsonb)
  INTO old_summary, new_summary
  FROM jsonb_each(diff);
  source := CASE WHEN TG_OP = 'DELETE' THEN old_row ELSE new_row END;
  activity_target_id := COALESCE(source->>'id', source->>'code');
  IF activity_target_id IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;

  CASE TG_TABLE_NAME
    WHEN 'orders' THEN
      activity_module := 'orders'; activity_target_type := 'order';
      activity_target_name := COALESCE(source->>'customer_name', activity_target_id);
      activity_order_id := activity_target_id; activity_customer_id := source->>'customer_id';
      activity_company_id := source->>'company_id';
      activity_action := CASE
        WHEN TG_OP = 'INSERT' THEN 'create_order'
        WHEN TG_OP = 'DELETE' THEN 'delete_order'
        WHEN diff ? 'status' AND lower(COALESCE(new_row->>'status','')) IN ('cancelled','canceled') THEN 'cancel_order'
        WHEN diff ? 'status' THEN 'change_order_status'
        WHEN diff ? 'paid_amount' OR diff ? 'payment_status' OR diff ? 'payment_method' THEN 'confirm_payment'
        WHEN (SELECT count(*) FROM jsonb_object_keys(diff)) = 1 AND diff ? 'notes' THEN 'update_order_notes'
        ELSE 'update_order' END;
    WHEN 'customers' THEN
      activity_module := 'customers'; activity_target_type := 'customer';
      activity_target_name := COALESCE(source->>'name', source->>'code', activity_target_id);
      activity_customer_id := activity_target_id;
      activity_action := CASE WHEN TG_OP='INSERT' THEN 'create_customer' WHEN TG_OP='DELETE' THEN 'delete_customer' ELSE 'update_customer' END;
    WHEN 'profiles' THEN
      activity_module := 'employees'; activity_target_type := 'employee';
      activity_target_name := COALESCE(source->>'display_name', source->>'username', activity_target_id);
      activity_company_id := source->>'company_id';
      activity_action := CASE WHEN TG_OP='INSERT' THEN 'create_employee' WHEN TG_OP='DELETE' THEN 'delete_employee'
        WHEN diff ? 'role' THEN 'change_employee_role' WHEN diff ? 'is_active' THEN 'change_employee_status' ELSE 'update_employee' END;
    WHEN 'payments' THEN
      activity_module := 'payments'; activity_target_type := 'payment';
      activity_order_id := source->>'order_id'; activity_customer_id := source->>'customer_id';
      activity_target_name := activity_target_id;
      activity_action := CASE WHEN TG_OP='INSERT' THEN 'confirm_payment' WHEN diff ? 'status' THEN 'change_payment_status' ELSE 'update_payment' END;
    WHEN 'sales_returns' THEN
      activity_module := 'returns'; activity_target_type := 'sales_return';
      activity_order_id := COALESCE(source->>'sale_id', source->>'order_id'); activity_customer_id := source->>'customer_id';
      activity_target_name := activity_target_id;
      activity_action := CASE WHEN TG_OP='INSERT' THEN 'create_sales_return'
        WHEN diff ? 'status' AND lower(COALESCE(new_row->>'status','')) IN ('cancelled','canceled') THEN 'cancel_sales_return' ELSE 'update_sales_return' END;
    WHEN 'cashbook_transactions' THEN
      activity_module := 'cashbook'; activity_target_type := 'cashbook_transaction';
      activity_order_id := source->>'order_id'; activity_customer_id := source->>'customer_id';
      activity_target_name := COALESCE(source->>'partner', activity_target_id);
      activity_action := CASE WHEN TG_OP='INSERT' THEN 'create_cashbook_transaction'
        WHEN diff ? 'status' AND lower(COALESCE(new_row->>'status','')) IN ('cancelled','canceled') THEN 'cancel_cashbook_transaction' ELSE 'update_cashbook_transaction' END;
    WHEN 'suppliers' THEN activity_module := 'suppliers'; activity_target_type := 'supplier'; activity_target_name := COALESCE(source->>'name',activity_target_id); activity_action := CASE WHEN TG_OP='INSERT' THEN 'create_supplier' WHEN TG_OP='DELETE' THEN 'delete_supplier' ELSE 'update_supplier' END;
    WHEN 'purchases' THEN activity_module := 'purchases'; activity_target_type := 'purchase'; activity_target_name := COALESCE(source->>'code',activity_target_id); activity_action := CASE WHEN TG_OP='INSERT' THEN 'create_purchase' WHEN diff ? 'status' AND lower(COALESCE(new_row->>'status','')) IN ('cancelled','canceled') THEN 'cancel_purchase' ELSE 'update_purchase' END;
    WHEN 'products' THEN activity_module := 'products'; activity_target_type := 'product'; activity_target_name := COALESCE(source->>'name',source->>'code',activity_target_id); activity_action := CASE WHEN TG_OP='INSERT' THEN 'create_product' WHEN TG_OP='DELETE' THEN 'delete_product' ELSE 'update_product' END;
    WHEN 'brands' THEN activity_module := 'brands'; activity_target_type := 'brand'; activity_target_name := COALESCE(source->>'name',activity_target_id); activity_action := CASE WHEN TG_OP='INSERT' THEN 'create_brand' WHEN TG_OP='DELETE' THEN 'delete_brand' ELSE 'update_brand' END;
    WHEN 'pricelists' THEN activity_module := 'pricelists'; activity_target_type := 'pricelist'; activity_target_name := COALESCE(source->>'name',activity_target_id); activity_action := CASE WHEN TG_OP='INSERT' THEN 'create_pricelist' WHEN TG_OP='DELETE' THEN 'delete_pricelist' ELSE 'update_pricelist' END;
    ELSE RETURN COALESCE(NEW, OLD);
  END CASE;

  activity_description := activity_action || ':' || activity_target_id;
  INSERT INTO public.activity_logs(
    operation_key, actor_id, actor_profile_id, actor_username, actor_name, actor_role,
    action, module, target_type, target_id, target_name, order_id, customer_id,
    company_id, description, old_value, new_value, changes, metadata, created_at
  ) VALUES (
    txid_current()::text, actor.auth_user_id, actor.id, actor.username, actor.display_name, actor.role,
    activity_action, activity_module, activity_target_type, activity_target_id,
    activity_target_name, activity_order_id, activity_customer_id, activity_company_id,
    activity_description, NULLIF(old_summary,'{}'::jsonb), NULLIF(new_summary,'{}'::jsonb), diff,
    jsonb_build_object('table',TG_TABLE_NAME,'operation',TG_OP), now()
  )
  ON CONFLICT (operation_key,module,target_type,target_id) DO UPDATE SET
    action = EXCLUDED.action,
    target_name = COALESCE(EXCLUDED.target_name, public.activity_logs.target_name),
    order_id = COALESCE(EXCLUDED.order_id, public.activity_logs.order_id),
    customer_id = COALESCE(EXCLUDED.customer_id, public.activity_logs.customer_id),
    new_value = COALESCE(EXCLUDED.new_value, public.activity_logs.new_value),
    changes = public.activity_logs.changes || EXCLUDED.changes,
    metadata = public.activity_logs.metadata || EXCLUDED.metadata;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DO $migration$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['orders','customers','profiles','payments','sales_returns','cashbook_transactions','suppliers','purchases','products','brands','pricelists'] LOOP
    IF to_regclass('public.' || target) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS p36_activity_row ON public.%I', target);
    EXECUTE format('CREATE TRIGGER p36_activity_row AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.p36_log_activity_row()', target);
  END LOOP;
END
$migration$;

CREATE OR REPLACE FUNCTION public.rpc_get_activity_logs(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; page_limit integer; page_offset integer; result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin','accounting') THEN RAISE EXCEPTION '403: activity log access denied' USING ERRCODE='42501'; END IF;
  page_limit := LEAST(GREATEST(COALESCE((p_filters->>'limit')::integer,25),1),100);
  page_offset := GREATEST(COALESCE((p_filters->>'offset')::integer,0),0);
  WITH filtered AS (
    SELECT log.* FROM public.activity_logs log WHERE
      (NULLIF(p_filters->>'search','') IS NULL OR concat_ws(' ',log.target_id,log.target_name,log.actor_name,log.actor_username,log.order_id,log.customer_id) ILIKE ('%' || (p_filters->>'search') || '%'))
      AND (NULLIF(p_filters->>'actor_id','') IS NULL OR p_filters->>'actor_id'='all' OR log.actor_id::text=p_filters->>'actor_id' OR log.actor_profile_id=p_filters->>'actor_id')
      AND (NULLIF(p_filters->>'module','') IS NULL OR p_filters->>'module'='all' OR log.module=p_filters->>'module')
      AND (NULLIF(p_filters->>'action','') IS NULL OR p_filters->>'action'='all' OR log.action=p_filters->>'action')
      AND (NULLIF(p_filters->>'order_id','') IS NULL OR log.order_id=p_filters->>'order_id')
      AND (NULLIF(p_filters->>'customer_id','') IS NULL OR log.customer_id=p_filters->>'customer_id')
      AND (NULLIF(p_filters->>'start','') IS NULL OR log.created_at >= (p_filters->>'start')::timestamptz)
      AND (NULLIF(p_filters->>'end','') IS NULL OR log.created_at < (p_filters->>'end')::timestamptz)
  ), page AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT page_limit OFFSET page_offset)
  SELECT jsonb_build_object('rows',COALESCE((SELECT jsonb_agg(to_jsonb(page) ORDER BY created_at DESC,id DESC) FROM page),'[]'::jsonb),'total',(SELECT count(*) FROM filtered),'limit',page_limit,'offset',page_offset) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_order_activity(p_order_id text, p_limit integer DEFAULT 50)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role='sale' AND NOT EXISTS (SELECT 1 FROM public.orders sale WHERE sale.id=p_order_id AND (
    sale.created_by=actor.auth_user_id::text
    OR sale.salesperson_id IN (actor.auth_user_id::text,actor.username)
    OR (sale.customer_id IS NOT NULL AND public.can_access_customer(sale.customer_id))
  )) THEN
    RAISE EXCEPTION '403: order activity access denied' USING ERRCODE='42501';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(log) ORDER BY log.created_at DESC,log.id DESC),'[]'::jsonb) INTO result
  FROM (SELECT * FROM public.activity_logs WHERE order_id=p_order_id ORDER BY created_at DESC,id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),100)) log;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION public.p36_activity_changes(jsonb,jsonb), public.p36_log_activity_row() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.rpc_get_activity_logs(jsonb), public.rpc_get_order_activity(text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_activity_logs(jsonb), public.rpc_get_order_activity(text,integer) TO authenticated;

INSERT INTO public.schema_migrations(version,description) VALUES ('0036','Add append-only authenticated Activity Log with paginated scoped readers') ON CONFLICT(version) DO NOTHING;
COMMIT;
