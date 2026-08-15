BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $migration$
BEGIN
  IF to_regclass('public.wl_products') IS NOT NULL
     OR to_regclass('public.wl_orders') IS NOT NULL
     OR to_regclass('public.wl_customers') IS NOT NULL THEN
    RAISE EXCEPTION
      'P0 migration stopped: wl_* deployment detected. Its production schema was not supplied, so applying base-table policies would be unsafe.';
  END IF;
END
$migration$;

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY,
  description text NOT NULL,
  applied_at timestamptz NOT NULL DEFAULT now(),
  applied_by uuid DEFAULT auth.uid()
);

CREATE TABLE IF NOT EXISTS public.companies (
  id text PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  address text DEFAULT '',
  status text DEFAULT 'active',
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.customers (
  id text PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  phone text,
  address text,
  assigned_brand text DEFAULT 'Tat ca',
  brand_discounts jsonb DEFAULT '{}'::jsonb,
  shipping_support boolean DEFAULT false,
  debt numeric DEFAULT 0,
  total_transaction numeric DEFAULT 0,
  notes text,
  pricelist_id text,
  managed_by text,
  debt_history jsonb DEFAULT '[]'::jsonb,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS phone2 text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS facebook text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS birthday text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS gender text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS province text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS ward text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS customer_group_id text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS company_name text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS tax_code text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS invoice_address text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS total_return numeric DEFAULT 0;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS net_revenue numeric DEFAULT 0;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS last_order_at timestamptz;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.customers ADD COLUMN IF NOT EXISTS default_price_list_id text;

CREATE TABLE IF NOT EXISTS public.brands (
  name text PRIMARY KEY,
  company_name text NOT NULL DEFAULT '',
  logo_filename text NOT NULL DEFAULT '',
  hotline text NOT NULL DEFAULT '',
  cskh text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address_main text NOT NULL DEFAULT '',
  address_factory text NOT NULL DEFAULT '',
  address_business text,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.brands ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE public.brands ADD COLUMN IF NOT EXISTS company_id text DEFAULT '';
UPDATE public.brands SET id = COALESCE(NULLIF(id, ''), name) WHERE id IS NULL OR id = '';
CREATE UNIQUE INDEX IF NOT EXISTS brands_id_uidx ON public.brands(id);

CREATE TABLE IF NOT EXISTS public.product_groups (
  id text PRIMARY KEY,
  base_code text NOT NULL,
  product_name text NOT NULL,
  brand_id text,
  brand_name text NOT NULL DEFAULT '',
  category_id text,
  description text,
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.products (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  code text NOT NULL,
  brand text NOT NULL DEFAULT 'Nano10*',
  name text NOT NULL,
  price numeric DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  UNIQUE(code, brand)
);
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS brand_id text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS product_group_id text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS base_product_id text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS parent_product_id text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS base_code text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS variant_code text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS package_type text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS packaging_name text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS package_weight numeric;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS package_weight_unit text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS unit_name text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS weight_or_volume numeric;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS display_specification text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS conversion_quantity numeric NOT NULL DEFAULT 1;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS barcode text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS purchase_price numeric NOT NULL DEFAULT 0;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS product_group text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS is_legacy boolean NOT NULL DEFAULT false;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_thung numeric DEFAULT 0;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_lon numeric DEFAULT 0;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_hop numeric DEFAULT 0;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_bao numeric DEFAULT 0;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS price_tui numeric DEFAULT 0;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS weight_thung text DEFAULT '';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS weight_lon text DEFAULT '';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS weight_hop text DEFAULT '';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS weight_bao text DEFAULT '';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS weight_tui text DEFAULT '';
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.products ADD COLUMN IF NOT EXISTS updated_by text;
UPDATE public.products SET id = gen_random_uuid()::text WHERE id IS NULL OR btrim(id) = '';
CREATE UNIQUE INDEX IF NOT EXISTS products_id_uidx ON public.products(id);

CREATE TABLE IF NOT EXISTS public.pricelists (
  id text PRIMARY KEY,
  name text NOT NULL,
  brand_discounts jsonb DEFAULT '{}'::jsonb,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS type text DEFAULT 'general';
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS price_list_type text DEFAULT 'general';
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS customer_group_id text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS parent_price_list_id text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS effective_from date;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS effective_to date;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT true;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS is_available_for_sales boolean NOT NULL DEFAULT false;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS display_order integer NOT NULL DEFAULT 0;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.pricelists ADD COLUMN IF NOT EXISTS updated_by text;

CREATE TABLE IF NOT EXISTS public.price_list_items (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  price_list_id text NOT NULL,
  product_id text NOT NULL,
  variant_id text,
  price numeric NOT NULL DEFAULT 0,
  is_override boolean NOT NULL DEFAULT true,
  source_type text NOT NULL DEFAULT 'manual',
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS price_list_items_list_product_uidx
  ON public.price_list_items(price_list_id, product_id);

CREATE TABLE IF NOT EXISTS public.orders (
  id text PRIMARY KEY,
  customer_id text,
  customer_name text NOT NULL,
  notes text,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  total_market numeric DEFAULT 0,
  total_discount numeric DEFAULT 0,
  total_payable numeric DEFAULT 0,
  pricelist_id text,
  created_by text,
  status text DEFAULT 'settled',
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS salesperson_id text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS customer_manager_id text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'ABS_NORTH';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS revenue_brand_id text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS subtotal numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_value numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_type text DEFAULT 'amount';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS other_fee_value numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS other_fee_type text DEFAULT 'amount';
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS other_fee_amount numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipping_fee_value numeric NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS shipping_fee_amount numeric NOT NULL DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS total_amount numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS paid_amount numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS debt_amount numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS returned_amount numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS net_revenue numeric DEFAULT 0;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS order_date timestamptz DEFAULT now();
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE public.orders ADD COLUMN IF NOT EXISTS cancelled_by text;

CREATE TABLE IF NOT EXISTS public.draft_orders (LIKE public.orders INCLUDING DEFAULTS);
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS id text;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS customer_name text;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS notes text;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS items jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS total_market numeric DEFAULT 0;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS total_discount numeric DEFAULT 0;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS subtotal numeric DEFAULT 0;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS discount_value numeric DEFAULT 0;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS discount_type text DEFAULT 'amount';
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS other_fee_value numeric DEFAULT 0;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS other_fee_type text DEFAULT 'amount';
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS other_fee_amount numeric DEFAULT 0;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS shipping_fee_value numeric NOT NULL DEFAULT 0;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS shipping_fee_amount numeric NOT NULL DEFAULT 0;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS total_payable numeric DEFAULT 0;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS pricelist_id text;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'ABS_NORTH';
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS status text DEFAULT 'draft';
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE public.draft_orders ADD COLUMN IF NOT EXISTS updated_by text;
CREATE UNIQUE INDEX IF NOT EXISTS draft_orders_id_uidx ON public.draft_orders(id);

CREATE TABLE IF NOT EXISTS public.order_items (
  id text PRIMARY KEY,
  order_id text NOT NULL,
  product_id text,
  product_group_id text,
  variant_id text,
  brand_id text,
  product_code_snapshot text,
  variant_code_snapshot text,
  product_name_snapshot text,
  packaging_name_snapshot text,
  weight_or_volume_snapshot text,
  specification_snapshot text,
  unit_snapshot text,
  price_list_id text,
  price_list_name_snapshot text,
  price_source text,
  price_selected_by text,
  quantity numeric DEFAULT 0,
  list_price numeric DEFAULT 0,
  unit_price numeric DEFAULT 0,
  sale_price numeric DEFAULT 0,
  final_unit_price numeric DEFAULT 0,
  discount_percent numeric DEFAULT 0,
  discount_amount numeric DEFAULT 0,
  line_total numeric DEFAULT 0,
  cost_price numeric DEFAULT 0,
  profit_amount numeric DEFAULT 0,
  returned_quantity numeric DEFAULT 0,
  returned_amount numeric DEFAULT 0,
  net_amount numeric DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS product_group_id text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS variant_id text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS brand_id text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS product_code_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS variant_code_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS product_name_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS packaging_name_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS weight_or_volume_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS specification_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS unit_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_list_id text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_list_name_snapshot text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_source text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS price_selected_by text;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS quantity numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS list_price numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS unit_price numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS sale_price numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS final_unit_price numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS discount_percent numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS line_total numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS returned_quantity numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS returned_amount numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS net_amount numeric DEFAULT 0;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.cashbook_transactions (
  id text PRIMARY KEY,
  date timestamptz DEFAULT now(),
  transaction_date timestamptz DEFAULT now(),
  type text NOT NULL,
  transaction_type text,
  direction text,
  category text,
  partner text,
  customer_id text,
  order_id text,
  value numeric DEFAULT 0,
  method text DEFAULT 'cash',
  payment_method text DEFAULT 'cash',
  accounting boolean DEFAULT true,
  status text DEFAULT 'Da thanh toan',
  creator text,
  created_by text,
  note text,
  starred boolean DEFAULT false
);
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS transaction_date timestamptz DEFAULT now();
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS transaction_type text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS direction text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS order_id text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS payment_method text DEFAULT 'cash';
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE public.cashbook_transactions ADD COLUMN IF NOT EXISTS cancelled_by text;

CREATE TABLE IF NOT EXISTS public.payments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  customer_id text,
  order_id text,
  amount numeric NOT NULL DEFAULT 0,
  payment_method text NOT NULL DEFAULT 'cash',
  status text NOT NULL DEFAULT 'completed',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  cancelled_by text,
  cancelled_at timestamptz
);
ALTER TABLE public.payments ADD COLUMN IF NOT EXISTS updated_by text;

CREATE TABLE IF NOT EXISTS public.sales_returns (
  id text PRIMARY KEY,
  sale_id text NOT NULL,
  order_id text,
  customer_id text,
  salesperson_id text,
  total_return_amount numeric DEFAULT 0,
  debt_reduction_amount numeric DEFAULT 0,
  refund_amount numeric DEFAULT 0,
  total_refund numeric DEFAULT 0,
  reason text,
  status text DEFAULT 'completed',
  created_by text,
  created_at timestamptz DEFAULT now(),
  return_date timestamptz DEFAULT now()
);
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS order_id text;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS salesperson_id text;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS total_return_amount numeric DEFAULT 0;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS updated_by text;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS cancelled_by text;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS debt_reduction_amount numeric DEFAULT 0;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS refund_amount numeric DEFAULT 0;
ALTER TABLE public.sales_returns ADD COLUMN IF NOT EXISTS return_date timestamptz DEFAULT now();

CREATE TABLE IF NOT EXISTS public.sales_return_items (
  id text PRIMARY KEY,
  return_id text NOT NULL,
  sale_item_id text,
  product_id text,
  variant_id text,
  variant_code_snapshot text,
  product_name text,
  quantity numeric DEFAULT 0,
  import_price numeric DEFAULT 0,
  discount_type text DEFAULT 'percent',
  discount_value numeric DEFAULT 0,
  refund_price numeric DEFAULT 0,
  subtotal numeric DEFAULT 0,
  package_type text,
  packaging_name_snapshot text,
  specification_snapshot text
);
ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS variant_id text;
ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS variant_code_snapshot text;
ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS packaging_name_snapshot text;
ALTER TABLE public.sales_return_items ADD COLUMN IF NOT EXISTS specification_snapshot text;

CREATE TABLE IF NOT EXISTS public.customer_debt_transactions (
  id text PRIMARY KEY,
  customer_id text NOT NULL,
  transaction_type text NOT NULL,
  amount numeric DEFAULT 0,
  debt_change numeric DEFAULT 0,
  balance_before numeric DEFAULT 0,
  balance_after numeric DEFAULT 0,
  order_id text,
  sales_return_id text,
  cashbook_transaction_id text,
  starting_balance_id text,
  employee_id text,
  description text,
  transaction_date timestamptz DEFAULT now(),
  created_by text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.finished_goods_stock (
  product_code text NOT NULL,
  brand text NOT NULL,
  package_type text NOT NULL,
  quantity numeric NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now(),
  PRIMARY KEY(product_code, brand, package_type)
);

CREATE TABLE IF NOT EXISTS public.raw_materials (
  id text PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'kg',
  import_price numeric DEFAULT 0,
  quantity numeric NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.semi_finished (
  id text PRIMARY KEY,
  code text UNIQUE NOT NULL,
  name text NOT NULL,
  unit text NOT NULL DEFAULT 'kg',
  quantity numeric NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.recipes (
  id text PRIMARY KEY,
  name text NOT NULL,
  semi_finished_id text,
  output_quantity numeric NOT NULL DEFAULT 1,
  ingredients jsonb NOT NULL DEFAULT '[]'::jsonb,
  notes text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.production_logs (
  id text PRIMARY KEY,
  recipe_id text,
  recipe_name text NOT NULL,
  semi_finished_name text NOT NULL,
  quantity numeric NOT NULL,
  raw_materials_used jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.audit_logs (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  table_name text NOT NULL,
  action text NOT NULL,
  record_id text,
  old_data jsonb,
  new_data jsonb,
  performed_by text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.commission_transactions (
  id text PRIMARY KEY,
  employee_id text NOT NULL,
  salary_period text,
  order_id text,
  sales_return_id text,
  cashbook_transaction_id text,
  transaction_type text NOT NULL,
  calculation_basis text,
  basis_amount numeric DEFAULT 0,
  commission_rate numeric DEFAULT 0,
  commission_amount numeric DEFAULT 0,
  rule_id text,
  status text DEFAULT 'pending',
  calculated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.customer_assignments (
  id text PRIMARY KEY,
  customer_id text NOT NULL,
  employee_id text NOT NULL,
  brand_id text,
  assigned_from timestamptz DEFAULT now(),
  assigned_to timestamptz,
  is_active boolean DEFAULT true,
  assigned_by text,
  reason text,
  created_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.commission_rules (
  id text PRIMARY KEY,
  name text NOT NULL,
  employee_id text,
  position text,
  brand_id text,
  product_group_id text,
  calculation_basis text DEFAULT 'revenue',
  commission_rate numeric DEFAULT 0,
  fixed_amount numeric DEFAULT 0,
  minimum_revenue numeric DEFAULT 0,
  maximum_revenue numeric,
  effective_from timestamptz DEFAULT now(),
  effective_to timestamptz,
  is_active boolean DEFAULT true
);

CREATE TABLE IF NOT EXISTS public.starting_balances (
  id text PRIMARY KEY,
  cash numeric NOT NULL DEFAULT 0,
  bank numeric NOT NULL DEFAULT 0,
  wallet numeric NOT NULL DEFAULT 0,
  updated_at timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.suppliers (
  id text PRIMARY KEY,
  code text,
  name text NOT NULL,
  phone text,
  address text,
  debt numeric NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customers_managed_by ON public.customers(managed_by);
CREATE UNIQUE INDEX IF NOT EXISTS customers_id_uidx ON public.customers(id);
CREATE UNIQUE INDEX IF NOT EXISTS orders_id_uidx ON public.orders(id);
CREATE UNIQUE INDEX IF NOT EXISTS order_items_id_uidx ON public.order_items(id);
CREATE UNIQUE INDEX IF NOT EXISTS cashbook_transactions_id_uidx ON public.cashbook_transactions(id);
CREATE UNIQUE INDEX IF NOT EXISTS customer_debt_transactions_id_uidx ON public.customer_debt_transactions(id);
CREATE UNIQUE INDEX IF NOT EXISTS sales_returns_id_uidx ON public.sales_returns(id);
CREATE UNIQUE INDEX IF NOT EXISTS sales_return_items_id_uidx ON public.sales_return_items(id);
CREATE INDEX IF NOT EXISTS idx_orders_created_by ON public.orders(created_by);
CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON public.orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON public.order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_debt_customer_date ON public.customer_debt_transactions(customer_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_customer_assignments_customer ON public.customer_assignments(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_assignments_employee ON public.customer_assignments(employee_id);

INSERT INTO public.schema_migrations(version, description)
VALUES ('0001', 'Core compatibility schema and migration registry')
ON CONFLICT (version) DO NOTHING;

COMMIT;
