# Phase 3 implementation report

Status: implemented in source and locally verified; not deployed to production.
The transactional SQL suite must still run on an isolated Supabase staging clone.

## Actual defects found

- The legacy RPC trusted return total, refund prices, subtotals and status sent
  by the browser.
- Returned quantity validation was split between browser state and incomplete
  database aggregates.
- A return could reduce customer debt below zero instead of splitting excess
  into an actual refund payment.
- Order-item returned quantity/amount and order returned revenue were not updated
  consistently.
- Cancellation changed statuses and debt but did not reverse cash refunds,
  commission, canonical item aggregates and audit links as one transaction.
- The frontend added stock when creating a return and subtracted it when
  cancelling a return, contrary to final project scope.
- A legacy direct-upsert helper could bypass the reviewed return RPC.

## New architecture

- The frontend sends only order ID, return reason, refund method, idempotency key,
  and each original order-item ID with quantity.
- Database locks the order/items and calculates the refundable value from the
  immutable order snapshot. Fake frontend totals, prices and statuses are ignored.
- The database includes active legacy return quantities when validating remaining
  quantities, without deleting or rewriting legacy return rows.
- Return value first reduces outstanding debt, never below zero. Any excess creates
  a linked cashbook refund using cash/bank/wallet.
- Customer return/revenue aggregates, order/order-item aggregates, debt ledger,
  cashbook refund, proportional commission reversal and audit are committed in
  one transaction.
- Cancellation preserves the return, appends debt/cashbook/commission reversals,
  recalculates order/item status and records actor/reason from the database.
- Direct writes and the old return RPC signatures are revoked.
- Return creation and cancellation contain no stock or production calls.

## Files

Created:

- `migrations/0008_authoritative_sales_returns_and_reversals.sql`
- `migrations/tests/phase3_sales_returns_integration.sql`
- `tests/phase3-sales-return-authority.test.mjs`
- `docs/PHASE3_STAGING_DEPLOYMENT.md`
- `migrations/ROLLBACK_0008.md`
- `docs/PHASE3_IMPLEMENTATION_REPORT.md`

Updated:

- `migrations/README.md`
- `migrations/tests/p0_security_integration.sql`
- `tests/p0-migrations.test.mjs`
- `index.html`
- `js/components/history.js`
- `js/services/supabase.js`

## Verification and remaining risk

- Both edited JavaScript files pass `node --check`; the repository Node suite
  passes 36/36 tests locally.
- The local browser at `http://127.0.0.1:8080/` loads the application entrypoint
  and the new return modal with cash/bank/wallet refund choices and no visible
  startup alert.
- The SQL suite covers canonical calculations, tampering, idempotency conflicts,
  over-return rejection, partial/full returns, debt/cash split, actor stamping,
  Sale/anon rejection, direct-write revocation and full cancellation reversals.
- SQL execution remains pending because this workspace has no isolated Supabase
  runtime or staging connection.
- Legacy returns missing their debt-ledger row are intentionally blocked from
  cancellation for manual review; guessing would corrupt debt.
- Orders with active legacy return lines that cannot be linked to an original
  order-item ID are blocked from another return until manually reconciled.
- Supplier debt remains Phase 4. Dashboard/report/KPI/payroll calculations remain
  Phase 5. Backup/restore and bulk synchronization remain Phase 6.
