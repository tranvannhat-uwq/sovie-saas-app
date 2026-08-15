-- Fix customer payment direction without rewriting existing customer balances.
CREATE OR REPLACE FUNCTION public.rpc_record_customer_payment(
    p_customer_id text,
    p_amount numeric,
    p_notes text,
    p_created_by text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
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
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'Payment amount must be greater than zero';
    END IF;

    SELECT COALESCE(debt, 0), managed_by
    INTO STRICT v_bal_before, v_emp_id
    FROM public.customers
    WHERE id = p_customer_id
    FOR UPDATE;

    IF v_emp_id IS NULL OR v_emp_id = '' THEN
        v_emp_id := p_created_by;
    END IF;

    -- Imported balances use a negative value for receivables. Move either
    -- sign toward zero instead of always subtracting the payment.
    v_debt_change := CASE
        WHEN v_bal_before < 0 THEN p_amount
        ELSE -p_amount
    END;
    v_bal_after := v_bal_before + v_debt_change;

    v_cashbook_id := 'cb-' || floor(extract(epoch from clock_timestamp()) * 1000)::text;
    v_tx_id := 'dtx-pay-' || floor(extract(epoch from clock_timestamp()) * 1000)::text;

    INSERT INTO public.cashbook_transactions (
        id, date, transaction_date, type, transaction_type, direction,
        category, partner, customer_id, value, method, payment_method,
        accounting, status, creator, created_by, note
    ) VALUES (
        v_cashbook_id, now(), now(), 'thu', 'Thu nợ khách hàng', 'in',
        'Thu nợ khách hàng',
        (SELECT name FROM public.customers WHERE id = p_customer_id),
        p_customer_id, p_amount, 'cash', 'cash', true, 'Đã thanh toán',
        p_created_by, p_created_by, p_notes
    );

    INSERT INTO public.customer_debt_transactions (
        id, customer_id, transaction_type, amount, debt_change,
        balance_before, balance_after, cashbook_transaction_id,
        description, created_by, transaction_date
    ) VALUES (
        v_tx_id, p_customer_id, 'payment', p_amount, v_debt_change,
        v_bal_before, v_bal_after, v_cashbook_id,
        COALESCE(p_notes, 'Thu tiền nợ'), p_created_by, now()
    );

    UPDATE public.customers
    SET debt = v_bal_after,
        last_payment_at = now(),
        updated_at = now()
    WHERE id = p_customer_id;

    IF v_emp_id IS NOT NULL AND v_emp_id <> '' THEN
        SELECT id, COALESCE(commission_rate, 0)
        INTO v_rule_id, v_comm_rate
        FROM public.commission_rules
        WHERE (
            employee_id = v_emp_id
            OR position = (
                SELECT position
                FROM public.users
                WHERE id = v_emp_id OR username = v_emp_id
                LIMIT 1
            )
        )
          AND is_active = true
        ORDER BY employee_id NULLS LAST
        LIMIT 1;

        v_comm_rate := COALESCE(v_comm_rate, 0);
        v_comm_amount := p_amount * (v_comm_rate / 100.0);

        INSERT INTO public.commission_transactions (
            id, employee_id, salary_period, cashbook_transaction_id,
            transaction_type, calculation_basis, basis_amount,
            commission_rate, commission_amount, rule_id, status,
            calculated_at, created_at
        ) VALUES (
            'comm-pay-' || v_cashbook_id || '-' ||
                floor(extract(epoch from clock_timestamp()) * 1000)::text,
            v_emp_id, to_char(now(), 'YYYY-MM'), v_cashbook_id,
            'payment', 'collected_cash', p_amount, v_comm_rate,
            v_comm_amount, v_rule_id, 'pending', now(), now()
        );
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'cashbook_id', v_cashbook_id,
        'new_debt', v_bal_after,
        'debt_change', v_debt_change
    );
END;
$$;
