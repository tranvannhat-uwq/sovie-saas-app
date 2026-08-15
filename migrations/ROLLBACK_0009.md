# Recovery for migration 0009

Do not delete accepted purchases, supplier payments, debt-ledger rows or
cashbook rows. Financial history must remain auditable.

Preferred recovery on staging:

1. Stop the Phase 4 frontend from creating new supplier transactions.
2. Restore the matching pre-deployment staging backup into a new Supabase
   project, or roll the frontend forward after correcting the migration.
3. Compare supplier opening debt, total purchases, total paid and current debt
   before switching the staging URL.

For a frontend-only rollback, deploy the previous frontend but keep migration
0009 and its tables. Do not re-enable direct writes or legacy localStorage
purchase processing.

If a full database restore is required, restore the pre-0009 custom-format dump
into a new staging project. Never overwrite production in place and never drop
the Phase 4 tables while they contain accepted financial rows.
