# Phase 4 staging deployment

Scope: suppliers, purchases, supplier debt, supplier payments and payment
vouchers. No inventory or production processing is included.

## Backup

Use an isolated staging clone:

```powershell
pg_dump --format=custom --no-owner --no-acl --file phase4-predeploy.dump "$env:STAGING_DATABASE_URL"
pg_dump --schema-only --no-owner --no-acl --file phase4-predeploy-schema.sql "$env:STAGING_DATABASE_URL"
```

Record existing supplier balances before migration:

```sql
select id, code, name, debt from public.suppliers order by id;
select count(*) supplier_count, sum(coalesce(debt, 0)) total_supplier_debt
from public.suppliers;
```

## Apply and test

1. Verify `public.schema_migrations` contains `0001` through `0008`.
2. Run `migrations/0009_supplier_purchases_debt_and_payments.sql` completely.
3. Run `notify pgrst, 'reload schema';`.
4. Run `migrations/tests/phase4_supplier_purchases_integration.sql` completely.
   It ends with `ROLLBACK`; every reported test must be true.
5. Deploy the matching frontend to staging only.

Manual checks:

- Accounting/Admin create a purchase with zero, partial and full payment.
- Database totals match quantity × unit price even when DevTools sends fake
  totals, balance or actor fields.
- Additional supplier payment creates one linked payment voucher, ledger entry
  and cashbook expense; retry does not duplicate it.
- Cancelling a payment and purchase preserves original rows and appends all
  reversals.
- Sale cannot open the module, read supplier finance tables or call RPCs.
- No inventory/production table or browser cache changes.
- Purchase printing uses the persisted canonical purchase after reload.

Do not deploy production from this procedure. Recovery instructions are in
`migrations/ROLLBACK_0009.md`.
