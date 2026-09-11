-- ====================================================================
-- MIGRATION REFACTOR SUPABASE DATABASE SCHEMA (WEBLENDON)
-- Áp dụng ALTER TABLE IF EXISTS / CREATE TABLE IF NOT EXISTS
-- Đảm bảo KHÔNG DROP TABLE, KHÔNG LÀM MẤT DỮ LIỆU CŨ.
-- ====================================================================

-- 1. BẢNG CUSTOMERS / WL_CUSTOMERS
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS phone2 text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS email text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS facebook text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS birthday text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS gender text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS avatar_url text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS province text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS ward text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS customer_group_id text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS company_name text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS tax_code text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS invoice_address text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS status text DEFAULT 'active';
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS total_return numeric DEFAULT 0;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS net_revenue numeric DEFAULT 0;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS last_order_at timestamptz;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS last_payment_at timestamptz;
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE IF EXISTS customers ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- 2. BỔ SUNG CỘT BẢNG USERS / WL_USERS
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS employee_code text;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS position text;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS manager_id text;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'ABS_NORTH';
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS base_salary numeric DEFAULT 0;
ALTER TABLE IF EXISTS users ADD COLUMN IF NOT EXISTS employment_status text DEFAULT 'active';

-- 3. BẢNG ORDERS / WL_ORDERS
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_id text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS salesperson_id text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS customer_manager_id text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS company_id text DEFAULT 'ABS_NORTH';
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS revenue_brand_id text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS subtotal numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS discount_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS total_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS paid_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS debt_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS returned_amount numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS net_revenue numeric DEFAULT 0;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS status text DEFAULT 'settled';
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS order_date timestamptz DEFAULT now();
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS confirmed_at timestamptz;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS created_by text;
ALTER TABLE IF EXISTS orders ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();

