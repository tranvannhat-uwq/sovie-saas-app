BEGIN;

CREATE TABLE IF NOT EXISTS public.profiles (
  id text PRIMARY KEY,
  auth_user_id uuid UNIQUE,
  username text NOT NULL UNIQUE,
  display_name text NOT NULL,
  role text NOT NULL DEFAULT 'sale',
  company_id text DEFAULT 'ABS_NORTH',
  is_external boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT profiles_role_check CHECK (role IN ('admin', 'accounting', 'sale'))
);

-- Preserve legacy personnel rows without authenticating them. Linking a legacy
-- profile to auth.users is a separate, explicitly confirmed staging operation;
-- email/username similarity must never grant a legacy role automatically.
DO $migration$
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    EXECUTE $sql$
      INSERT INTO public.profiles (
        id, auth_user_id, username, display_name, role, company_id,
        is_external, is_active, created_at, updated_at
      )
      SELECT
        legacy.id,
        NULL::uuid,
        legacy.username,
        COALESCE(NULLIF(legacy.display_name, ''), legacy.username),
        CASE WHEN legacy.role IN ('admin', 'accounting', 'sale') THEN legacy.role ELSE 'sale' END,
        COALESCE(NULLIF(to_jsonb(legacy)->>'company_id', ''), 'ABS_NORTH'),
        COALESCE((to_jsonb(legacy)->>'is_external')::boolean, false),
        COALESCE(NULLIF(to_jsonb(legacy)->>'employment_status', ''), 'active') = 'active',
        COALESCE(legacy.created_at, now()),
        now()
      FROM public.users legacy
      ON CONFLICT (id) DO UPDATE
      SET auth_user_id = COALESCE(public.profiles.auth_user_id, EXCLUDED.auth_user_id),
          username = EXCLUDED.username,
          display_name = EXCLUDED.display_name,
          company_id = EXCLUDED.company_id,
          is_external = EXCLUDED.is_external,
          is_active = EXCLUDED.is_active,
          updated_at = now()
    $sql$;
  END IF;
END
$migration$;

-- Existing Auth identities are intentionally not auto-linked or auto-created
-- here. They must be matched to an existing legacy profile by the reviewed
-- staging bootstrap. Auth users created after this migration are provisioned
-- by handle_new_auth_profile() below with the non-privileged Sale role.

CREATE OR REPLACE FUNCTION public.current_profile_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT profile.role
  FROM public.profiles profile
  WHERE profile.auth_user_id = auth.uid()
    AND profile.is_active = true
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.current_profile_username()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT profile.username
  FROM public.profiles profile
  WHERE profile.auth_user_id = auth.uid()
    AND profile.is_active = true
  LIMIT 1
$$;

CREATE OR REPLACE FUNCTION public.require_authenticated_profile()
RETURNS public.profiles
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '401: authentication required' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO actor
  FROM public.profiles
  WHERE auth_user_id = auth.uid() AND is_active = true;
  IF NOT FOUND THEN
    RAISE EXCEPTION '403: active profile required' USING ERRCODE = '42501';
  END IF;
  RETURN actor;
END;
$$;

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT COALESCE(public.current_profile_role() = 'admin', false) $$;

CREATE OR REPLACE FUNCTION public.is_admin_or_accounting()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT COALESCE(public.current_profile_role() IN ('admin', 'accounting'), false) $$;

CREATE OR REPLACE FUNCTION public.get_current_username()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT public.current_profile_username() $$;

