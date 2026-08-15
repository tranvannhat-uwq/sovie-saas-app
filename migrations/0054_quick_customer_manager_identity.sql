BEGIN;

-- Customer screens and filters use the stable profile username as managed_by.
-- The original quick-create RPC stored auth_user_id instead, which passed the
-- database access check but made the customer disappear from Sale UI filters.
CREATE OR REPLACE FUNCTION public.rpc_create_quick_customer(p_customer jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
#variable_conflict use_variable
DECLARE
  actor public.profiles%ROWTYPE;
  manager_profile public.profiles%ROWTYPE;
  customer_row public.customers%ROWTYPE;
  customer_id text := NULLIF(btrim(p_customer->>'id'), '');
  customer_code text := NULLIF(btrim(p_customer->>'code'), '');
  customer_name text := NULLIF(btrim(p_customer->>'name'), '');
  customer_phone text := NULLIF(btrim(p_customer->>'phone'), '');
  clean_phone text;
  manager_key text := NULLIF(btrim(p_customer->>'managedBy'), '');
  price_list_id text := NULLIF(btrim(p_customer->>'pricelistId'), '');
  province_code text := NULLIF(btrim(p_customer->>'province'), '');
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting', 'sale') THEN
    RAISE EXCEPTION '403: role cannot create quick customers' USING ERRCODE = '42501';
  END IF;

  IF customer_id IS NULL OR customer_code IS NULL OR customer_name IS NULL THEN
    RAISE EXCEPTION 'Customer id, code and name are required';
  END IF;
  IF char_length(customer_name) > 240 OR char_length(customer_code) > 120 THEN
    RAISE EXCEPTION 'Customer name or code is too long';
  END IF;

  IF actor.role = 'sale' THEN
    manager_profile := actor;
  ELSE
    IF manager_key IS NULL THEN
      RAISE EXCEPTION 'Customer manager is required';
    END IF;
    SELECT profile.* INTO manager_profile
    FROM public.profiles profile
    WHERE profile.is_active = true
      AND (
        profile.id = manager_key
        OR profile.auth_user_id::text = manager_key
        OR lower(profile.username) = lower(manager_key)
        OR split_part(lower(profile.username), '@', 1) = split_part(lower(manager_key), '@', 1)
      )
    ORDER BY CASE WHEN profile.auth_user_id::text = manager_key THEN 0 ELSE 1 END,
             profile.id
    LIMIT 1;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Customer manager was not found';
    END IF;
  END IF;

  IF price_list_id IS NOT NULL AND NOT public.can_use_price_list(price_list_id) THEN
    RAISE EXCEPTION '403: price list is not available to this user' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (SELECT 1 FROM public.customers customer WHERE customer.id = customer_id) THEN
    RAISE EXCEPTION 'Customer id already exists' USING ERRCODE = '23505';
  END IF;
  IF EXISTS (SELECT 1 FROM public.customers customer WHERE lower(customer.code) = lower(customer_code)) THEN
    RAISE EXCEPTION 'Customer code already exists' USING ERRCODE = '23505';
  END IF;

  clean_phone := regexp_replace(COALESCE(customer_phone, ''), '[^0-9]', '', 'g');
  IF clean_phone <> '' AND EXISTS (
    SELECT 1 FROM public.customers customer
    WHERE regexp_replace(COALESCE(customer.phone, ''), '[^0-9]', '', 'g') = clean_phone
      AND customer.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Phone number already belongs to another customer' USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.customers (
    id, code, name, phone, address, province, assigned_brand, brand_discounts,
    pricelist_id, default_price_list_id, managed_by, notes, status,
    debt, total_transaction, total_return, net_revenue, debt_history,
    created_by, updated_by, created_at, updated_at, deleted_at
  ) VALUES (
    customer_id, customer_code, customer_name, customer_phone,
    COALESCE(p_customer->>'address', ''), province_code,
    COALESCE(NULLIF(btrim(p_customer->>'assignedBrand'), ''), 'Tất cả'),
    CASE WHEN province_code IS NULL THEN '{}'::jsonb
         ELSE jsonb_build_object('province', province_code) END,
    price_list_id, price_list_id, manager_profile.username,
    COALESCE(NULLIF(btrim(p_customer->>'notes'), ''), 'Thêm nhanh từ màn hình lên đơn'),
    'active', 0, 0, 0, 0, '[]'::jsonb,
    actor.auth_user_id::text, actor.auth_user_id::text, now(), now(), NULL
  )
  RETURNING * INTO customer_row;

  INSERT INTO public.audit_logs (
    table_name, action, record_id, old_data, new_data, performed_by, created_at
  ) VALUES (
    'customers', 'QUICK_CREATE', customer_row.id, NULL,
    jsonb_build_object(
      'code', customer_row.code,
      'name', customer_row.name,
      'managed_by', customer_row.managed_by,
      'source', 'invoice_quick_create'
    ),
    actor.auth_user_id::text, now()
  );

  RETURN jsonb_build_object(
    'success', true,
    'customer', jsonb_build_object(
      'id', customer_row.id,
      'code', customer_row.code,
      'name', customer_row.name,
      'phone', customer_row.phone,
      'address', customer_row.address,
      'assignedBrand', customer_row.assigned_brand,
      'brandDiscounts', customer_row.brand_discounts,
      'pricelistId', customer_row.pricelist_id,
      'managedBy', customer_row.managed_by,
      'debt', customer_row.debt,
      'totalTransaction', customer_row.total_transaction,
      'status', customer_row.status
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_create_quick_customer(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_create_quick_customer(jsonb) TO authenticated;

-- Repair only rows proven to have come from the invoice quick-create RPC and
-- whose current manager is still that same profile's Auth UUID. This avoids
-- overwriting later manual reassignments or customers from another workflow.
UPDATE public.customers customer
SET managed_by = profile.username,
    updated_at = now()
FROM public.profiles profile
WHERE customer.managed_by = profile.auth_user_id::text
  AND EXISTS (
    SELECT 1
    FROM public.audit_logs audit
    WHERE audit.table_name = 'customers'
      AND audit.record_id = customer.id
      AND audit.action = 'QUICK_CREATE'
      AND audit.new_data->>'source' = 'invoice_quick_create'
      AND audit.new_data->>'managed_by' = profile.auth_user_id::text
  );

DO $migration$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_proc procedure
    JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
    WHERE namespace.nspname = 'public'
      AND procedure.proname = 'rpc_create_quick_customer'
      AND procedure.prosrc LIKE '%manager_profile.username%'
      AND procedure.prosecdef
  ) THEN
    RAISE EXCEPTION 'Migration 0054 stopped: quick customer manager identity verification failed';
  END IF;
END
$migration$;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0054', 'Normalize quick-created customer managers to profile usernames')
ON CONFLICT (version) DO NOTHING;

COMMIT;
