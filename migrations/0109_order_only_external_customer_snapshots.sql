BEGIN;

DO $prerequisite$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_migrations WHERE version = '0108'
  ) THEN
    RAISE EXCEPTION 'Migration 0109 requires migration 0108';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname = 'saas_rpc_executor'
      AND NOT rolcanlogin
      AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'Migration 0109 requires saas_rpc_executor as NOLOGIN NOBYPASSRLS';
  END IF;
END;
$prerequisite$;

ALTER TABLE public.orders
  ADD COLUMN IF NOT EXISTS customer_phone text,
  ADD COLUMN IF NOT EXISTS customer_address text;
ALTER TABLE public.draft_orders
  ADD COLUMN IF NOT EXISTS customer_phone text,
  ADD COLUMN IF NOT EXISTS customer_address text;

-- Keep the authoritative confirmation transaction and append order-only
-- contact snapshots after it has created or recovered the order.
ALTER FUNCTION public.rpc_confirm_order(jsonb)
  RENAME TO rpc_confirm_order_without_external_customer_snapshot;
REVOKE ALL ON FUNCTION public.rpc_confirm_order_without_external_customer_snapshot(jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order_without_external_customer_snapshot(jsonb)
  TO saas_rpc_executor;

CREATE FUNCTION public.persist_order_customer_contact_snapshot(
  p_order_id text,
  p_order jsonb,
  p_already_finalized boolean DEFAULT false
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  saved_customer_id text;
  saved_phone text;
  saved_address text;
  incoming_phone text;
  incoming_address text;
BEGIN
  IF NULLIF(btrim(p_order_id), '') IS NULL OR jsonb_typeof(p_order) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Order contact snapshot requires an order id and object payload';
  END IF;

  incoming_phone := NULLIF(btrim(p_order->>'customerPhone'), '');
  incoming_address := NULLIF(btrim(p_order->>'customerAddress'), '');
  IF upper(COALESCE(incoming_phone, '')) IN ('N/A', 'NA') THEN incoming_phone := NULL; END IF;
  IF upper(COALESCE(incoming_address, '')) IN ('N/A', 'NA') THEN incoming_address := NULL; END IF;
  IF length(incoming_phone) > 40 OR length(incoming_address) > 500 THEN
    RAISE EXCEPTION 'Customer phone or address exceeds the allowed length';
  END IF;

  SELECT sale.customer_id, sale.customer_phone, sale.customer_address
    INTO saved_customer_id, saved_phone, saved_address
  FROM public.orders sale
  WHERE sale.id = p_order_id
    AND sale.organization_id = public.current_organization_id()
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Confirmed order was not found in the active workspace';
  END IF;

  -- An existing customer remains the source of truth for its contact details.
  -- Guest contacts are snapshots attached only to this order and never create
  -- or update a customer profile.
  IF saved_customer_id IS NULL THEN
    IF p_already_finalized THEN
      IF (incoming_phone IS NOT NULL AND incoming_phone IS DISTINCT FROM saved_phone)
         OR (incoming_address IS NOT NULL AND incoming_address IS DISTINCT FROM saved_address) THEN
        RAISE EXCEPTION '409: order was already finalized with different customer contact details'
          USING ERRCODE = '23505';
      END IF;
    ELSE
      saved_phone := COALESCE(incoming_phone, saved_phone);
      saved_address := COALESCE(incoming_address, saved_address);
      UPDATE public.orders sale
      SET customer_phone = saved_phone,
          customer_address = saved_address
      WHERE sale.id = p_order_id
        AND sale.organization_id = public.current_organization_id()
        AND sale.customer_id IS NULL;
    END IF;
  ELSE
    SELECT customer.phone, customer.address
      INTO saved_phone, saved_address
    FROM public.customers customer
    WHERE customer.id = saved_customer_id
      AND customer.organization_id = public.current_organization_id();
  END IF;

  RETURN jsonb_build_object(
    'customerPhone', COALESCE(saved_phone, ''),
    'customerAddress', COALESCE(saved_address, '')
  );
END;
$function$;

CREATE FUNCTION public.rpc_confirm_order(p_order jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  result jsonb;
  order_id text;
  contact_snapshot jsonb;
BEGIN
  result := public.rpc_confirm_order_without_external_customer_snapshot(p_order);
  order_id := NULLIF(result->>'order_id', '');
  IF order_id IS NULL OR jsonb_typeof(result->'order') IS DISTINCT FROM 'object' THEN
    RETURN result;
  END IF;

  contact_snapshot := public.persist_order_customer_contact_snapshot(
    order_id,
    p_order,
    COALESCE((result->>'already_finalized')::boolean, false)
  );
  result := jsonb_set(result, '{order,customerPhone}', contact_snapshot->'customerPhone', true);
  result := jsonb_set(result, '{order,customerAddress}', contact_snapshot->'customerAddress', true);
  RETURN result;
END;
$function$;

-- Wrap amendments too so idempotent amendment retries return the saved
-- contact snapshot from their replacement order.
ALTER FUNCTION public.rpc_amend_order(text, jsonb, text)
  RENAME TO rpc_amend_order_without_external_customer_snapshot;
REVOKE ALL ON FUNCTION public.rpc_amend_order_without_external_customer_snapshot(text, jsonb, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_amend_order_without_external_customer_snapshot(text, jsonb, text)
  TO saas_rpc_executor;

CREATE FUNCTION public.rpc_amend_order(
  p_order_id text,
  p_order jsonb,
  p_reason text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  result jsonb;
  replacement_id text;
  contact_snapshot jsonb;
BEGIN
  result := public.rpc_amend_order_without_external_customer_snapshot(
    p_order_id, p_order, p_reason
  );
  replacement_id := COALESCE(
    NULLIF(result->>'replacement_order_id', ''),
    NULLIF(result->>'order_id', '')
  );
  IF replacement_id IS NULL OR jsonb_typeof(result->'order') IS DISTINCT FROM 'object' THEN
    RETURN result;
  END IF;

  contact_snapshot := public.persist_order_customer_contact_snapshot(
    replacement_id,
    p_order,
    COALESCE((result->>'already_amended')::boolean, false)
  );
  result := jsonb_set(result, '{order,customerPhone}', contact_snapshot->'customerPhone', true);
  result := jsonb_set(result, '{order,customerAddress}', contact_snapshot->'customerAddress', true);
  RETURN result;
END;
$function$;

GRANT CREATE ON SCHEMA public TO saas_rpc_executor;
ALTER FUNCTION public.persist_order_customer_contact_snapshot(text, jsonb, boolean)
  OWNER TO saas_rpc_executor;
ALTER FUNCTION public.rpc_confirm_order(jsonb) OWNER TO saas_rpc_executor;
ALTER FUNCTION public.rpc_amend_order(text, jsonb, text) OWNER TO saas_rpc_executor;
REVOKE CREATE ON SCHEMA public FROM saas_rpc_executor;

REVOKE ALL ON FUNCTION public.persist_order_customer_contact_snapshot(text, jsonb, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.persist_order_customer_contact_snapshot(text, jsonb, boolean)
  TO saas_rpc_executor;
REVOKE ALL ON FUNCTION public.rpc_confirm_order(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_confirm_order(jsonb) TO authenticated;
REVOKE ALL ON FUNCTION public.rpc_amend_order(text, jsonb, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_amend_order(text, jsonb, text) TO authenticated;

DO $verification$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'customer_phone'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'orders' AND column_name = 'customer_address'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'draft_orders' AND column_name = 'customer_phone'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'draft_orders' AND column_name = 'customer_address'
  ) THEN
    RAISE EXCEPTION 'Migration 0109 stopped: contact snapshot columns were not created';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.rpc_confirm_order(jsonb)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_confirm_order(jsonb)', 'EXECUTE')
     OR has_function_privilege('authenticated',
       'public.persist_order_customer_contact_snapshot(text, jsonb, boolean)', 'EXECUTE')
     OR NOT has_function_privilege('saas_rpc_executor',
       'public.persist_order_customer_contact_snapshot(text, jsonb, boolean)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0109 stopped: order contact RPC privileges are invalid';
  END IF;

  IF NOT has_function_privilege('authenticated', 'public.rpc_amend_order(text, jsonb, text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rpc_amend_order(text, jsonb, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Migration 0109 stopped: order amendment RPC grants are invalid';
  END IF;
END;
$verification$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0109', 'Save external customer contact snapshots on orders without creating customer profiles')
ON CONFLICT (version) DO NOTHING;

COMMIT;
