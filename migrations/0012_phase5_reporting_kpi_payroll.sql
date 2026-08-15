BEGIN;

-- Phase 5: server-authoritative reporting, KPI, payroll and commissions.
-- Intentionally contains no inventory or production dependency.

ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS position text;
ALTER TABLE public.profiles ADD COLUMN IF NOT EXISTS base_salary numeric NOT NULL DEFAULT 0;

ALTER TABLE public.commission_transactions ADD COLUMN IF NOT EXISTS order_item_id text;
ALTER TABLE public.commission_transactions ADD COLUMN IF NOT EXISTS rule_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.commission_transactions ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE public.commission_rules ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 100;
ALTER TABLE public.commission_rules ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM public.profiles WHERE base_salary < 0) THEN
    RAISE EXCEPTION 'Migration 0012 stopped: negative legacy base salary requires review';
  END IF;
  IF EXISTS (SELECT 1 FROM public.commission_rules
    WHERE commission_rate < 0 OR commission_rate > 100 OR fixed_amount < 0) THEN
    RAISE EXCEPTION 'Migration 0012 stopped: invalid legacy commission rule requires review';
  END IF;
END
$migration$;

ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_base_salary_check;
ALTER TABLE public.profiles ADD CONSTRAINT profiles_base_salary_check CHECK (base_salary >= 0);
ALTER TABLE public.commission_rules DROP CONSTRAINT IF EXISTS commission_rules_rate_check;
ALTER TABLE public.commission_rules ADD CONSTRAINT commission_rules_rate_check
  CHECK (commission_rate >= 0 AND commission_rate <= 100 AND fixed_amount >= 0
    AND minimum_revenue >= 0 AND (maximum_revenue IS NULL OR maximum_revenue >= minimum_revenue));

CREATE TABLE IF NOT EXISTS public.kpi_targets (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  employee_id text NOT NULL REFERENCES public.profiles(id),
  period text NOT NULL,
  target_type text NOT NULL DEFAULT 'net_sales',
  target_amount numeric NOT NULL DEFAULT 0,
  bonus_amount numeric NOT NULL DEFAULT 0,
  created_by text NOT NULL,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (employee_id, period, target_type),
  CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  CHECK (target_type IN ('gross_sales', 'net_sales', 'cash_collected', 'debt_collected')),
  CHECK (target_amount >= 0 AND bonus_amount >= 0)
);

CREATE TABLE IF NOT EXISTS public.payroll_periods (
  period text PRIMARY KEY,
  status text NOT NULL DEFAULT 'open',
  locked_at timestamptz,
  locked_by text,
  unlocked_at timestamptz,
  unlocked_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period ~ '^[0-9]{4}-[0-9]{2}$'),
  CHECK (status IN ('open', 'locked'))
);

CREATE TABLE IF NOT EXISTS public.payroll_adjustments (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  period text NOT NULL REFERENCES public.payroll_periods(period),
  employee_id text NOT NULL REFERENCES public.profiles(id),
  adjustment_type text NOT NULL,
  amount numeric NOT NULL DEFAULT 0,
  notes text NOT NULL,
  created_by text NOT NULL,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period, employee_id, adjustment_type),
  CHECK (adjustment_type IN ('kpi_bonus', 'other_bonus', 'deduction')),
  CHECK (amount >= 0)
);

CREATE TABLE IF NOT EXISTS public.payroll_entries (
  id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
  period text NOT NULL REFERENCES public.payroll_periods(period),
  employee_id text NOT NULL REFERENCES public.profiles(id),
  employee_snapshot jsonb NOT NULL,
  base_salary numeric NOT NULL DEFAULT 0,
  commission_amount numeric NOT NULL DEFAULT 0,
  kpi_bonus numeric NOT NULL DEFAULT 0,
  other_bonus numeric NOT NULL DEFAULT 0,
  deductions numeric NOT NULL DEFAULT 0,
  net_salary numeric NOT NULL DEFAULT 0,
  calculation_snapshot jsonb NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period, employee_id)
);

