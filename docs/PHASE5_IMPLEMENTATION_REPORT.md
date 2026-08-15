# Phase 5 implementation report

## Scope

Implemented server-authoritative dashboard, reports, KPI metrics, rule-based commission transactions and payroll locking. No inventory or production table is read or written by Phase 5.

## Accounting definitions

- Gross sales: `orders.total_payable` for non-draft, non-cancelled orders in the selected period.
- Returns: non-cancelled `sales_returns` in the selected period.
- Net sales: persisted `orders.net_revenue`, already adjusted by the authoritative return flow.
- Collected: completed rows in `payments`.
- Debt issued/collected: order debt and negative customer debt-ledger changes.
- Commission: selected server-side from an active dated rule; the selected rule is snapshotted on the transaction. There is no default percentage.
- Payroll: base salary + commission ledger + KPI/other bonuses - deductions. Return/cancel commission reversals are negative ledger transactions from Phases 2/3.

## Migration

Apply only after 0001-0011:

`migrations/0012_phase5_reporting_kpi_payroll.sql`

The migration is additive. It does not delete legacy rows. It stops if legacy base salaries or commission rules contain unsafe negative/out-of-range values.

## Verification completed

- JavaScript syntax: passed for dashboard, reports, payroll and Supabase service.
- Static/domain suite: 56/56 passed.
- Clean database: migrations 0001-0012 applied successfully to local Supabase PostgreSQL.
- Upgrade database: 0012 applied over 0011 with legacy profile/rule/commission rows preserved.
- Phase 5 SQL integration: 5/5 passed and rolled back (commission snapshot, Sale scope, payroll snapshot, non-admin unlock denial, anon RPC denial).

## Staging deployment

1. Verify the existing `backups/pre-0009` backup files remain non-empty.
2. Run `scripts/apply-migration-0009-secure.ps1` and confirm the connection is staging.
3. The script skips 0009-0011 when already applied, applies 0012, verifies its objects, then runs Phase 1 and Phase 5 rollback-only integration tests.
4. Refresh the website and test Dashboard, Reports/KPI and Payroll as Admin, Accounting and Sale.

Production deployment is intentionally not performed.

## Rollback

Follow `migrations/ROLLBACK_0012.md`. Preserve all payroll and commission records; use the pre-deployment database backup for a full database rollback.
