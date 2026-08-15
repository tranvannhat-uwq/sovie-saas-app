# Phase 4 implementation report

Status: implemented in source; not deployed to production. The SQL integration
suite must still run on an isolated Supabase staging clone.

## Defects corrected

- Legacy purchases existed only in browser `localStorage`.
- The browser calculated and trusted purchase totals and supplier balance.
- Payment vouchers were manually mirrored into local cashbook data.
- Supplier debt could be edited directly and suppliers could be physically
  deleted or overwritten in bulk.
- Purchase terminology and code implied inventory receiving even though stock
  is outside the final scope.

## New transaction boundary

- The browser sends supplier, invoice metadata and item code/name/unit,
  quantity and unit price only.
- PostgreSQL calculates every line and purchase total, validates initial or
  later payments, and uses idempotency locks.
- Purchase, items, supplier debt ledger, payment voucher, cashbook expense,
  supplier aggregates and audit are committed atomically.
- Cancellation retains original rows and appends debt/cashbook reversals.
- Supplier financial aggregates and Phase 4 tables are read-only to browser
  roles; mutations require reviewed finance-role RPCs.
- Phase 4 contains no inventory or production dependency.

## Files

Created: migration `0009`, Phase 4 SQL/Node tests, authoritative purchase UI,
staging guide, recovery guide and this report.

Updated: migration registry/readme, application state, Supabase service,
supplier management, purchase navigation and goods-panel routing.

## Remaining risk

- All edited JavaScript files pass syntax checks and the repository Node suite
  passes 44/44 tests locally. The local browser loads the new “Phiếu mua hàng”
  navigation without a visible alert or console error.
- SQL integration execution is pending staging access.
- Existing supplier debt is preserved as opening debt; it is not guessed into
  synthetic legacy purchases.
- A purchase cancellation that would make supplier debt negative is blocked
  until later unallocated supplier payments are reviewed.
- Dashboard/report/KPI/payroll remain Phase 5; backup/restore/performance/E2E
  remain Phase 6.