CREATE INDEX IF NOT EXISTS commission_transactions_period_employee_idx
  ON public.commission_transactions(salary_period, employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS commission_transactions_order_item_rule_uidx
  ON public.commission_transactions(order_item_id, rule_id)
  WHERE order_item_id IS NOT NULL AND transaction_type = 'order_commission';
CREATE INDEX IF NOT EXISTS kpi_targets_period_employee_idx ON public.kpi_targets(period, employee_id);
CREATE INDEX IF NOT EXISTS payroll_adjustments_period_employee_idx ON public.payroll_adjustments(period, employee_id);
CREATE INDEX IF NOT EXISTS payroll_entries_period_employee_idx ON public.payroll_entries(period, employee_id);

CREATE OR REPLACE FUNCTION public.p5_is_payroll_manager()
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$ SELECT public.current_profile_role() IN ('admin', 'accounting') $$;

CREATE OR REPLACE FUNCTION public.p5_apply_order_item_commission()
RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  sale public.orders%ROWTYPE;
  employee public.profiles%ROWTYPE;
  rule public.commission_rules%ROWTYPE;
  basis numeric;
  commission numeric;
BEGIN
  SELECT * INTO sale FROM public.orders WHERE id = NEW.order_id;
  IF NOT FOUND OR sale.status IN ('cancelled', 'canceled', 'draft') THEN RETURN NEW; END IF;

  SELECT * INTO employee FROM public.profiles profile
  WHERE profile.id = COALESCE(NULLIF(sale.salesperson_id, ''), NULLIF(sale.created_by, ''))
     OR profile.username = COALESCE(NULLIF(sale.salesperson_id, ''), NULLIF(sale.created_by, ''))
     OR profile.auth_user_id::text = COALESCE(NULLIF(sale.salesperson_id, ''), NULLIF(sale.created_by, ''))
  ORDER BY CASE WHEN profile.id = sale.salesperson_id THEN 0 ELSE 1 END
  LIMIT 1;
  IF NOT FOUND OR employee.is_active IS NOT TRUE THEN RETURN NEW; END IF;

  SELECT * INTO rule FROM public.commission_rules candidate
  WHERE candidate.is_active IS TRUE
    AND COALESCE(sale.order_date, sale.created_at, now()) >= candidate.effective_from
    AND (candidate.effective_to IS NULL OR COALESCE(sale.order_date, sale.created_at, now()) < candidate.effective_to)
    AND (candidate.employee_id IS NULL OR candidate.employee_id = employee.id)
    AND (candidate.position IS NULL OR candidate.position = employee.position OR candidate.position = employee.role)
    AND (candidate.brand_id IS NULL OR candidate.brand_id = NEW.brand_id)
    AND (candidate.product_group_id IS NULL OR candidate.product_group_id = NEW.product_group_id)
    AND COALESCE(NEW.net_amount, NEW.line_total, 0) >= COALESCE(candidate.minimum_revenue, 0)
    AND (candidate.maximum_revenue IS NULL OR COALESCE(NEW.net_amount, NEW.line_total, 0) <= candidate.maximum_revenue)
  ORDER BY
    (candidate.employee_id IS NOT NULL)::int DESC,
    (candidate.product_group_id IS NOT NULL)::int DESC,
    (candidate.brand_id IS NOT NULL)::int DESC,
    (candidate.position IS NOT NULL)::int DESC,
    candidate.priority ASC, candidate.effective_from DESC, candidate.id
  LIMIT 1;
  IF NOT FOUND THEN RETURN NEW; END IF;

  basis := GREATEST(0, COALESCE(NULLIF(NEW.net_amount, 0), NEW.line_total, 0));
  commission := round(basis * COALESCE(rule.commission_rate, 0) / 100 + COALESCE(rule.fixed_amount, 0));
  INSERT INTO public.commission_transactions(
    id, employee_id, salary_period, order_id, order_item_id, transaction_type,
    calculation_basis, basis_amount, commission_rate, commission_amount,
    rule_id, rule_snapshot, status, calculated_at, created_at, created_by
  ) VALUES (
    'COMM-ORDER-' || NEW.id || '-' || rule.id, employee.id,
    to_char(COALESCE(sale.order_date, sale.created_at, now()) AT TIME ZONE 'Asia/Bangkok', 'YYYY-MM'),
    sale.id, NEW.id, 'order_commission', rule.calculation_basis, basis,
    rule.commission_rate, commission, rule.id,
    jsonb_build_object('id', rule.id, 'name', rule.name, 'rate', rule.commission_rate,
      'fixed_amount', rule.fixed_amount, 'effective_from', rule.effective_from,
      'employee_id', rule.employee_id, 'position', rule.position,
      'brand_id', rule.brand_id, 'product_group_id', rule.product_group_id),
    'pending', now(), now(), sale.created_by
  ) ON CONFLICT DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS p5_order_item_commission ON public.order_items;
CREATE TRIGGER p5_order_item_commission
AFTER INSERT ON public.order_items
FOR EACH ROW EXECUTE FUNCTION public.p5_apply_order_item_commission();

CREATE OR REPLACE FUNCTION public.rpc_get_phase5_dashboard(p_filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  start_at timestamptz;
  end_at timestamptz;
  result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  start_at := COALESCE(NULLIF(p_filters->>'start', '')::timestamptz, date_trunc('month', now()));
  end_at := COALESCE(NULLIF(p_filters->>'end', '')::timestamptz, now() + interval '1 day');
  IF end_at <= start_at OR end_at - start_at > interval '5 years' THEN
    RAISE EXCEPTION 'Invalid reporting date range';
  END IF;

  WITH visible_orders AS (
    SELECT sale.* FROM public.orders sale
    WHERE COALESCE(sale.order_date, sale.created_at) >= start_at
      AND COALESCE(sale.order_date, sale.created_at) < end_at
      AND sale.status NOT IN ('cancelled', 'canceled', 'draft')
      AND (actor.role <> 'sale' OR sale.salesperson_id IN (actor.id, actor.username, actor.auth_user_id::text)
        OR sale.created_by IN (actor.id, actor.username, actor.auth_user_id::text))
      AND (NULLIF(p_filters->>'company_id', '') IS NULL OR p_filters->>'company_id' = 'all'
        OR sale.company_id = p_filters->>'company_id')
      AND (NULLIF(p_filters->>'customer_id', '') IS NULL OR p_filters->>'customer_id' = 'all'
        OR sale.customer_id = p_filters->>'customer_id')
      AND (actor.role = 'sale' OR NULLIF(p_filters->>'salesperson_id', '') IS NULL
        OR p_filters->>'salesperson_id' = 'all'
        OR sale.salesperson_id = p_filters->>'salesperson_id' OR sale.created_by = p_filters->>'salesperson_id')
  ), item_rows AS (
    SELECT item.*, sale.customer_id, sale.customer_name, sale.company_id, sale.salesperson_id,
      sale.customer_manager_id, sale.order_date, sale.created_at AS order_created_at
    FROM visible_orders sale JOIN public.order_items item ON item.order_id = sale.id
    WHERE NULLIF(p_filters->>'brand_id', '') IS NULL OR p_filters->>'brand_id' = 'all'
      OR item.brand_id = p_filters->>'brand_id'
  ), valid_returns AS (
    SELECT ret.* FROM public.sales_returns ret JOIN visible_orders sale ON sale.id = ret.sale_id
    WHERE ret.status NOT IN ('cancelled', 'canceled')
      AND COALESCE(ret.return_date, ret.created_at) >= start_at
      AND COALESCE(ret.return_date, ret.created_at) < end_at
  ), valid_payments AS (
    SELECT pay.* FROM public.payments pay
    WHERE pay.status = 'completed' AND pay.created_at >= start_at AND pay.created_at < end_at
      AND (actor.role <> 'sale' OR EXISTS (SELECT 1 FROM visible_orders sale WHERE sale.id = pay.order_id))
  ), customer_scope AS (
    SELECT customer.* FROM public.customers customer
    WHERE actor.role <> 'sale' OR customer.managed_by IN (actor.id, actor.username, actor.auth_user_id::text)
  )
  SELECT jsonb_build_object(
    'period', jsonb_build_object('start', start_at, 'end', end_at),
    'summary', jsonb_build_object(
      'gross_sales', COALESCE((SELECT sum(total_payable) FROM visible_orders), 0),
      'returns', COALESCE((SELECT sum(COALESCE(NULLIF(total_refund, 0), total_return_amount, 0)) FROM valid_returns), 0),
      'net_sales', COALESCE((SELECT sum(net_revenue) FROM visible_orders), 0),
      'collected', COALESCE((SELECT sum(amount) FROM valid_payments), 0),
      'debt_issued', COALESCE((SELECT sum(GREATEST(debt_amount, 0)) FROM visible_orders), 0),
      'debt_collected', COALESCE((SELECT sum(-debt_change) FROM public.customer_debt_transactions debt
        WHERE debt.transaction_date >= start_at AND debt.transaction_date < end_at AND debt.debt_change < 0
          AND (actor.role <> 'sale' OR EXISTS (SELECT 1 FROM customer_scope c WHERE c.id = debt.customer_id))), 0),
      'current_debt', COALESCE((SELECT sum(debt) FROM customer_scope), 0),
      'order_count', (SELECT count(*) FROM visible_orders),
      'sold_quantity', COALESCE((SELECT sum(quantity - COALESCE(returned_quantity, 0)) FROM item_rows), 0)
    ),
    'by_company', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object('key', company_id, 'amount', sum(CASE WHEN p_filters->>'sales_mode' = 'gross' THEN total_payable ELSE net_revenue END)) x FROM visible_orders GROUP BY company_id
    ) q), '[]'::jsonb),
    'by_brand', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object('key', COALESCE(brand_id, 'unassigned'), 'amount', sum(COALESCE(NULLIF(net_amount, 0), line_total))) x
      FROM item_rows GROUP BY brand_id
    ) q), '[]'::jsonb),
    'by_salesperson', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object('key', COALESCE(salesperson_id, 'unassigned'), 'amount', sum(CASE WHEN p_filters->>'sales_mode' = 'gross' THEN total_payable ELSE net_revenue END)) x
      FROM visible_orders GROUP BY salesperson_id
    ) q), '[]'::jsonb),
    'kpi_by_employee', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'net_sales')::numeric DESC) FROM (
      SELECT jsonb_build_object(
        'key', COALESCE(sale.salesperson_id, sale.created_by, 'unassigned'),
        'gross_sales', sum(sale.total_payable),
        'returns', sum(COALESCE((SELECT sum(COALESCE(NULLIF(ret.total_refund, 0), ret.total_return_amount, 0))
          FROM valid_returns ret WHERE ret.sale_id = sale.id), 0)),
        'net_sales', sum(sale.net_revenue),
        'collected', sum(COALESCE((SELECT sum(pay.amount) FROM valid_payments pay WHERE pay.order_id = sale.id), 0)),
        'debt_issued', sum(GREATEST(sale.debt_amount, 0))
      ) x FROM visible_orders sale GROUP BY COALESCE(sale.salesperson_id, sale.created_by, 'unassigned')
    ) q), '[]'::jsonb),
    'by_customer', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'amount')::numeric DESC) FROM (
      SELECT jsonb_build_object('key', customer_id, 'name', max(customer_name), 'amount', sum(CASE WHEN p_filters->>'sales_mode' = 'gross' THEN total_payable ELSE net_revenue END)) x
      FROM visible_orders GROUP BY customer_id
    ) q), '[]'::jsonb),
    'series', COALESCE((SELECT jsonb_agg(x ORDER BY x->>'date') FROM (
      SELECT jsonb_build_object('date', to_char(date_trunc('day', COALESCE(order_date, created_at) AT TIME ZONE 'Asia/Bangkok'), 'YYYY-MM-DD'),
        'amount', sum(CASE WHEN p_filters->>'sales_mode' = 'gross' THEN total_payable ELSE net_revenue END)) x
      FROM visible_orders GROUP BY date_trunc('day', COALESCE(order_date, created_at) AT TIME ZONE 'Asia/Bangkok')
    ) q), '[]'::jsonb),
    'top_skus', COALESCE((SELECT jsonb_agg(x ORDER BY (x->>'quantity')::numeric DESC) FROM (
      SELECT jsonb_build_object('code', COALESCE(variant_code_snapshot, product_code_snapshot),
        'name', product_name_snapshot, 'quantity', sum(quantity - COALESCE(returned_quantity, 0)),
        'amount', sum(COALESCE(NULLIF(net_amount, 0), line_total))) x
      FROM item_rows GROUP BY COALESCE(variant_code_snapshot, product_code_snapshot), product_name_snapshot
      ORDER BY sum(quantity - COALESCE(returned_quantity, 0)) DESC LIMIT 10
    ) q), '[]'::jsonb),
    'recent_orders', COALESCE((SELECT jsonb_agg(to_jsonb(q) ORDER BY q.order_date DESC) FROM (
      SELECT id, customer_id, customer_name, company_id, total_payable, net_revenue,
        COALESCE(order_date, created_at) order_date, status FROM visible_orders
      ORDER BY COALESCE(order_date, created_at) DESC LIMIT 10
    ) q), '[]'::jsonb)
  ) INTO result;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_phase5_report(p_input jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor public.profiles%ROWTYPE;
  report_type text := COALESCE(NULLIF(p_input->>'type', ''), 'debt');
  page_limit integer := LEAST(GREATEST(COALESCE((p_input->>'limit')::integer, 50), 1), 200);
  page_offset integer := GREATEST(COALESCE((p_input->>'offset')::integer, 0), 0);
  search_text text := lower(btrim(COALESCE(p_input->>'search', '')));
  return_mode text := COALESCE(NULLIF(p_input->>'mode', ''), 'product');
  result jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  IF report_type = 'debt' THEN
    WITH scoped AS (
      SELECT c.* FROM public.customers c
      WHERE (actor.role <> 'sale' OR c.managed_by IN (actor.id, actor.username, actor.auth_user_id::text))
        AND (search_text = '' OR lower(COALESCE(c.code, '') || ' ' || c.name || ' ' || COALESCE(c.phone, '')) LIKE '%' || search_text || '%')
    ), rows_page AS (
      SELECT id, code, name, phone, managed_by, debt, last_order_at, last_payment_at,
        CASE WHEN debt > 0 AND COALESCE(last_payment_at, last_order_at, created_at) < now() - interval '30 days' THEN debt ELSE 0 END overdue_debt
      FROM scoped ORDER BY debt DESC, name LIMIT page_limit OFFSET page_offset
    )
    SELECT jsonb_build_object('type', report_type, 'total', (SELECT count(*) FROM scoped),
      'summary', jsonb_build_object('total_debt', COALESCE((SELECT sum(debt) FROM scoped), 0),
        'overdue_debt', COALESCE((SELECT sum(CASE WHEN debt > 0 AND COALESCE(last_payment_at, last_order_at, created_at) < now() - interval '30 days' THEN debt ELSE 0 END) FROM scoped), 0)),
      'rows', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM rows_page r), '[]'::jsonb)) INTO result;
  ELSIF report_type = 'returns' THEN
    IF return_mode = 'product' THEN
      WITH grouped AS (
        SELECT COALESCE(item.variant_code_snapshot, item.product_id, 'unknown') code,
          COALESCE(max(item.product_name), max(item.variant_code_snapshot), item.product_id, 'Không xác định') name,
          sum(item.quantity) quantity, sum(item.subtotal) amount
        FROM public.sales_return_items item
        JOIN public.sales_returns ret ON ret.id = item.return_id
        JOIN public.orders sale ON sale.id = ret.sale_id
        WHERE ret.status NOT IN ('cancelled', 'canceled')
          AND (actor.role <> 'sale' OR sale.salesperson_id IN (actor.id, actor.username, actor.auth_user_id::text)
            OR sale.created_by IN (actor.id, actor.username, actor.auth_user_id::text))
        GROUP BY COALESCE(item.variant_code_snapshot, item.product_id, 'unknown'), item.product_id
      ), rows_page AS (SELECT * FROM grouped ORDER BY amount DESC LIMIT page_limit OFFSET page_offset)
      SELECT jsonb_build_object('type', report_type, 'mode', return_mode, 'total', (SELECT count(*) FROM grouped),
        'rows', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM rows_page r), '[]'::jsonb)) INTO result;
    ELSIF return_mode = 'customer' THEN
      WITH grouped AS (
        SELECT ret.customer_id key, max(COALESCE(customer.code, ret.customer_id)) code,
          max(COALESCE(customer.name, sale.customer_name)) name, count(*) count,
          sum(COALESCE(NULLIF(ret.total_refund, 0), ret.total_return_amount, 0)) amount
        FROM public.sales_returns ret JOIN public.orders sale ON sale.id = ret.sale_id
        LEFT JOIN public.customers customer ON customer.id = ret.customer_id
        WHERE ret.status NOT IN ('cancelled', 'canceled')
          AND (actor.role <> 'sale' OR sale.salesperson_id IN (actor.id, actor.username, actor.auth_user_id::text)
            OR sale.created_by IN (actor.id, actor.username, actor.auth_user_id::text))
        GROUP BY ret.customer_id
      ), rows_page AS (SELECT * FROM grouped ORDER BY amount DESC LIMIT page_limit OFFSET page_offset)
      SELECT jsonb_build_object('type', report_type, 'mode', return_mode, 'total', (SELECT count(*) FROM grouped),
        'rows', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM rows_page r), '[]'::jsonb)) INTO result;
    ELSIF return_mode = 'employee' THEN
      WITH grouped AS (
        SELECT COALESCE(sale.salesperson_id, sale.created_by, 'unassigned') key, count(*) count,
          sum(COALESCE(NULLIF(ret.total_refund, 0), ret.total_return_amount, 0)) amount
        FROM public.sales_returns ret JOIN public.orders sale ON sale.id = ret.sale_id
        WHERE ret.status NOT IN ('cancelled', 'canceled')
          AND (actor.role <> 'sale' OR sale.salesperson_id IN (actor.id, actor.username, actor.auth_user_id::text)
            OR sale.created_by IN (actor.id, actor.username, actor.auth_user_id::text))
        GROUP BY COALESCE(sale.salesperson_id, sale.created_by, 'unassigned')
      ), rows_page AS (SELECT * FROM grouped ORDER BY amount DESC LIMIT page_limit OFFSET page_offset)
      SELECT jsonb_build_object('type', report_type, 'mode', return_mode, 'total', (SELECT count(*) FROM grouped),
        'rows', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM rows_page r), '[]'::jsonb)) INTO result;
    ELSE
      RAISE EXCEPTION 'Unsupported return report mode';
    END IF;
  ELSIF report_type = 'kpi' THEN
    RETURN public.rpc_get_phase5_dashboard(p_input);
  ELSIF report_type = 'purchases' THEN
    IF actor.role = 'sale' THEN RAISE EXCEPTION 'Insufficient permission' USING ERRCODE = '42501'; END IF;
    WITH scoped AS (
      SELECT p.* FROM public.purchases p WHERE p.status NOT IN ('cancelled', 'canceled')
    ), rows_page AS (
      SELECT id, code, supplier_id, purchase_date, total_amount, paid_amount, balance_due, status
      FROM scoped ORDER BY purchase_date DESC LIMIT page_limit OFFSET page_offset
    )
    SELECT jsonb_build_object('type', report_type, 'total', (SELECT count(*) FROM scoped),
      'summary', jsonb_build_object('total_purchase', COALESCE((SELECT sum(total_amount) FROM scoped), 0),
        'total_paid', COALESCE((SELECT sum(paid_amount) FROM scoped), 0),
        'outstanding', COALESCE((SELECT sum(balance_due) FROM scoped), 0)),
      'rows', COALESCE((SELECT jsonb_agg(to_jsonb(r)) FROM rows_page r), '[]'::jsonb)) INTO result;
  ELSE
    RAISE EXCEPTION 'Unsupported report type';
  END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.p5_payroll_calculation(p_period text)
