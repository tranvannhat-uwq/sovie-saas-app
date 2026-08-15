# Restore guidance for migration 0008

Do not delete sales returns, return items, debt-ledger rows, cashbook refunds,
commission reversals or audit rows. They are one financial audit chain.

Before applying 0008 on staging, take the backups described in
`docs/PHASE3_STAGING_DEPLOYMENT.md`. If frontend verification fails before any
Phase 3 return is accepted, roll the frontend back and restore only the old
return RPC definitions/grants from the schema-only backup.

If any Phase 3 return or cancellation has been accepted, do not restore the old
RPC implementation: it does not understand the new debt/cash split and reversal
links. Keep migration 0008 and fix/roll forward the frontend instead. The added
columns, indexes and sequence are additive and should remain.

For a full restore, restore the pre-0008 dump into a new staging project, compare
row counts and financial totals, then switch staging configuration. Never restore
over production in place and never regrant direct writes to return tables.