-- 4. BẢNG ORDER_ITEMS / WL_ORDER_ITEMS
CREATE TABLE IF NOT EXISTS order_items (
    id text PRIMARY KEY,
    order_id text NOT NULL,
    product_id text,
    brand_id text,
    product_code_snapshot text,
    product_name_snapshot text,
    specification_snapshot text,
    unit_snapshot text,
    price_list_id text,
    price_list_name_snapshot text,
    unit_price numeric,
    price_source text,
    price_selected_by text,
    final_unit_price numeric,
    quantity numeric DEFAULT 0,
    list_price numeric DEFAULT 0,
    sale_price numeric DEFAULT 0,
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

-- 5. BẢNG CUSTOMER_ASSIGNMENTS (Phân công chăm sóc khách hàng)
CREATE TABLE IF NOT EXISTS customer_assignments (
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

-- 6. BẢNG COMMISSION_RULES (Quy tắc hoa hồng)
CREATE TABLE IF NOT EXISTS commission_rules (
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

-- 7. BẢNG COMMISSION_TRANSACTIONS (Giao dịch hoa hồng)
CREATE TABLE IF NOT EXISTS commission_transactions (
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

-- 8. BẢNG CUSTOMER_DEBT_TRANSACTIONS
CREATE TABLE IF NOT EXISTS customer_debt_transactions (
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

-- 9. BẢNG AUDIT LOGS (Nhật ký truy vết thao tác)
CREATE TABLE IF NOT EXISTS audit_logs (
    id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
    table_name text NOT NULL,
    action text NOT NULL,
    record_id text,
    old_data jsonb,
    new_data jsonb,
    performed_by text,
    created_at timestamptz DEFAULT now()
);

-- RLS & POLICIES
ALTER TABLE IF EXISTS order_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS customer_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS commission_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS commission_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS customer_debt_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS manage_order_items ON order_items;
CREATE POLICY manage_order_items ON order_items FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS manage_customer_assignments ON customer_assignments;
CREATE POLICY manage_customer_assignments ON customer_assignments FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS manage_commission_rules ON commission_rules;
CREATE POLICY manage_commission_rules ON commission_rules FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS manage_commission_transactions ON commission_transactions;
CREATE POLICY manage_commission_transactions ON commission_transactions FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS manage_customer_debt_transactions ON customer_debt_transactions;
CREATE POLICY manage_customer_debt_transactions ON customer_debt_transactions FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS manage_audit_logs ON audit_logs;
CREATE POLICY manage_audit_logs ON audit_logs FOR ALL USING (true) WITH CHECK (true);

-- 10. TẠO THỦ TỤC VÀ TRIGGER CHO AUDIT LOGS
CREATE OR REPLACE FUNCTION rpc_log_audit_trail() RETURNS TRIGGER AS $$
BEGIN
    IF (TG_OP = 'DELETE') THEN
        INSERT INTO audit_logs (table_name, action, record_id, old_data, performed_by, created_at)
        VALUES (TG_TABLE_NAME, 'DELETE', OLD.id, to_jsonb(OLD), COALESCE(current_setting('app.current_user', true), 'system'), now());
        RETURN OLD;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO audit_logs (table_name, action, record_id, old_data, new_data, performed_by, created_at)
        VALUES (TG_TABLE_NAME, 'UPDATE', NEW.id, to_jsonb(OLD), to_jsonb(NEW), COALESCE(current_setting('app.current_user', true), 'system'), now());
        RETURN NEW;
    ELSIF (TG_OP = 'INSERT') THEN
        INSERT INTO audit_logs (table_name, action, record_id, new_data, performed_by, created_at)
        VALUES (TG_TABLE_NAME, 'INSERT', NEW.id, to_jsonb(NEW), COALESCE(current_setting('app.current_user', true), 'system'), now());
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

DROP TRIGGER IF EXISTS trg_audit_customers ON customers;
CREATE TRIGGER trg_audit_customers AFTER INSERT OR UPDATE OR DELETE ON customers FOR EACH ROW EXECUTE FUNCTION rpc_log_audit_trail();

DROP TRIGGER IF EXISTS trg_audit_orders ON orders;
CREATE TRIGGER trg_audit_orders AFTER INSERT OR UPDATE OR DELETE ON orders FOR EACH ROW EXECUTE FUNCTION rpc_log_audit_trail();

DROP TRIGGER IF EXISTS trg_audit_returns ON sales_returns;
CREATE TRIGGER trg_audit_returns AFTER INSERT OR UPDATE OR DELETE ON sales_returns FOR EACH ROW EXECUTE FUNCTION rpc_log_audit_trail();

-- 11. INDEXES HIỆU NĂNG CAO DÀNH CHO 10.000.000 ORDER_ITEMS & 1.000.000 ORDERS
CREATE INDEX IF NOT EXISTS idx_customers_code ON customers(code);
CREATE INDEX IF NOT EXISTS idx_customers_managed_by ON customers(managed_by);
CREATE INDEX IF NOT EXISTS idx_customers_status_created ON customers(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_customers_debt ON customers(debt DESC);

CREATE INDEX IF NOT EXISTS idx_orders_customer_id ON orders(customer_id);
CREATE INDEX IF NOT EXISTS idx_orders_salesperson_id ON orders(salesperson_id);
CREATE INDEX IF NOT EXISTS idx_orders_order_date ON orders(order_date DESC);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_comp_date ON orders(company_id, order_date DESC);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_order_items_product_id ON order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_order_items_created_at ON order_items(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sales_returns_customer_id ON sales_returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_sales_returns_order_id ON sales_returns(order_id);
CREATE INDEX IF NOT EXISTS idx_sales_returns_date ON sales_returns(return_date DESC);

CREATE INDEX IF NOT EXISTS idx_cashbook_customer_id ON cashbook_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_cashbook_date ON cashbook_transactions(date DESC);

CREATE INDEX IF NOT EXISTS idx_cust_debt_tx_cust_id ON customer_debt_transactions(customer_id, transaction_date DESC);
CREATE INDEX IF NOT EXISTS idx_cust_assign_cust_id ON customer_assignments(customer_id);
CREATE INDEX IF NOT EXISTS idx_comm_tx_emp_period ON commission_transactions(employee_id, salary_period);
CREATE INDEX IF NOT EXISTS idx_audit_table_record ON audit_logs(table_name, record_id);

-- 12. PRE-COMPUTED VIEWS PHÂN TÍCH TỐC ĐỘ CAO
CREATE OR REPLACE VIEW v_customer_summary AS
SELECT 
    c.id, c.code, c.name, c.phone, c.phone2, c.email, c.address, c.province, c.ward,
    c.status, c.debt, c.total_transaction, c.total_return, c.net_revenue, c.managed_by,
    c.last_order_at, c.last_payment_at, c.created_at,
    COUNT(o.id) AS total_orders_count
FROM customers c
LEFT JOIN orders o ON o.customer_id = c.id
GROUP BY c.id;

CREATE OR REPLACE VIEW v_dashboard_metrics AS
SELECT 
    COALESCE(SUM(total_payable), 0) AS gross_revenue,
    COUNT(id) AS total_orders,
    COALESCE(SUM(paid_amount), 0) AS total_paid,
    COALESCE(SUM(debt_amount), 0) AS total_debt
FROM orders
WHERE status <> 'cancelled';

-- 13. RPC PHÂN TRANG VÀ TẢI LAZY LOADING SERVER-SIDE (100.000 KHÁCH HÀNG & 1.000.000 ĐƠN HÀNG)
CREATE OR REPLACE FUNCTION rpc_get_customers_paginated(
    p_search text DEFAULT '',
    p_managed_by text DEFAULT NULL,
    p_limit int DEFAULT 50,
    p_offset int DEFAULT 0
) RETURNS jsonb AS $$
DECLARE
    v_total bigint;
    v_data jsonb;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM customers
    WHERE (p_search = '' OR code ILIKE '%' || p_search || '%' OR name ILIKE '%' || p_search || '%' OR phone ILIKE '%' || p_search || '%')
      AND (p_managed_by IS NULL OR p_managed_by = 'all' OR managed_by = p_managed_by);

    SELECT jsonb_agg(to_jsonb(c)) INTO v_data
    FROM (
        SELECT *
        FROM customers
        WHERE (p_search = '' OR code ILIKE '%' || p_search || '%' OR name ILIKE '%' || p_search || '%' OR phone ILIKE '%' || p_search || '%')
          AND (p_managed_by IS NULL OR p_managed_by = 'all' OR managed_by = p_managed_by)
        ORDER BY created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) c;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'data', COALESCE(v_data, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION rpc_get_orders_paginated(
    p_search text DEFAULT '',
    p_status text DEFAULT NULL,
    p_customer_id text DEFAULT NULL,
    p_limit int DEFAULT 50,
    p_offset int DEFAULT 0
) RETURNS jsonb AS $$
DECLARE
    v_total bigint;
    v_data jsonb;
BEGIN
    SELECT COUNT(*) INTO v_total
    FROM orders
    WHERE (p_search = '' OR id ILIKE '%' || p_search || '%' OR customer_name ILIKE '%' || p_search || '%')
      AND (p_status IS NULL OR p_status = 'all' OR status = p_status)
      AND (p_customer_id IS NULL OR customer_id = p_customer_id);

    SELECT jsonb_agg(to_jsonb(o)) INTO v_data
    FROM (
        SELECT *
        FROM orders
        WHERE (p_search = '' OR id ILIKE '%' || p_search || '%' OR customer_name ILIKE '%' || p_search || '%')
          AND (p_status IS NULL OR p_status = 'all' OR status = p_status)
          AND (p_customer_id IS NULL OR customer_id = p_customer_id)
        ORDER BY order_date DESC, created_at DESC
        LIMIT p_limit OFFSET p_offset
    ) o;

    RETURN jsonb_build_object(
        'total', v_total,
        'limit', p_limit,
        'offset', p_offset,
        'data', COALESCE(v_data, '[]'::jsonb)
    );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 14. THỦ TỤC GIAO DỊCH DATABASE TRANSACTIONS DÙNG CHO HỆ THỐNG GIAO DỊCH
CREATE OR REPLACE FUNCTION rpc_confirm_order(p_order jsonb) RETURNS jsonb AS $$
DECLARE
    v_order_id text;
    v_cust_id text;
    v_total_payable numeric;
    v_created_by text;
    v_emp_id text;
    v_bal_before numeric := 0;
    v_bal_after numeric := 0;
    v_tx_id text;
    v_comm_tx_id text;
    v_rule_id text := NULL;
    v_comm_rate numeric := 0;
    v_comm_amount numeric := 0;
BEGIN
    v_order_id := p_order->>'id';
    v_cust_id := p_order->>'customerId';
    v_total_payable := COALESCE((p_order->>'totalPayable')::numeric, 0);
    v_created_by := COALESCE(p_order->>'createdBy', 'admin');
    v_emp_id := COALESCE(p_order->>'salespersonId', p_order->>'customerManagerId', v_created_by);

    INSERT INTO orders (
        id, customer_id, customer_name, items, total_payable, total_amount, subtotal, discount_amount,
        status, pricelist_id, created_by, company_id, order_date, created_at, updated_at
    ) VALUES (
        v_order_id, v_cust_id, COALESCE(p_order->>'customerName', ''),
        p_order->'items',
        v_total_payable, v_total_payable, COALESCE((p_order->>'subtotal')::numeric, v_total_payable),
        COALESCE((p_order->>'discountAmount')::numeric, 0), COALESCE(p_order->>'status', 'settled'),
        COALESCE(p_order->>'pricelistId', 'retail'), v_created_by, COALESCE(p_order->>'companyId', 'ABS_NORTH'),
        COALESCE((p_order->>'date')::timestamptz, now()), now(), now()
    ) ON CONFLICT (id) DO UPDATE SET
        items = EXCLUDED.items,
        total_payable = EXCLUDED.total_payable,
        total_amount = EXCLUDED.total_amount,
        status = EXCLUDED.status,
        updated_at = now();

    IF v_cust_id IS NOT NULL AND v_cust_id <> '' THEN
        SELECT COALESCE(debt, 0) INTO v_bal_before FROM customers WHERE id = v_cust_id FOR UPDATE;
        v_bal_after := v_bal_before + v_total_payable;

        v_tx_id := 'dtx-ord-' || v_order_id || '-' || floor(extract(epoch from now()) * 1000)::text;
        INSERT INTO customer_debt_transactions (
            id, customer_id, transaction_type, amount, debt_change,
            balance_before, balance_after, order_id, description, created_by, transaction_date
        ) VALUES (
            v_tx_id, v_cust_id, 'order', v_total_payable, v_total_payable,
            v_bal_before, v_bal_after, v_order_id, 'Mua hàng (Hóa đơn ' || v_order_id || ')', v_created_by, now()
        );

        UPDATE customers SET
            total_transaction = COALESCE(total_transaction, 0) + v_total_payable,
            net_revenue = COALESCE(net_revenue, 0) + v_total_payable,
            debt = v_bal_after,
            last_order_at = now(),
            updated_at = now()
        WHERE id = v_cust_id;
    END IF;

    IF v_emp_id IS NOT NULL AND v_emp_id <> '' THEN
        SELECT id, COALESCE(commission_rate, 0) INTO v_rule_id, v_comm_rate
        FROM commission_rules
        WHERE (employee_id = v_emp_id OR position = (SELECT position FROM users WHERE id = v_emp_id OR username = v_emp_id LIMIT 1))
          AND is_active = true
        ORDER BY employee_id NULLS LAST
        LIMIT 1;

        IF v_comm_rate IS NULL THEN v_comm_rate := 0; END IF;
        v_comm_amount := v_total_payable * (v_comm_rate / 100.0);
        v_comm_tx_id := 'comm-ord-' || v_order_id || '-' || floor(extract(epoch from now()) * 1000)::text;

        INSERT INTO commission_transactions (
            id, employee_id, salary_period, order_id, transaction_type,
            calculation_basis, basis_amount, commission_rate, commission_amount, rule_id, status, calculated_at, created_at
        ) VALUES (
            v_comm_tx_id, v_emp_id, to_char(now(), 'YYYY-MM'), v_order_id, 'order',
            'order_revenue', v_total_payable, v_comm_rate, v_comm_amount, v_rule_id, 'pending', now(), now()
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'order_id', v_order_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION rpc_record_customer_payment(
    p_customer_id text, p_amount numeric, p_notes text, p_created_by text
) RETURNS jsonb AS $$
DECLARE
    v_bal_before numeric := 0;
    v_bal_after numeric := 0;
    v_debt_change numeric := 0;
    v_tx_id text;
    v_cashbook_id text;
    v_emp_id text;
    v_rule_id text := NULL;
    v_comm_rate numeric := 0;
    v_comm_amount numeric := 0;
BEGIN
    IF p_customer_id IS NULL OR p_customer_id = '' THEN
        RAISE EXCEPTION 'Customer ID cannot be null';
    END IF;

    SELECT COALESCE(debt, 0), managed_by INTO v_bal_before, v_emp_id FROM customers WHERE id = p_customer_id FOR UPDATE;
    IF v_emp_id IS NULL OR v_emp_id = '' THEN v_emp_id := p_created_by; END IF;

    v_debt_change := CASE WHEN v_bal_before < 0 THEN p_amount ELSE -p_amount END;
    v_bal_after := v_bal_before + v_debt_change;
    v_cashbook_id := 'cb-' || floor(extract(epoch from now()) * 1000)::text;
    v_tx_id := 'dtx-pay-' || floor(extract(epoch from now()) * 1000)::text;

    INSERT INTO cashbook_transactions (
        id, date, transaction_date, type, transaction_type, direction, category, partner, customer_id,
        value, method, payment_method, accounting, status, creator, created_by, note
    ) VALUES (
        v_cashbook_id, now(), now(), 'thu', 'Thu nợ khách hàng', 'in', 'Thu nợ khách hàng',
        (SELECT name FROM customers WHERE id = p_customer_id), p_customer_id,
        p_amount, 'cash', 'cash', true, 'Đã thanh toán', p_created_by, p_created_by, p_notes
    );

    INSERT INTO customer_debt_transactions (
        id, customer_id, transaction_type, amount, debt_change,
        balance_before, balance_after, cashbook_transaction_id, description, created_by, transaction_date
    ) VALUES (
            v_tx_id, p_customer_id, 'payment', p_amount, v_debt_change,
        v_bal_before, v_bal_after, v_cashbook_id, COALESCE(p_notes, 'Thu tiền nợ'), p_created_by, now()
    );

    UPDATE customers SET
        debt = v_bal_after,
        last_payment_at = now(),
        updated_at = now()
    WHERE id = p_customer_id;

    IF v_emp_id IS NOT NULL AND v_emp_id <> '' THEN
        SELECT id, COALESCE(commission_rate, 0) INTO v_rule_id, v_comm_rate
        FROM commission_rules
        WHERE (employee_id = v_emp_id OR position = (SELECT position FROM users WHERE id = v_emp_id OR username = v_emp_id LIMIT 1))
          AND is_active = true
        ORDER BY employee_id NULLS LAST
        LIMIT 1;

        IF v_comm_rate IS NULL THEN v_comm_rate := 0; END IF;
        v_comm_amount := p_amount * (v_comm_rate / 100.0);

        INSERT INTO commission_transactions (
            id, employee_id, salary_period, cashbook_transaction_id, transaction_type,
            calculation_basis, basis_amount, commission_rate, commission_amount, rule_id, status, calculated_at, created_at
        ) VALUES (
            'comm-pay-' || v_cashbook_id || '-' || floor(extract(epoch from now()) * 1000)::text,
            v_emp_id, to_char(now(), 'YYYY-MM'), v_cashbook_id, 'payment',
            'collected_cash', p_amount, v_comm_rate, v_comm_amount, v_rule_id, 'pending', now(), now()
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'cashbook_id', v_cashbook_id, 'new_debt', v_bal_after);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE OR REPLACE FUNCTION rpc_record_sales_return(
    p_return_id text, p_sale_id text, p_customer_id text, p_total_refund numeric,
    p_reason text, p_created_by text, p_items jsonb, p_order_status text
) RETURNS jsonb AS $$
DECLARE
    v_bal_before numeric := 0;
    v_bal_after numeric := 0;
    v_tx_id text;
    v_emp_id text;
    v_rule_id text := NULL;
    v_comm_rate numeric := 0;
    v_comm_amount numeric := 0;
BEGIN
    v_emp_id := COALESCE(p_created_by, (SELECT managed_by FROM customers WHERE id = p_customer_id));

    INSERT INTO sales_returns (
        id, sale_id, order_id, customer_id, salesperson_id, total_return_amount,
        debt_reduction_amount, refund_amount, total_refund, reason, status, created_by, created_at, return_date
    ) VALUES (
        p_return_id, p_sale_id, p_sale_id, p_customer_id, v_emp_id, p_total_refund,
        p_total_refund, 0, p_total_refund, p_reason, 'completed', p_created_by, now(), now()
    ) ON CONFLICT (id) DO UPDATE SET
        total_refund = EXCLUDED.total_refund,
        status = EXCLUDED.status;

    IF p_sale_id IS NOT NULL THEN
        UPDATE orders SET status = p_order_status, updated_at = now() WHERE id = p_sale_id;
    END IF;

    IF p_customer_id IS NOT NULL AND p_customer_id <> '' THEN
        SELECT COALESCE(debt, 0) INTO v_bal_before FROM customers WHERE id = p_customer_id FOR UPDATE;
        v_bal_after := v_bal_before - p_total_refund;

        v_tx_id := 'dtx-ret-' || p_return_id || '-' || floor(extract(epoch from now()) * 1000)::text;
        INSERT INTO customer_debt_transactions (
            id, customer_id, transaction_type, amount, debt_change,
            balance_before, balance_after, sales_return_id, order_id, description, created_by, transaction_date
        ) VALUES (
            v_tx_id, p_customer_id, 'return', p_total_refund, -p_total_refund,
            v_bal_before, v_bal_after, p_return_id, p_sale_id, 'Phiếu trả hàng ' || p_return_id || ': ' || COALESCE(p_reason, ''), p_created_by, now()
        );

        UPDATE customers SET
            total_return = COALESCE(total_return, 0) + p_total_refund,
            net_revenue = COALESCE(net_revenue, 0) - p_total_refund,
            debt = v_bal_after,
            updated_at = now()
        WHERE id = p_customer_id;
    END IF;

    IF v_emp_id IS NOT NULL AND v_emp_id <> '' THEN
        SELECT id, COALESCE(commission_rate, 0) INTO v_rule_id, v_comm_rate
        FROM commission_rules
        WHERE (employee_id = v_emp_id OR position = (SELECT position FROM users WHERE id = v_emp_id OR username = v_emp_id LIMIT 1))
          AND is_active = true
        ORDER BY employee_id NULLS LAST
        LIMIT 1;

        IF v_comm_rate IS NULL THEN v_comm_rate := 0; END IF;
        v_comm_amount := -(p_total_refund * (v_comm_rate / 100.0));

        INSERT INTO commission_transactions (
            id, employee_id, salary_period, sales_return_id, order_id, transaction_type,
            calculation_basis, basis_amount, commission_rate, commission_amount, rule_id, status, calculated_at, created_at
        ) VALUES (
            'comm-ret-' || p_return_id || '-' || floor(extract(epoch from now()) * 1000)::text,
            v_emp_id, to_char(now(), 'YYYY-MM'), p_return_id, p_sale_id, 'return',
            'return_deduction', p_total_refund, v_comm_rate, v_comm_amount, v_rule_id, 'pending', now(), now()
        );
    END IF;

    RETURN jsonb_build_object('success', true, 'return_id', p_return_id);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
