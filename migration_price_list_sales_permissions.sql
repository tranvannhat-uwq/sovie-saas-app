-- Price list visibility and usage permissions by user role.
-- Apply after the base schema and SKU price matrix migrations.

ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS price_list_type text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS is_available_for_sales boolean NOT NULL DEFAULT false;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;

-- Remove legacy constraints before converting their values. The previous schema
-- only allowed: standard, customer_group, customer_specific.
ALTER TABLE public.pricelists DROP CONSTRAINT IF EXISTS pricelists_type_check;
ALTER TABLE public.pricelists DROP CONSTRAINT IF EXISTS pricelists_price_list_type_check;
ALTER TABLE public.pricelists DROP CONSTRAINT IF EXISTS pricelists_customer_specific_check;
ALTER TABLE public.pricelists DROP CONSTRAINT IF EXISTS pricelists_private_not_sales_check;
ALTER TABLE public.pricelists DROP CONSTRAINT IF EXISTS pricelists_dealer_private_customer_check;

UPDATE public.pricelists
SET price_list_type = CASE
  WHEN COALESCE(price_list_type, type) IN ('customer_specific', 'customer', 'dealer_private') THEN 'dealer_private'
  WHEN COALESCE(price_list_type, type) IN ('sales', 'sale') THEN 'sales'
  WHEN COALESCE(price_list_type, type) IN ('customer_group', 'group') THEN 'customer_group'
  ELSE 'general'
END,
type = CASE
  WHEN COALESCE(price_list_type, type) IN ('customer_specific', 'customer', 'dealer_private') THEN 'dealer_private'
  WHEN COALESCE(price_list_type, type) IN ('sales', 'sale') THEN 'sales'
  WHEN COALESCE(price_list_type, type) IN ('customer_group', 'group') THEN 'customer_group'
  ELSE 'general'
END,
is_available_for_sales = CASE
  WHEN COALESCE(price_list_type, type) IN ('dealer_private', 'customer_specific', 'customer') THEN false
  ELSE is_available_for_sales
END;

ALTER TABLE public.pricelists
  ADD CONSTRAINT pricelists_type_check
  CHECK (type IN ('general', 'sales', 'customer_group', 'dealer_private'));

ALTER TABLE public.pricelists
  ADD CONSTRAINT pricelists_price_list_type_check
  CHECK (price_list_type IN ('general', 'sales', 'customer_group', 'dealer_private'));

ALTER TABLE public.pricelists
  ADD CONSTRAINT pricelists_private_not_sales_check
  CHECK (price_list_type <> 'dealer_private' OR is_available_for_sales = false);

ALTER TABLE public.pricelists
  ADD CONSTRAINT pricelists_dealer_private_customer_check
  CHECK (price_list_type <> 'dealer_private' OR customer_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS pricelists_sales_visibility_idx
  ON public.pricelists(is_active, is_available_for_sales, price_list_type);

CREATE OR REPLACE FUNCTION public.current_user_role()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT role FROM public.users WHERE id = auth.uid()::text LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.can_current_user_use_price_list(p_price_list_id text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.pricelists pl
    WHERE pl.id = p_price_list_id
      AND pl.is_active = true
      AND (
        public.is_admin_or_accounting()
        OR (
          public.current_user_role() = 'sale'
          AND pl.is_available_for_sales = true
          AND COALESCE(pl.price_list_type, pl.type) <> 'dealer_private'
        )
      )
  );
$$;

ALTER TABLE public.pricelists ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS select_pricelists ON public.pricelists;
DROP POLICY IF EXISTS manage_pricelists ON public.pricelists;
CREATE POLICY select_pricelists ON public.pricelists
  FOR SELECT TO authenticated
  USING (
    public.is_admin_or_accounting()
    OR (
      public.current_user_role() = 'sale'
      AND is_active = true
      AND is_available_for_sales = true
      AND COALESCE(price_list_type, type) <> 'dealer_private'
    )
  );
CREATE POLICY manage_pricelists ON public.pricelists
  FOR ALL TO authenticated
  USING (public.is_admin_or_accounting())
  WITH CHECK (
    public.is_admin_or_accounting()
    AND (COALESCE(price_list_type, type) <> 'dealer_private' OR is_available_for_sales = false)
  );

ALTER TABLE public.price_list_items ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS select_price_list_items ON public.price_list_items;
DROP POLICY IF EXISTS manage_price_list_items ON public.price_list_items;
CREATE POLICY select_price_list_items ON public.price_list_items
  FOR SELECT TO authenticated
  USING (public.can_current_user_use_price_list(price_list_id));
CREATE POLICY manage_price_list_items ON public.price_list_items
  FOR ALL TO authenticated
  USING (public.is_admin_or_accounting())
  WITH CHECK (public.is_admin_or_accounting());

CREATE OR REPLACE FUNCTION public.reject_forbidden_order_price_lists()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF public.current_user_role() = 'sale'
     AND NEW.pricelist_id IS NOT NULL
     AND NEW.pricelist_id <> 'retail'
     AND NOT public.can_current_user_use_price_list(NEW.pricelist_id) THEN
    RAISE EXCEPTION '403: price list % is not available for sales', NEW.pricelist_id
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_orders_reject_forbidden_price_list ON public.orders;
CREATE TRIGGER trg_orders_reject_forbidden_price_list
  BEFORE INSERT OR UPDATE OF pricelist_id ON public.orders
  FOR EACH ROW EXECUTE FUNCTION public.reject_forbidden_order_price_lists();

DROP TRIGGER IF EXISTS trg_draft_orders_reject_forbidden_price_list ON public.draft_orders;
CREATE TRIGGER trg_draft_orders_reject_forbidden_price_list
  BEFORE INSERT OR UPDATE OF pricelist_id ON public.draft_orders
  FOR EACH ROW EXECUTE FUNCTION public.reject_forbidden_order_price_lists();
