# Phase 1 staging deployment

Do not run this procedure on production.

## 1. Backup staging

Create a Supabase dashboard backup/snapshot first. Also take a logical backup
from a trusted workstation; keep the connection string outside source control:

```powershell
$env:PHASE1_STAGING_DATABASE_URL = '<staging pooler/direct connection string>'
pg_dump --format=custom --no-owner --no-acl --file phase1-before-0006.dump $env:PHASE1_STAGING_DATABASE_URL
pg_dump --schema-only --no-owner --no-acl --file phase1-before-0006-schema.sql $env:PHASE1_STAGING_DATABASE_URL
```

Record row counts for `products`, `product_groups`, `pricelists`,
`price_list_items`, `customers`, `orders`, `order_items`, `draft_orders` and
`customer_debt_transactions` before migration.

## 2. Apply database before frontend

Confirm migrations `0001` through `0005` exist in `public.schema_migrations`,
then run `migrations/0006_authoritative_order_pricing_and_idempotency.sql` once
in the staging SQL editor. The file contains its own transaction; do not add
psql commands such as `\pset` to the SQL editor.

Refresh PostgREST after success:

```sql
NOTIFY pgrst, 'reload schema';
SELECT version, description, applied_at
FROM public.schema_migrations
ORDER BY version;
```

## 3. Verify

Run `migrations/tests/phase1_order_pricing_integration.sql`. It creates isolated
fixtures inside a transaction and ends with `ROLLBACK`; every displayed row
must have `passed = true`.

Then deploy the frontend to staging and smoke-test:

1. Admin/accounting create an order with a deliberately changed browser total;
   the saved/printed total must match the database price.
2. Retry the same request; only one order and one debt-ledger row may exist.
3. Sale creates an order for an assigned customer using a sale-enabled list.
4. Sale forcing a dealer-private price-list ID must receive a 403 response.
5. Inactive or unpriced SKU must be rejected.
6. Print immediately after finalization; no history-page round trip is required.
7. Anonymous login screen must produce no business-table requests.

## 4. Recovery

Use `migrations/ROLLBACK_0006.md`. Prefer rolling back the frontend first and
restoring the old RPC from the schema backup. Never delete orders created by
0006. If a full restore is necessary, restore the dump into a new staging
database, verify counts, and switch staging only after comparison.
