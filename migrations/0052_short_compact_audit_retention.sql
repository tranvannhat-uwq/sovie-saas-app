BEGIN;

-- This migration only reads business tables. It writes/deletes audit_logs and
-- activity_logs; business rows are never changed by retention or compaction.
CREATE OR REPLACE FUNCTION public.p52_is_important_change_field(p_key text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT lower(COALESCE(p_key, '')) = ANY (ARRAY[
    'status', 'notes', 'note', 'reason', 'role', 'is_active', 'items',
    'type', 'transaction_type', 'operation_type', 'category', 'partner',
    'method', 'payment_method', 'payment_status', 'accounting', 'quantity',
    'cash', 'bank', 'wallet', 'customer_id', 'supplier_id', 'order_id',
    'counterparty_type', 'counterparty_id', 'collector_id', 'collector_name',
    'transaction_date'
  ]) OR lower(COALESCE(p_key, '')) ~
    '(price|amount|total|subtotal|debt|refund|discount|fee|value|paid|product|variant|sku|unit|package)';
$$;

CREATE OR REPLACE FUNCTION public.p52_is_product_identity_field(p_key text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT lower(COALESCE(p_key, '')) = ANY (ARRAY[
    'id', 'code', 'name', 'brand', 'brand_id', 'base_code', 'product_code',
    'variant_code', 'specification', 'packaging_name', 'weight_or_volume',
    'color_code', 'is_active'
  ]);
$$;

CREATE OR REPLACE FUNCTION public.p52_compact_items(p_items jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE
    WHEN p_items IS NULL OR jsonb_typeof(p_items) <> 'array' THEN p_items
    ELSE COALESCE((
      SELECT jsonb_agg(jsonb_strip_nulls(jsonb_build_object(
        'productId', COALESCE(item->'productId', item->'product_id'),
        'variantId', COALESCE(item->'variantId', item->'variant_id'),
        'code', COALESCE(item->'productCode', item->'product_code', item->'variantCode', item->'variant_code', item->'code'),
        'name', COALESCE(item->'productName', item->'product_name', item->'name'),
        'quantity', COALESCE(item->'quantity', item->'qty'),
        'price', COALESCE(item->'finalUnitPrice', item->'final_unit_price', item->'unitPrice', item->'unit_price', item->'salePrice', item->'sale_price', item->'price'),
        'discount', COALESCE(item->'discountPercent', item->'discount_percent', item->'discountAmount', item->'discount_amount'),
        'total', COALESCE(item->'lineTotal', item->'line_total', item->'total')
      )) ORDER BY item_index)
      FROM jsonb_array_elements(p_items) WITH ORDINALITY AS source(item, item_index)
    ), '[]'::jsonb)
  END;
$$;

CREATE OR REPLACE FUNCTION public.p52_compact_changes(p_changes jsonb, p_context text DEFAULT '')
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN p_changes IS NULL OR jsonb_typeof(p_changes) <> 'object' THEN '{}'::jsonb ELSE COALESCE((
    SELECT jsonb_object_agg(entry.key, CASE
      WHEN lower(entry.key) = 'items' THEN jsonb_build_object(
        'old', public.p52_compact_items(entry.value->'old'),
        'new', public.p52_compact_items(entry.value->'new')
      )
      ELSE entry.value
    END)
    FROM jsonb_each(p_changes) entry
    WHERE public.p52_is_important_change_field(entry.key)
       OR (lower(COALESCE(p_context, '')) IN ('products', 'product', 'price_list_items', 'pricelists')
           AND public.p52_is_product_identity_field(entry.key))
  ), '{}'::jsonb) END;
$$;

CREATE OR REPLACE FUNCTION public.p52_compact_audit_payload(p_payload jsonb)
RETURNS jsonb
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE WHEN p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN NULL ELSE COALESCE((
    SELECT jsonb_object_agg(entry.key, CASE
      WHEN lower(entry.key) = 'items' THEN public.p52_compact_items(entry.value)
      ELSE entry.value
    END)
    FROM jsonb_each(p_payload) entry
    WHERE public.p52_is_important_change_field(entry.key)
       OR lower(entry.key) = ANY (ARRAY[
         'id', 'code', 'name', 'customer_name', 'record_id', 'reference_id',
         'replacement_order_id', 'cashbook_transaction_id', 'sales_return_id',
         'purchase_id', 'price_list_id', 'pricelist_id'
       ])
  ), '{}'::jsonb) END;
$$;

CREATE OR REPLACE FUNCTION public.p52_is_essential_action(p_action text)
RETURNS boolean
LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT lower(COALESCE(p_action, '')) ~
    '(create|insert|delete|cancel|confirm|final|record|amend|payment|receipt|return|cashbook|deactivate|adjust|repair|reconcile|notes)';
$$;

CREATE OR REPLACE FUNCTION public.p52_filter_audit_row()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE compact_old jsonb; compact_new jsonb; meaningful_changes jsonb;
BEGIN
  compact_old := public.p52_compact_audit_payload(NEW.old_data);
  compact_new := public.p52_compact_audit_payload(NEW.new_data);
  meaningful_changes := public.p52_compact_changes(
    public.p36_activity_changes(COALESCE(compact_old, '{}'::jsonb), COALESCE(compact_new, '{}'::jsonb)),
    NEW.table_name
  );
  IF meaningful_changes = '{}'::jsonb AND NOT public.p52_is_essential_action(NEW.action) THEN RETURN NULL; END IF;
  NEW.old_data := NULLIF(compact_old, '{}'::jsonb);
  NEW.new_data := NULLIF(compact_new, '{}'::jsonb);
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Audit compaction skipped one log row: %', SQLERRM;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.p52_filter_activity_row()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE compact_changes jsonb; compact_old jsonb; compact_new jsonb;
BEGIN
  compact_changes := public.p52_compact_changes(NEW.changes, COALESCE(NEW.module, NEW.target_type));
  IF compact_changes = '{}'::jsonb AND NOT public.p52_is_essential_action(NEW.action) THEN RETURN NULL; END IF;
  SELECT COALESCE(jsonb_object_agg(entry.key, entry.value->'old'), '{}'::jsonb),
         COALESCE(jsonb_object_agg(entry.key, entry.value->'new'), '{}'::jsonb)
  INTO compact_old, compact_new FROM jsonb_each(compact_changes) entry;
  NEW.changes := compact_changes;
  NEW.old_value := NULLIF(compact_old, '{}'::jsonb);
  NEW.new_value := NULLIF(compact_new, '{}'::jsonb);
  NEW.metadata := jsonb_strip_nulls(jsonb_build_object(
    'table', NEW.metadata->>'table', 'operation', NEW.metadata->>'operation', 'draft', NEW.metadata->'draft'
  ));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Activity compaction skipped one log row: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS p52_filter_audit_row ON public.audit_logs;
CREATE TRIGGER p52_filter_audit_row BEFORE INSERT ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.p52_filter_audit_row();

DROP TRIGGER IF EXISTS p52_filter_activity_row ON public.activity_logs;
CREATE TRIGGER p52_filter_activity_row BEFORE INSERT OR UPDATE ON public.activity_logs
FOR EACH ROW EXECUTE FUNCTION public.p52_filter_activity_row();

-- Price changes were not included in the original activity trigger set.
CREATE OR REPLACE FUNCTION public.p52_log_price_change()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  old_row jsonb := CASE WHEN TG_OP = 'INSERT' THEN '{}'::jsonb ELSE to_jsonb(OLD) END;
  new_row jsonb := CASE WHEN TG_OP = 'DELETE' THEN '{}'::jsonb ELSE to_jsonb(NEW) END;
  source jsonb := CASE WHEN TG_OP = 'DELETE' THEN old_row ELSE new_row END;
  diff jsonb;
  activity_action text;
BEGIN
  IF auth.uid() IS NULL THEN RETURN COALESCE(NEW, OLD); END IF;
  SELECT * INTO actor FROM public.profiles WHERE auth_user_id = auth.uid() AND is_active = true LIMIT 1;
  IF NOT FOUND THEN RETURN COALESCE(NEW, OLD); END IF;
  diff := public.p52_compact_changes(public.p36_activity_changes(old_row, new_row), 'price_list_items');
  IF TG_OP = 'UPDATE' AND diff = '{}'::jsonb THEN RETURN NEW; END IF;
  activity_action := CASE WHEN TG_OP = 'INSERT' THEN 'create_price'
    WHEN TG_OP = 'DELETE' THEN 'delete_price' ELSE 'update_price' END;
  INSERT INTO public.activity_logs(
    operation_key, actor_id, actor_profile_id, actor_username, actor_name, actor_role,
    action, module, target_type, target_id, target_name, description, changes, metadata, created_at
  ) VALUES (
    txid_current()::text, actor.auth_user_id, actor.id, actor.username, actor.display_name, actor.role,
    activity_action, 'pricelists', 'price_list_item', source->>'id',
    COALESCE(source->>'product_id', source->>'id'), activity_action || ':' || (source->>'id'),
    diff, jsonb_build_object('table', 'price_list_items', 'operation', TG_OP), now()
  )
  ON CONFLICT (operation_key, module, target_type, target_id) DO UPDATE SET
    action = EXCLUDED.action, changes = public.activity_logs.changes || EXCLUDED.changes;
  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Price activity logging failed without blocking the price change: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS p52_price_activity_row ON public.price_list_items;
CREATE TRIGGER p52_price_activity_row AFTER INSERT OR UPDATE OR DELETE ON public.price_list_items
FOR EACH ROW EXECUTE FUNCTION public.p52_log_price_change();

CREATE INDEX IF NOT EXISTS audit_logs_created_at_idx ON public.audit_logs(created_at DESC);

CREATE OR REPLACE FUNCTION public.p52_prune_short_audit_logs()
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE deleted_audit integer := 0; deleted_activity integer := 0;
BEGIN
  DELETE FROM public.audit_logs WHERE created_at < now() - interval '4 days';
  GET DIAGNOSTICS deleted_audit = ROW_COUNT;
  DELETE FROM public.activity_logs WHERE created_at < now() - interval '4 days';
  GET DIAGNOSTICS deleted_activity = ROW_COUNT;
  RETURN jsonb_build_object('audit_logs', deleted_audit, 'activity_logs', deleted_activity);
END;
$$;

CREATE OR REPLACE FUNCTION public.p52_prune_logs_after_insert()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM public.p52_prune_short_audit_logs();
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Audit retention cleanup deferred without blocking business data: %', SQLERRM;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS p52_prune_audit_logs ON public.audit_logs;
CREATE TRIGGER p52_prune_audit_logs AFTER INSERT ON public.audit_logs
FOR EACH STATEMENT EXECUTE FUNCTION public.p52_prune_logs_after_insert();
DROP TRIGGER IF EXISTS p52_prune_activity_logs ON public.activity_logs;
CREATE TRIGGER p52_prune_activity_logs AFTER INSERT ON public.activity_logs
FOR EACH STATEMENT EXECUTE FUNCTION public.p52_prune_logs_after_insert();

SELECT public.p52_prune_short_audit_logs();

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
      log.created_at >= now() - interval '4 days'
      AND (NULLIF(p_filters->>'search','') IS NULL OR concat_ws(' ',log.target_id,log.target_name,log.actor_name,log.actor_username,log.order_id,log.customer_id) ILIKE ('%' || (p_filters->>'search') || '%'))
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
  IF actor.role='sale' AND NOT (
    EXISTS (SELECT 1 FROM public.orders sale WHERE sale.id=p_order_id AND (
      sale.created_by=actor.auth_user_id::text OR sale.salesperson_id IN (actor.auth_user_id::text,actor.username)
      OR (sale.customer_id IS NOT NULL AND public.can_access_customer(sale.customer_id))))
    OR EXISTS (SELECT 1 FROM public.draft_orders draft WHERE draft.id=p_order_id AND draft.created_by IN (actor.auth_user_id::text,actor.username))
  ) THEN RAISE EXCEPTION '403: order activity access denied' USING ERRCODE='42501'; END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(log) ORDER BY log.created_at DESC,log.id DESC),'[]'::jsonb) INTO result
  FROM (SELECT * FROM public.activity_logs
        WHERE order_id=p_order_id AND created_at >= now() - interval '4 days'
        ORDER BY created_at DESC,id DESC LIMIT LEAST(GREATEST(COALESCE(p_limit,50),1),100)) log;
  RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION
  public.p52_is_important_change_field(text), public.p52_is_product_identity_field(text),
  public.p52_compact_items(jsonb), public.p52_compact_changes(jsonb,text),
  public.p52_compact_audit_payload(jsonb), public.p52_is_essential_action(text),
  public.p52_filter_audit_row(), public.p52_filter_activity_row(),
  public.p52_log_price_change(), public.p52_prune_short_audit_logs(),
  public.p52_prune_logs_after_insert()
FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_get_activity_logs(jsonb), public.rpc_get_order_activity(text,integer) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_activity_logs(jsonb), public.rpc_get_order_activity(text,integer) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0052', 'Retain four days of compact business-significant audit and activity logs')
ON CONFLICT (version) DO NOTHING;

COMMIT;
