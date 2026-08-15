BEGIN;

CREATE INDEX IF NOT EXISTS idx_cashbook_effective_date
  ON public.cashbook_transactions ((COALESCE(date, transaction_date)) DESC);

CREATE OR REPLACE FUNCTION public.rpc_get_cashbook_window(
  p_start timestamptz,
  p_end_exclusive timestamptz
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
DECLARE
  window_rows jsonb;
  opening_cash numeric := 0;
  opening_bank numeric := 0;
  opening_wallet numeric := 0;
BEGIN
  PERFORM public.require_authenticated_profile();
  IF p_start IS NULL OR p_end_exclusive IS NULL OR p_start >= p_end_exclusive THEN
    RAISE EXCEPTION 'A valid cashbook date window is required';
  END IF;

  SELECT COALESCE(jsonb_agg(to_jsonb(entry_page)), '[]'::jsonb)
  INTO window_rows
  FROM (
    SELECT entry.*
    FROM public.cashbook_transactions entry
    WHERE COALESCE(entry.date, entry.transaction_date) >= p_start
      AND COALESCE(entry.date, entry.transaction_date) < p_end_exclusive
    ORDER BY COALESCE(entry.date, entry.transaction_date) DESC, entry.id DESC
  ) entry_page;

  WITH effective_before AS (
    SELECT
      lower(COALESCE(NULLIF(entry.method, ''), NULLIF(entry.payment_method, ''), 'cash')) account_method,
      CASE
        WHEN lower(COALESCE(entry.type, '')) = 'thu' OR lower(COALESCE(entry.direction, '')) = 'in'
          THEN COALESCE(entry.value, 0)
        WHEN lower(COALESCE(entry.type, '')) = 'chi' OR lower(COALESCE(entry.direction, '')) = 'out'
          THEN -COALESCE(entry.value, 0)
        ELSE 0
      END signed_value
    FROM public.cashbook_transactions entry
    WHERE COALESCE(entry.date, entry.transaction_date) < p_start
      AND entry.reversal_of_id IS NULL
      AND lower(COALESCE(entry.transaction_type, '')) NOT LIKE '%reversal%'
      AND lower(COALESCE(entry.id, '')) NOT LIKE 'void-%'
      AND lower(COALESCE(entry.status, '')) NOT LIKE '%cancel%'
      AND lower(COALESCE(entry.status, '')) NOT LIKE '%hủy%'
      AND lower(COALESCE(entry.status, '')) NOT LIKE '%huy%'
      AND (
        lower(COALESCE(NULLIF(entry.status, ''), 'đã thanh toán')) IN ('completed', 'paid')
        OR lower(COALESCE(NULLIF(entry.status, ''), 'đã thanh toán')) LIKE '%thanh%'
      )
  )
  SELECT
    COALESCE(sum(signed_value) FILTER (WHERE account_method = 'cash'), 0),
    COALESCE(sum(signed_value) FILTER (WHERE account_method = 'bank'), 0),
    COALESCE(sum(signed_value) FILTER (WHERE account_method = 'wallet'), 0)
  INTO opening_cash, opening_bank, opening_wallet
  FROM effective_before;

  RETURN jsonb_build_object(
    'data', window_rows,
    'opening_net_by_method', jsonb_build_object(
      'cash', opening_cash,
      'bank', opening_bank,
      'wallet', opening_wallet
    ),
    'start', p_start,
    'end_exclusive', p_end_exclusive
  );
END;
$$;

REVOKE ALL ON FUNCTION public.rpc_get_cashbook_window(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.rpc_get_cashbook_window(timestamptz, timestamptz) TO authenticated;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0051', 'Load cashbook date windows with authoritative opening aggregates')
ON CONFLICT (version) DO NOTHING;

COMMIT;
