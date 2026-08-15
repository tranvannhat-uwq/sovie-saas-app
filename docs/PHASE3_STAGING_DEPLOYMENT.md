# Phase 3 staging deployment

Scope: sales returns, debt/cash refund split, revenue reversal, commission
reversal and return cancellation. No inventory or production processing exists
in this deployment.

## Backup

Use an isolated staging clone and keep credentials outside source control:

```powershell
pg_dump --format=custom --no-owner --no-acl --file phase3-predeploy.dump "$env:STAGING_DATABASE_URL"
pg_dump --schema-only --no-owner --no-acl --file phase3-predeploy-schema.sql "$env:STAGING_DATABASE_URL"
```

Record these checks before migration:

```sql
select 'sales_returns' table_name, count(*) row_count from public.sales_returns
union all select 'sales_return_items', count(*) from public.sales_return_items
union all select 'customer_debt_transactions', count(*) from public.customer_debt_transactions
union all select 'cashbook_transactions', count(*) from public.cashbook_transactions
union all select 'commission_transactions', count(*) from public.commission_transactions;

select status, count(*), sum(coalesce(total_refund, total_return_amount, 0))
from public.sales_returns group by status order by status;
```

Export active legacy return IDs, their item quantities, linked debt-ledger rows,
customer debt/return/revenue aggregates and order statuses for comparison.

## Apply and test

1. Verify `public.schema_migrations` contains 0001 through 0007.
2. Run the complete `migrations/0008_authoritative_sales_returns_and_reversals.sql`.
3. Run `notify pgrst, 'reload schema';`.
4. Run the complete `migrations/tests/phase3_sales_returns_integration.sql`.
   It ends with `ROLLBACK`; every reported test must be true.
5. Deploy the matching frontend to staging only.

Manual role matrix:

- Accounting/Admin: partial return, full return, debt-only return, return with
  cash refund, duplicate-submit retry, cancellation and repeated cancellation.
- Sale: cannot see the create-return action and direct RPC calls are rejected.
- Confirm original order snapshots determine refund values even if DevTools
  changes displayed totals or sends fake refund fields.
- Confirm returned quantities never exceed sold quantities.
- Confirm no stock/production table or local stock cache changes.
- Confirm printing uses the persisted canonical return and remains available
  after reload.

Compare post-test financial aggregates, ledger/cashbook/commission reversal
links and row counts. Do not deploy production from this procedure.

## Recovery

Follow `migrations/ROLLBACK_0008.md`. Preserve every accepted financial row and
prefer a frontend roll-forward. A full database restore is only into a new
staging project.