RETURNS TABLE(
  employee_id text, employee_code text, employee_name text, employee_position text,
  base_salary numeric, commission_amount numeric, kpi_bonus numeric, other_bonus numeric,
  deductions numeric, net_salary numeric
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH employees AS (
    SELECT profile.* FROM public.profiles profile WHERE profile.is_active = true
  ), commissions AS (
    SELECT tx.employee_id, COALESCE(sum(tx.commission_amount), 0) amount
    FROM public.commission_transactions tx
    WHERE tx.salary_period = p_period AND tx.status NOT IN ('cancelled', 'canceled')
    GROUP BY tx.employee_id
  ), adjustments AS (
    SELECT adj.employee_id,
      sum(adj.amount) FILTER (WHERE adj.adjustment_type = 'kpi_bonus') kpi_bonus,
      sum(adj.amount) FILTER (WHERE adj.adjustment_type = 'other_bonus') other_bonus,
      sum(adj.amount) FILTER (WHERE adj.adjustment_type = 'deduction') deductions
    FROM public.payroll_adjustments adj WHERE adj.period = p_period GROUP BY adj.employee_id
  )
  SELECT employee.id, employee.username, employee.display_name,
    COALESCE(NULLIF(employee.position, ''), employee.role), employee.base_salary,
    COALESCE(commission.amount, 0), COALESCE(adjustment.kpi_bonus, 0),
    COALESCE(adjustment.other_bonus, 0), COALESCE(adjustment.deductions, 0),
    GREATEST(0, round(employee.base_salary + COALESCE(commission.amount, 0)
      + COALESCE(adjustment.kpi_bonus, 0) + COALESCE(adjustment.other_bonus, 0)
      - COALESCE(adjustment.deductions, 0)))
  FROM employees employee
  LEFT JOIN commissions commission ON commission.employee_id = employee.id
  LEFT JOIN adjustments adjustment ON adjustment.employee_id = employee.id
  ORDER BY employee.display_name, employee.id
$$;

CREATE OR REPLACE FUNCTION public.rpc_get_payroll_period(p_period text)
RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; period_row public.payroll_periods%ROWTYPE; rows_json jsonb;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN RAISE EXCEPTION 'Insufficient permission' USING ERRCODE = '42501'; END IF;
  IF p_period !~ '^[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid payroll period'; END IF;
  SELECT * INTO period_row FROM public.payroll_periods WHERE period = p_period;
  IF FOUND AND period_row.status = 'locked' THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'userId', entry.employee_id, 'userCode', entry.employee_snapshot->>'username',
      'userName', entry.employee_snapshot->>'display_name', 'position', entry.employee_snapshot->>'position',
      'baseSalary', entry.base_salary, 'commissionAmt', entry.commission_amount,
      'kpiBonus', entry.kpi_bonus + entry.other_bonus, 'returnDeduction', 0,
      'deductions', entry.deductions, 'netSalary', entry.net_salary)), '[]'::jsonb)
    INTO rows_json FROM public.payroll_entries entry WHERE entry.period = p_period;
  ELSE
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'userId', calc.employee_id, 'userCode', calc.employee_code, 'userName', calc.employee_name,
      'position', calc.employee_position, 'baseSalary', calc.base_salary,
      'commissionAmt', calc.commission_amount, 'kpiBonus', calc.kpi_bonus + calc.other_bonus,
      'returnDeduction', 0, 'deductions', calc.deductions, 'netSalary', calc.net_salary)), '[]'::jsonb)
    INTO rows_json FROM public.p5_payroll_calculation(p_period) calc;
  END IF;
  RETURN jsonb_build_object('period', p_period, 'isLocked', COALESCE(period_row.status = 'locked', false),
    'lockedAt', period_row.locked_at, 'lockedBy', period_row.locked_by, 'rows', rows_json);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_save_payroll_adjustment(p_input jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; target_period text; target_employee text; target_type text; target_amount numeric; target_notes text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN RAISE EXCEPTION 'Insufficient permission' USING ERRCODE = '42501'; END IF;
  target_period := p_input->>'period'; target_employee := p_input->>'employee_id';
  target_type := p_input->>'adjustment_type'; target_amount := COALESCE((p_input->>'amount')::numeric, 0);
  target_notes := btrim(COALESCE(p_input->>'notes', ''));
  IF target_period !~ '^[0-9]{4}-[0-9]{2}$' OR target_type NOT IN ('kpi_bonus', 'other_bonus', 'deduction')
     OR target_amount < 0 OR target_notes = '' THEN RAISE EXCEPTION 'Invalid payroll adjustment'; END IF;
  INSERT INTO public.payroll_periods(period) VALUES (target_period) ON CONFLICT DO NOTHING;
  IF EXISTS (SELECT 1 FROM public.payroll_periods WHERE period = target_period AND status = 'locked') THEN
    RAISE EXCEPTION 'Payroll period is locked';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = target_employee AND is_active) THEN RAISE EXCEPTION 'Employee not found or inactive'; END IF;
  INSERT INTO public.payroll_adjustments(period, employee_id, adjustment_type, amount, notes, created_by, updated_by)
  VALUES (target_period, target_employee, target_type, target_amount, target_notes, actor.auth_user_id::text, actor.auth_user_id::text)
  ON CONFLICT (period, employee_id, adjustment_type) DO UPDATE SET amount = EXCLUDED.amount,
    notes = EXCLUDED.notes, updated_by = actor.auth_user_id::text, updated_at = now();
  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES ('payroll_adjustments', 'UPSERT', target_period || ':' || target_employee || ':' || target_type,
    jsonb_build_object('period', target_period, 'employee_id', target_employee, 'type', target_type, 'amount', target_amount, 'notes', target_notes),
    actor.auth_user_id::text, now());
  RETURN jsonb_build_object('success', true, 'performed_by', actor.auth_user_id::text);
