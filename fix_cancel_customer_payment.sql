-- Atomically cancel a customer receipt without deleting accounting history.
CREATE OR REPLACE FUNCTION public.rpc_cancel_customer_payment(
    p_cashbook_id text,
    p_created_by text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_customer_id text;
    v_cashbook_status text;
    v_payment_amount numeric;
    v_original_change numeric;
    v_balance_before numeric;
    v_balance_after numeric;
    v_reversal_id text;
BEGIN
    IF p_cashbook_id IS NULL OR p_cashbook_id = '' THEN
        RAISE EXCEPTION 'Cashbook transaction ID cannot be null';
    END IF;

    SELECT customer_id, status, COALESCE(value, 0)
    INTO STRICT v_customer_id, v_cashbook_status, v_payment_amount
    FROM public.cashbook_transactions
    WHERE id = p_cashbook_id
    FOR UPDATE;

    IF v_customer_id IS NULL OR v_customer_id = '' THEN
        RAISE EXCEPTION 'Receipt % is not linked to a customer', p_cashbook_id;
    END IF;

    SELECT debt_change
    INTO STRICT v_original_change
    FROM public.customer_debt_transactions
    WHERE cashbook_transaction_id = p_cashbook_id
      AND transaction_type = 'payment'
    ORDER BY transaction_date
    LIMIT 1;

    SELECT COALESCE(debt, 0)
    INTO STRICT v_balance_before
    FROM public.customers
    WHERE id = v_customer_id
    FOR UPDATE;

    v_reversal_id := 'dtx-void-' || p_cashbook_id;

    IF v_cashbook_status IN ('Đã hủy', 'cancelled', 'canceled')
       OR EXISTS (
           SELECT 1
           FROM public.customer_debt_transactions
           WHERE id = v_reversal_id
       ) THEN
        RETURN jsonb_build_object(
            'success', true,
            'already_cancelled', true,
            'customer_id', v_customer_id,
            'new_debt', v_balance_before
        );
    END IF;

    v_balance_after := v_balance_before - v_original_change;

    INSERT INTO public.customer_debt_transactions (
        id, customer_id, transaction_type, amount, debt_change,
        balance_before, balance_after, cashbook_transaction_id,
        description, created_by, transaction_date
    ) VALUES (
        v_reversal_id, v_customer_id, 'adjust', v_payment_amount,
        -v_original_change, v_balance_before, v_balance_after,
        p_cashbook_id, 'Hủy phiếu thu ' || p_cashbook_id,
        COALESCE(NULLIF(p_created_by, ''), 'admin'), now()
    );

    UPDATE public.customers
    SET debt = v_balance_after,
        updated_at = now()
    WHERE id = v_customer_id;

    UPDATE public.cashbook_transactions
    SET status = 'Đã hủy'
    WHERE id = p_cashbook_id;

    UPDATE public.commission_transactions
    SET status = 'cancelled'
    WHERE cashbook_transaction_id = p_cashbook_id;

    RETURN jsonb_build_object(
        'success', true,
        'customer_id', v_customer_id,
        'new_debt', v_balance_after,
        'debt_change', -v_original_change
    );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_cancel_customer_payment(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rpc_cancel_customer_payment(text, text) TO anon, authenticated;