CREATE OR REPLACE FUNCTION public.can_access_customer(p_customer_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.is_admin_or_accounting()
    OR EXISTS (
      SELECT 1 FROM public.customers customer
      WHERE customer.id = p_customer_id
        AND (
          customer.managed_by = auth.uid()::text
          OR lower(customer.managed_by) = lower(public.current_profile_username())
          OR split_part(lower(customer.managed_by), '@', 1) =
             split_part(lower(public.current_profile_username()), '@', 1)
        )
    )
    OR EXISTS (
      SELECT 1 FROM public.customer_assignments assignment
      WHERE assignment.customer_id = p_customer_id
        AND assignment.is_active = true
        AND (assignment.assigned_to IS NULL OR assignment.assigned_to >= now())
        AND (
          assignment.employee_id = auth.uid()::text
          OR lower(assignment.employee_id) = lower(public.current_profile_username())
          OR split_part(lower(assignment.employee_id), '@', 1) =
             split_part(lower(public.current_profile_username()), '@', 1)
        )
    )
$$;

CREATE OR REPLACE FUNCTION public.can_use_price_list(p_price_list_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT p_price_list_id IS NULL
    OR p_price_list_id = ''
    OR p_price_list_id = 'retail'
    OR EXISTS (
      SELECT 1
      FROM public.pricelists price_list
      WHERE price_list.id = p_price_list_id
        AND price_list.is_active = true
        AND (
          public.is_admin_or_accounting()
          OR (
            public.current_profile_role() = 'sale'
            AND price_list.is_available_for_sales = true
            AND price_list.customer_id IS NULL
            AND COALESCE(price_list.price_list_type, price_list.type, 'general')
                NOT IN ('dealer_private', 'customer_specific', 'customer')
          )
        )
    )
$$;

CREATE OR REPLACE FUNCTION public.can_use_order_price_lists(
  p_price_list_id text, p_items jsonb
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT public.can_use_price_list(NULLIF(p_price_list_id, ''))
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(
        CASE WHEN jsonb_typeof(p_items) = 'array' THEN p_items ELSE '[]'::jsonb END
      ) item
      WHERE NOT public.can_use_price_list(COALESCE(
        NULLIF(item->>'priceListId', ''), NULLIF(item->>'price_list_id', '')
      ))
    )
$$;

-- New Auth accounts are always provisioned as sale. Role assignment is an
-- explicit admin-only database operation, never trusted from user metadata.
CREATE OR REPLACE FUNCTION public.handle_new_auth_profile()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.profiles (
    id, auth_user_id, username, display_name, role, is_external, is_active
  ) VALUES (
    NEW.id::text,
    NEW.id,
    CASE
      WHEN NEW.email IS NOT NULL AND NEW.email <> ''
       AND NOT EXISTS (
         SELECT 1 FROM public.profiles existing_profile
         WHERE lower(existing_profile.username) = lower(NEW.email)
           AND existing_profile.id <> NEW.id::text
       )
      THEN NEW.email
      ELSE NEW.id::text
    END,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'display_name', ''),
             NULLIF(NEW.raw_user_meta_data->>'displayName', ''),
             split_part(NEW.email, '@', 1), NEW.id::text),
    'sale', false, true
  )
  ON CONFLICT (id) DO UPDATE
  SET auth_user_id = NEW.id,
      username = EXCLUDED.username,
      display_name = EXCLUDED.display_name,
      role = 'sale',
      is_active = true,
      updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created_p0 ON auth.users;
CREATE TRIGGER on_auth_user_created_p0
AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_auth_profile();

-- Remove legacy triggers that trusted signup metadata, auto-confirmed email,
-- deleted profiles, or synchronized plaintext password fields.
DROP TRIGGER IF EXISTS on_auth_user_created_before ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
DROP TRIGGER IF EXISTS on_auth_user_deleted ON auth.users;

-- Remove every pre-P0 policy on the business tables before installing the
-- canonical policy set. Rows are never modified by this operation.
DO $migration$
DECLARE
  target text;
  policy record;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'schema_migrations', 'profiles', 'users', 'companies', 'brands',
    'customers', 'product_groups', 'products', 'pricelists',
    'price_list_items', 'orders', 'order_items', 'draft_orders', 'payments',
    'customer_debt_transactions', 'cashbook_transactions', 'sales_returns',
    'sales_return_items', 'raw_materials', 'semi_finished', 'recipes',
    'production_logs', 'finished_goods_stock', 'audit_logs',
    'customer_assignments', 'commission_rules', 'commission_transactions',
    'starting_balances', 'suppliers'
  ] LOOP
    IF to_regclass('public.' || target) IS NULL THEN CONTINUE; END IF;
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', target);
    FOR policy IN
      SELECT policyname FROM pg_policies
      WHERE schemaname = 'public' AND tablename = target
    LOOP
      EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', policy.policyname, target);
    END LOOP;
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated', target);
  END LOOP;
END
$migration$;

REVOKE ALL ON TABLE public.profiles FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.profiles TO authenticated;
CREATE POLICY profiles_select ON public.profiles FOR SELECT TO authenticated
  USING (auth_user_id = auth.uid() OR public.is_admin_or_accounting());