END;
$$;

CREATE OR REPLACE FUNCTION public.rpc_set_payroll_period_lock(p_period text, p_lock boolean, p_reason text DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE actor public.profiles%ROWTYPE; current_status text;
BEGIN
  actor := public.require_authenticated_profile();
  IF actor.role NOT IN ('admin', 'accounting') THEN RAISE EXCEPTION 'Insufficient permission' USING ERRCODE = '42501'; END IF;
  IF p_period !~ '^[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'Invalid payroll period'; END IF;
  INSERT INTO public.payroll_periods(period) VALUES (p_period) ON CONFLICT DO NOTHING;
  SELECT status INTO current_status FROM public.payroll_periods WHERE period = p_period FOR UPDATE;
  IF p_lock AND current_status <> 'locked' THEN
    DELETE FROM public.payroll_entries WHERE period = p_period;
    INSERT INTO public.payroll_entries(period, employee_id, employee_snapshot, base_salary,
      commission_amount, kpi_bonus, other_bonus, deductions, net_salary, calculation_snapshot, created_by)
    SELECT p_period, calc.employee_id,
      jsonb_build_object('username', calc.employee_code, 'display_name', calc.employee_name, 'position', calc.employee_position),
      calc.base_salary, calc.commission_amount, calc.kpi_bonus, calc.other_bonus, calc.deductions, calc.net_salary,
      jsonb_build_object('formula', 'base+commission+kpi+other-deductions', 'calculated_at', now()), actor.auth_user_id::text
    FROM public.p5_payroll_calculation(p_period) calc;
    UPDATE public.payroll_periods SET status = 'locked', locked_at = now(), locked_by = actor.auth_user_id::text,
      unlocked_at = NULL, unlocked_by = NULL, updated_at = now() WHERE period = p_period;
  ELSIF NOT p_lock AND current_status = 'locked' THEN
    IF actor.role <> 'admin' THEN RAISE EXCEPTION 'Only admin can unlock payroll' USING ERRCODE = '42501'; END IF;
    IF btrim(COALESCE(p_reason, '')) = '' THEN RAISE EXCEPTION 'Unlock reason is required'; END IF;
    UPDATE public.payroll_periods SET status = 'open', unlocked_at = now(), unlocked_by = actor.auth_user_id::text,
      updated_at = now() WHERE period = p_period;
  END IF;
  INSERT INTO public.audit_logs(table_name, action, record_id, new_data, performed_by, created_at)
  VALUES ('payroll_periods', CASE WHEN p_lock THEN 'LOCK' ELSE 'UNLOCK' END, p_period,
    jsonb_build_object('reason', p_reason, 'status', CASE WHEN p_lock THEN 'locked' ELSE 'open' END), actor.auth_user_id::text, now());
  RETURN public.rpc_get_payroll_period(p_period) || jsonb_build_object('performed_by', actor.auth_user_id::text);
END;
$$;

ALTER TABLE public.kpi_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_adjustments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payroll_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commission_transactions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS p5_kpi_manager_select ON public.kpi_targets;
CREATE POLICY p5_kpi_manager_select ON public.kpi_targets FOR SELECT TO authenticated
  USING (public.p5_is_payroll_manager() OR employee_id = (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid()));
DROP POLICY IF EXISTS p5_payroll_period_manager_select ON public.payroll_periods;
CREATE POLICY p5_payroll_period_manager_select ON public.payroll_periods FOR SELECT TO authenticated USING (public.p5_is_payroll_manager());
DROP POLICY IF EXISTS p5_payroll_adjustment_manager_select ON public.payroll_adjustments;
CREATE POLICY p5_payroll_adjustment_manager_select ON public.payroll_adjustments FOR SELECT TO authenticated USING (public.p5_is_payroll_manager());
DROP POLICY IF EXISTS p5_payroll_entries_manager_select ON public.payroll_entries;
CREATE POLICY p5_payroll_entries_manager_select ON public.payroll_entries FOR SELECT TO authenticated USING (public.p5_is_payroll_manager());
DROP POLICY IF EXISTS p5_commission_rules_manager_select ON public.commission_rules;
CREATE POLICY p5_commission_rules_manager_select ON public.commission_rules FOR SELECT TO authenticated USING (public.p5_is_payroll_manager());
DROP POLICY IF EXISTS p5_commission_transactions_scoped_select ON public.commission_transactions;
CREATE POLICY p5_commission_transactions_scoped_select ON public.commission_transactions FOR SELECT TO authenticated
  USING (public.p5_is_payroll_manager() OR employee_id = (SELECT id FROM public.profiles WHERE auth_user_id = auth.uid()));

REVOKE ALL ON TABLE public.kpi_targets, public.payroll_periods, public.payroll_adjustments, public.payroll_entries FROM anon;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.kpi_targets, public.payroll_periods, public.payroll_adjustments,
  public.payroll_entries, public.commission_rules, public.commission_transactions FROM authenticated;
REVOKE ALL ON FUNCTION public.p5_is_payroll_manager() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.p5_apply_order_item_commission() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_get_phase5_dashboard(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_get_phase5_report(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.p5_payroll_calculation(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rpc_get_payroll_period(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_save_payroll_adjustment(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.rpc_set_payroll_period_lock(text, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.p5_is_payroll_manager() TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_phase5_dashboard(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_phase5_report(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_get_payroll_period(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_save_payroll_adjustment(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rpc_set_payroll_period_lock(text, boolean, text) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0012', 'Server-authoritative dashboard, reports, KPI, payroll and rule-based commission ledger')
ON CONFLICT (version) DO NOTHING;

COMMIT;
