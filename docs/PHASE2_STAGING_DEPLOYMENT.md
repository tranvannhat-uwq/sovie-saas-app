# Phase 2 staging deployment

Scope: customer collection, customer debt, cashbook, starting balances and
order/receipt cancellation by reversal. This procedure does not deploy to
production and does not include returns, supplier debt, inventory or production.

## 1. Backup the staging clone

Use the direct database connection string stored outside source control:

```powershell
pg_dump --format=custom --no-owner --no-acl --file phase2-predeploy.dump "$env:STAGING_DATABASE_URL"
pg_dump --schema-only --no-owner --no-acl --file phase2-predeploy-schema.sql "$env:STAGING_DATABASE_URL"
```

Record counts before migration:

```sql
select 'customers' as table_name, count(*) from public.customers
union all select 'orders', count(*) from public.orders
union all select 'payments', count(*) from public.payments
union all select 'customer_debt_transactions', count(*) from public.customer_debt_transactions
union all select 'cashbook_transactions', count(*) from public.cashbook_transactions;
```

Also export customers with non-zero debt and totals grouped by payment/cashbook
status. Keep the backup encrypted and restrict access to the deploy operator.

## 2. Apply in order

Confirm `public.schema_migrations` contains `0001` through `0006`. In the
Supabase staging SQL editor, run the complete file
`migrations/0007_payments_debt_cashbook_and_order_reversals.sql`. Do not run
isolated fragments and do not rerun legacy root-level SQL files.

Then refresh PostgREST's schema cache:

```sql
notify pgrst, 'reload schema';
```

Verify:

```sql
select version, applied_at from public.schema_migrations order by version;
select has_table_privilege('authenticated', 'public.customer_debt_transactions', 'UPDATE') as ledger_update_allowed,
       has_table_privilege('authenticated', 'public.cashbook_transactions', 'INSERT') as cashbook_insert_allowed;
```

Both privilege results must be `false`.

## 3. Test before publishing the frontend

Run the complete `migrations/tests/phase2_financial_reversals_integration.sql`
on the isolated staging database. It uses a transaction and ends with
`ROLLBACK`; every reported test must be `true`.

Publish the Phase 2 frontend to staging only. Verify with Admin and Accounting:

1. collect a partial debt payment, retry the same request, and confirm one row;
2. cancel that receipt and confirm debt returns to the prior balance;
3. add and cancel a manual cashbook entry;
4. change a starting balance;
5. cancel an unpaid settled test order without returns;
6. confirm a Sale account cannot perform any of those mutations.

Compare post-test row counts and financial totals with the expected test
transactions. Do not publish to production from this procedure.

## 4. Recovery

Follow `migrations/ROLLBACK_0007.md`. Prefer rolling back the frontend while
preserving additive schema and all accepted financial/audit rows. Restore the
dump only into a new staging database and validate before switching connection
settings.