CREATE POLICY profiles_admin_insert ON public.profiles FOR INSERT TO authenticated
  WITH CHECK (public.is_admin());
CREATE POLICY profiles_admin_update ON public.profiles FOR UPDATE TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY profiles_admin_delete ON public.profiles FOR DELETE TO authenticated
  USING (public.is_admin());

GRANT SELECT ON TABLE public.companies, public.brands TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.companies, public.brands TO authenticated;
CREATE POLICY companies_select ON public.companies FOR SELECT TO authenticated
  USING (public.current_profile_role() IS NOT NULL);
CREATE POLICY companies_admin_manage ON public.companies FOR ALL TO authenticated
  USING (public.is_admin()) WITH CHECK (public.is_admin());
CREATE POLICY brands_select ON public.brands FOR SELECT TO authenticated
  USING (public.current_profile_role() IS NOT NULL);
CREATE POLICY brands_finance_manage ON public.brands FOR ALL TO authenticated
  USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.customers TO authenticated;
CREATE POLICY customers_select ON public.customers FOR SELECT TO authenticated
  USING (public.is_admin_or_accounting() OR public.can_access_customer(id));
CREATE POLICY customers_finance_insert ON public.customers FOR INSERT TO authenticated
  WITH CHECK (public.is_admin_or_accounting());
CREATE POLICY customers_finance_update ON public.customers FOR UPDATE TO authenticated
  USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());
CREATE POLICY customers_finance_delete ON public.customers FOR DELETE TO authenticated
  USING (public.is_admin_or_accounting());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.products, public.product_groups TO authenticated;
CREATE POLICY products_select ON public.products FOR SELECT TO authenticated
  USING (public.current_profile_role() IS NOT NULL);
CREATE POLICY products_finance_manage ON public.products FOR ALL TO authenticated
  USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());
CREATE POLICY product_groups_select ON public.product_groups FOR SELECT TO authenticated
  USING (public.current_profile_role() IS NOT NULL);
CREATE POLICY product_groups_finance_manage ON public.product_groups FOR ALL TO authenticated
  USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.pricelists, public.price_list_items TO authenticated;
CREATE POLICY pricelists_select ON public.pricelists FOR SELECT TO authenticated
  USING (public.is_admin_or_accounting() OR public.can_use_price_list(id));
CREATE POLICY pricelists_finance_manage ON public.pricelists FOR ALL TO authenticated
  USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());
CREATE POLICY price_items_select ON public.price_list_items FOR SELECT TO authenticated
  USING (public.can_use_price_list(price_list_id));
CREATE POLICY price_items_finance_manage ON public.price_list_items FOR ALL TO authenticated
  USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.orders, public.order_items, public.draft_orders TO authenticated;
CREATE POLICY orders_select ON public.orders FOR SELECT TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR (
      public.can_use_order_price_lists(pricelist_id, items)
      AND (
        created_by = auth.uid()::text
        OR salesperson_id = auth.uid()::text
        OR lower(salesperson_id) = lower(public.current_profile_username())
      )
    )
  );
CREATE POLICY orders_finance_manage ON public.orders FOR ALL TO authenticated
  USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());
CREATE POLICY order_items_select ON public.order_items FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.orders parent WHERE parent.id = order_id));
CREATE POLICY order_items_finance_manage ON public.order_items FOR ALL TO authenticated
  USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());
CREATE POLICY drafts_select ON public.draft_orders FOR SELECT TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR (
      public.can_use_order_price_lists(pricelist_id, items)
      AND (
        created_by = auth.uid()::text
        OR lower(created_by) = lower(public.current_profile_username())
      )
    )
  );
CREATE POLICY drafts_insert ON public.draft_orders FOR INSERT TO authenticated
  WITH CHECK (
    public.is_admin_or_accounting()
    OR (
      (created_by = auth.uid()::text OR lower(created_by) = lower(public.current_profile_username()))
      AND (customer_id IS NULL OR public.can_access_customer(customer_id))
      AND public.can_use_order_price_lists(pricelist_id, items)
    )
  );
