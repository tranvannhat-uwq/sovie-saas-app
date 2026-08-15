# Phase 2 implementation report

Status: implemented in source and verified locally; not deployed to production.
The transactional SQL integration suite still must run on an isolated Supabase
staging clone after migration 0007 is applied.

## Problems found and corrected

- Customer collections had no stable idempotency key and could be duplicated.
- Debt, cashbook, payments, opening balances and finalized orders still exposed
  direct browser write paths.
- Customer edits could overwrite debt/financial aggregates without a ledger row.
- Receipt cancellation changed status but did not preserve a complete reversal
  relationship across payment, cashbook and debt ledger.
- Finalized orders had no reviewed cancellation transaction.
- The cashbook opening balance was written to localStorage before Cloud accepted it.
- The order-cancel button listener was attached inside the return workflow instead
  of the order-history render workflow.
- The legacy local-to-cloud sync attempted to replay finalized orders and financial
  browser cache into authoritative database tables.

## Implemented design

- `customer_debt_transactions` is append-only for API roles. Collections,
  cancellation and adjustments append ledger rows and update the aggregate debt
  in the same database transaction.
- Collections and manual cashbook entries require stable idempotency keys and use
  a transaction advisory lock to serialize retries.
- The database derives the actor from `auth.uid()` through the active profile.
  Only `admin` and `accounting` pass the finance RPC checks.
- Direct writes to payments, debt ledger, cashbook, opening balances and finalized
  order tables are revoked from `authenticated`.
- Direct changes to customer debt, revenue aggregates and financial timestamps are
  rejected by a trigger.
- Cancellation preserves original rows, marks them cancelled, adds linked reversal
  rows and writes an audit event. No financial row is physically deleted.
- Order cancellation reverses the order debt charge, customer revenue aggregates
  and existing commission rows. It refuses orders with active returns, linked
  completed payments, unallocated later receipts or inconsistent aggregates.
- Frontend cache changes happen only after the authoritative RPC succeeds.
- Legacy sync now synchronizes master data and drafts only; it does not replay
  finalized orders, cashbook or opening balances from localStorage.

## Files

Created:

- `migrations/0007_payments_debt_cashbook_and_order_reversals.sql`
- `migrations/tests/phase2_financial_reversals_integration.sql`
- `tests/phase2-financial-integrity.test.mjs`
- `docs/PHASE2_STAGING_DEPLOYMENT.md`
- `migrations/ROLLBACK_0007.md`
- `docs/PHASE2_IMPLEMENTATION_REPORT.md`

Updated:

- `migrations/README.md`
- `migrations/tests/p0_security_integration.sql`
- `tests/p0-migrations.test.mjs`
- `js/services/supabase.js`
- `js/components/customers.js`
- `js/components/so_quy.js`
- `js/components/history.js`

## Verification performed

- JavaScript syntax checks: passed for all modified frontend modules.
- Node test suite: 28 passed, 0 failed.
- Local browser at `http://127.0.0.1:8080/`: document reached `complete`, login form
  rendered, and the current module entrypoint was present after reload.
- SQL staging suite is written with transactional fixtures and final `ROLLBACK`.
  It covers Accounting/Admin success, Sale rejection, anon execute revocation,
  collection idempotency and overpayment rejection, receipt/cashbook reversals,
  opening balances, order cancellation, actor stamping, and direct-write blocking.
- SQL integration execution: not performed because no isolated staging database or
  local Supabase runtime is available in this workspace.

## Deployment order

1. Follow `docs/PHASE2_STAGING_DEPLOYMENT.md` and create both data and schema backups.
2. Verify migrations 0001 through 0006 exist in `public.schema_migrations`.
3. Run the complete `migrations/0007_payments_debt_cashbook_and_order_reversals.sql`.
4. Run `notify pgrst, 'reload schema';`.
5. Run the complete `migrations/tests/phase2_financial_reversals_integration.sql`.
6. Deploy the frontend to staging only and execute the manual role matrix.
7. Compare financial counts/totals. Do not deploy production in this phase.

## Remaining scope and risks

- Phase 3 must replace the existing return flow, remove its stock coupling, and
  implement debt/revenue/commission reversals for returns.
- Supplier purchase, supplier debt and payment vouchers remain Phase 4.
- Dashboard, KPI, payroll and commission calculation remain Phase 5.
- Backup/restore, safe bulk financial import and synchronization remain Phase 6.
  Migration 0007 intentionally rejects legacy imports that try to overwrite
  protected financial aggregates directly.
- The order-cancel RPC is intentionally conservative when receipts are not allocated
  to a specific order; operators must cancel those receipts first.
- Staging SQL results are still required before this phase can be called deployable.
