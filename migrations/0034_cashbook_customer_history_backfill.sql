BEGIN;

-- Reconcile standalone receipt vouchers whose partner text uniquely and
-- exactly identifies one active customer. The whole repair is atomic: link
-- the voucher, create its payment and debt-ledger rows, and correct the
-- customer balance exactly once.
LOCK TABLE public.customers,
  public.cashbook_transactions,
  public.payments,
  public.customer_debt_transactions
IN SHARE ROW EXCLUSIVE MODE;

CREATE TEMP TABLE p34_cashbook_reconciliation ON COMMIT DROP AS
WITH matched_cashbook AS (
  SELECT
    cashbook.id AS cashbook_id,
    match.customer_id,
    round(COALESCE(cashbook.value, 0)) AS amount,
    CASE
      WHEN lower(COALESCE(NULLIF(cashbook.payment_method, ''),
                          NULLIF(cashbook.method, ''), 'cash')) IN ('cash', 'bank', 'wallet')
      THEN lower(COALESCE(NULLIF(cashbook.payment_method, ''),
                          NULLIF(cashbook.method, ''), 'cash'))
      ELSE 'cash'
    END AS payment_method,
    cashbook.category,
    cashbook.note,
    cashbook.created_by,
    COALESCE(cashbook.transaction_date, cashbook.date, now()) AS business_date
  FROM public.cashbook_transactions cashbook
  CROSS JOIN LATERAL (
    SELECT min(customer.id) AS customer_id, count(*) AS match_count
    FROM public.customers customer
    WHERE customer.deleted_at IS NULL
      AND COALESCE(customer.status, 'active') = 'active'
      AND lower(btrim(COALESCE(cashbook.partner, ''))) IN (
        lower(btrim(customer.name)),
        lower(btrim(COALESCE(customer.code, ''))),
        lower(btrim(customer.name || ' - ' || COALESCE(customer.code, ''))),
        lower(btrim(customer.name || ' — ' || COALESCE(customer.code, '')))
      )
  ) match
  WHERE match.match_count = 1
    AND (lower(COALESCE(cashbook.type, '')) = 'thu'
      OR lower(COALESCE(cashbook.direction, '')) = 'in')
    AND round(COALESCE(cashbook.value, 0)) > 0
    AND cashbook.reversal_of_id IS NULL
    AND cashbook.cancelled_at IS NULL
    AND lower(COALESCE(cashbook.status, '')) NOT IN (
      'cancelled', 'canceled', 'đã hủy', 'da huy'
    )
    AND cashbook.customer_id IS NULL
    AND cashbook.order_id IS NULL
    AND cashbook.sales_return_id IS NULL
    AND cashbook.supplier_id IS NULL
    AND cashbook.purchase_id IS NULL
    AND cashbook.purchase_payment_id IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM public.customer_debt_transactions debt
      WHERE debt.cashbook_transaction_id = cashbook.id
    )
), sequenced AS (
  SELECT
    matched.*,
    COALESCE(customer.debt, 0) AS customer_starting_debt,
    COALESCE(sum(matched.amount) OVER (
      PARTITION BY matched.customer_id
      ORDER BY matched.business_date, matched.cashbook_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
    ), 0) AS prior_receipts,
    sum(matched.amount) OVER (
      PARTITION BY matched.customer_id
      ORDER BY matched.business_date, matched.cashbook_id
      ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
    ) AS receipts_through_row
  FROM matched_cashbook matched
  JOIN public.customers customer ON customer.id = matched.customer_id
)
SELECT
  sequenced.*,
  round(sequenced.customer_starting_debt - sequenced.prior_receipts) AS balance_before,
  round(sequenced.customer_starting_debt - sequenced.receipts_through_row) AS balance_after,
  left('reconcile:0034:' || sequenced.cashbook_id, 128) AS reconcile_key,
  md5(jsonb_build_object(
    'cashbookId', sequenced.cashbook_id,
    'customerId', sequenced.customer_id,
    'amount', sequenced.amount
  )::text) AS request_hash