CREATE POLICY drafts_update ON public.draft_orders FOR UPDATE TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR created_by = auth.uid()::text
    OR lower(created_by) = lower(public.current_profile_username())
  )
  WITH CHECK (
    public.is_admin_or_accounting()
    OR (
      (created_by = auth.uid()::text OR lower(created_by) = lower(public.current_profile_username()))
      AND (customer_id IS NULL OR public.can_access_customer(customer_id))
      AND public.can_use_order_price_lists(pricelist_id, items)
    )
  );
CREATE POLICY drafts_delete ON public.draft_orders FOR DELETE TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR created_by = auth.uid()::text
    OR lower(created_by) = lower(public.current_profile_username())
  );

DO $migration$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['payments', 'customer_debt_transactions', 'cashbook_transactions'] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', target);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.is_admin_or_accounting())',
      target || '_finance_select', target
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting())',
      target || '_finance_manage', target
    );
  END LOOP;
END
$migration$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sales_returns, public.sales_return_items TO authenticated;
CREATE POLICY returns_finance_select ON public.sales_returns FOR SELECT TO authenticated
  USING (public.is_admin_or_accounting());
CREATE POLICY returns_finance_manage ON public.sales_returns FOR ALL TO authenticated
  USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());
CREATE POLICY return_items_finance_select ON public.sales_return_items FOR SELECT TO authenticated
  USING (public.is_admin_or_accounting());
CREATE POLICY return_items_finance_manage ON public.sales_return_items FOR ALL TO authenticated
  USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting());

DO $migration$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'raw_materials', 'semi_finished', 'recipes', 'production_logs', 'finished_goods_stock'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', target);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR SELECT TO authenticated USING (public.current_profile_role() IS NOT NULL)',
      target || '_select', target
    );
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting())',
      target || '_finance_manage', target
    );
  END LOOP;
END
$migration$;

GRANT SELECT ON TABLE public.audit_logs TO authenticated;
CREATE POLICY audit_admin_select ON public.audit_logs FOR SELECT TO authenticated
  USING (public.is_admin());

DO $migration$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'customer_assignments', 'commission_rules', 'commission_transactions',
    'starting_balances', 'suppliers'
  ] LOOP
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I TO authenticated', target);
    EXECUTE format(
      'CREATE POLICY %I ON public.%I FOR ALL TO authenticated USING (public.is_admin_or_accounting()) WITH CHECK (public.is_admin_or_accounting())',
      target || '_finance_manage', target
    );
  END LOOP;
END
$migration$;

CREATE POLICY assignments_sale_select ON public.customer_assignments FOR SELECT TO authenticated
  USING (
    public.current_profile_role() = 'sale'
    AND is_active = true
    AND (assigned_to IS NULL OR assigned_to >= now())
    AND (
      employee_id = auth.uid()::text
      OR lower(employee_id) = lower(public.current_profile_username())
    )
  );
CREATE POLICY commissions_sale_select ON public.commission_transactions FOR SELECT TO authenticated
  USING (
    public.current_profile_role() = 'sale'
    AND (
      employee_id = auth.uid()::text
      OR lower(employee_id) = lower(public.current_profile_username())
    )
  );

GRANT SELECT ON TABLE public.schema_migrations TO authenticated;
CREATE POLICY migration_admin_select ON public.schema_migrations FOR SELECT TO authenticated
  USING (public.is_admin());

-- Legacy public.users contains plaintext password data on some installations.
-- It remains untouched for recovery, but neither anon nor authenticated can
-- access it. The application now reads public.profiles instead.
DO $migration$
BEGIN
  IF to_regclass('public.users') IS NOT NULL THEN
    REVOKE ALL ON TABLE public.users FROM anon, authenticated;
  END IF;
END
$migration$;

-- Close inherited function execution as soon as RLS is installed. Existing
-- explicit authenticated RPC grants are left in place only until 0004 replaces
-- the public API surface, so the currently deployed frontend can stay online
-- during the short staging migration sequence.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.current_profile_role() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_profile_username() TO authenticated;
GRANT EXECUTE ON FUNCTION public.require_authenticated_profile() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_admin_or_accounting() TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_current_username() TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_access_customer(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_price_list(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_use_order_price_lists(text, jsonb) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0002', 'Supabase Auth profiles and least-privilege RLS')
ON CONFLICT (version) DO NOTHING;

COMMIT;
