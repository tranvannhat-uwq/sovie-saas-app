# Restore guidance for migration 0007

Do not delete payments, debt-ledger rows, cashbook entries, cancelled orders or
reversal rows. Those rows are the financial audit trail.

Before staging deployment, take the schema and data backups described in
`docs/PHASE2_STAGING_DEPLOYMENT.md`. If application verification fails, first
roll the frontend back to the Phase 1 build. The new columns and indexes are
additive, so leaving them in place is safer than attempting a destructive SQL
rollback.

To restore the previous API behavior, restore only the affected function and
grant definitions from the pre-0007 schema-only backup:

- `rpc_record_customer_payment`
- `rpc_cancel_customer_payment`
- `rpc_adjust_customer_debt`

The new Phase 2-only RPCs may remain inaccessible after the frontend rollback.
Do not regrant direct writes to financial tables as an emergency workaround.

If any Phase 2 financial operation was accepted, preserve it and its reversal.
For a full restore, load the pre-deployment backup into a new staging project,
compare row counts and financial totals, and switch staging configuration only
after validation. Never restore over production in place.