FROM sequenced;

DO $validation$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM p34_cashbook_reconciliation repair
    JOIN public.payments payment
      ON payment.cashbook_transaction_id = repair.cashbook_id
  ) THEN
    RAISE EXCEPTION 'Migration 0034 stopped: a candidate voucher already has a payment row';
  END IF;
END
$validation$;

UPDATE public.cashbook_transactions cashbook
SET transaction_type = 'customer_payment',
    operation_type = 'customer_debt_receipt',
    reference_type = 'customer',
    reference_id = repair.customer_id,
    customer_id = repair.customer_id,
    direction = 'in',
    payment_method = repair.payment_method,
    updated_by = 'migration:0034'
FROM p34_cashbook_reconciliation repair
WHERE cashbook.id = repair.cashbook_id;

INSERT INTO public.payments(
  id, customer_id, amount, payment_method, status,
  cashbook_transaction_id, idempotency_key, request_fingerprint,
  created_by, created_at
)
SELECT
  'PAY-RECON-0034-' || repair.cashbook_id,
  repair.customer_id,
  repair.amount,
  repair.payment_method,
  'completed',
  repair.cashbook_id,
  repair.reconcile_key,
  repair.request_hash,
  COALESCE(repair.created_by, 'migration:0034'),
  now()
FROM p34_cashbook_reconciliation repair
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.customer_debt_transactions(
  id, customer_id, transaction_type, amount, debt_change,
  balance_before, balance_after, cashbook_transaction_id,
  description, idempotency_key, created_by, transaction_date
)
SELECT
  'DTX-RECON-0034-' || repair.cashbook_id,
  repair.customer_id,
  'payment',
  repair.amount,
  -repair.amount,
  repair.balance_before,
  repair.balance_after,
  repair.cashbook_id,
  concat_ws(' - ',
    'Đối soát phiếu thu ' || repair.cashbook_id,
    NULLIF(btrim(COALESCE(repair.category, '')), ''),
    NULLIF(btrim(COALESCE(repair.note, '')), '')
  ),
  repair.reconcile_key,
  COALESCE(repair.created_by, 'migration:0034'),
  repair.business_date
FROM p34_cashbook_reconciliation repair
ON CONFLICT (id) DO NOTHING;

UPDATE public.customers customer
SET debt = round(COALESCE(customer.debt, 0) - totals.receipt_total),
    last_payment_at = GREATEST(
      COALESCE(customer.last_payment_at, '-infinity'::timestamptz),
      totals.last_business_date
    ),
    updated_at = now(),
    updated_by = 'migration:0034'
FROM (
  SELECT customer_id, sum(amount) AS receipt_total,
         max(business_date) AS last_business_date
  FROM p34_cashbook_reconciliation
  GROUP BY customer_id
) totals
WHERE customer.id = totals.customer_id;

INSERT INTO public.audit_logs(
  table_name, action, record_id, new_data, performed_by, created_at
)
SELECT
  'customer_debt_transactions',
  'RECONCILE_CASHBOOK_CUSTOMER_HISTORY',
  'migration:0034',
  jsonb_build_object(
    'reconciled_count', count(*),
    'reconciled_amount', COALESCE(sum(repair.amount), 0),
    'affected_customers', count(DISTINCT repair.customer_id),
    'rows', COALESCE(jsonb_agg(jsonb_build_object(
      'cashbook_id', repair.cashbook_id,
      'customer_id', repair.customer_id,
      'amount', repair.amount,
      'balance_before', repair.balance_before,
      'balance_after', repair.balance_after
    ) ORDER BY repair.business_date, repair.cashbook_id), '[]'::jsonb)
  ),
  'migration:0034',
  now()
FROM p34_cashbook_reconciliation repair
HAVING count(*) > 0;

INSERT INTO public.schema_migrations(version, description)
VALUES ('0034', 'Reconcile exact customer cashbook receipts and correct debt history')
ON CONFLICT (version) DO NOTHING;

COMMIT;
