# P0 database migrations

This directory is the only ordered migration source after the legacy SQL files
in the repository. The legacy files remain unchanged because some of them may
already have been applied to an existing database.

Run these files in order on a staging clone first:

1. `0001_core_schema_and_migration_registry.sql`
2. `0002_auth_profiles_and_rls.sql`
3. `0003_secure_rpc_boundary.sql`
4. `0004_lock_down_legacy_objects.sql`
5. `0005_profile_identity_integrity.sql`
6. `0006_authoritative_order_pricing_and_idempotency.sql`
7. `0007_payments_debt_cashbook_and_order_reversals.sql`
8. `0008_authoritative_sales_returns_and_reversals.sql`
9. `0009_supplier_purchases_debt_and_payments.sql`
10. `0010_supplier_updated_at_compatibility.sql`
11. `0011_confirm_order_variable_conflict_fix.sql`
12. `0012_phase5_reporting_kpi_payroll.sql`
13. `0013_legacy_cashbook_customer_and_order_compatibility.sql`
14. `0014_sales_return_variable_conflict_fix.sql`
15. `0015_customer_opening_financial_import.sql`
16. `0016_customer_import_rpc_variable_conflict_fix.sql`
17. `0017_privileged_order_business_date.sql`
18. `0018_quick_customer_creation_rpc.sql`
19. `0019_order_amendment_and_customer_advance.sql`
20. `0020_customer_debt_adjustment_credit.sql`
21. `0021_enable_scoped_realtime.sql`
22. `0022_dot_color_surcharge.sql`
23. `0023_authoritative_color_surcharges.sql`
24. `0024_sale_managed_customer_debt_history.sql`
25. `0025_global_price_list_order_override.sql`
26. `0026_sale_managed_customer_order_history.sql`
27. `0027_market_price_lists_are_print_only.sql`
28. `0028_tt_20072026_requires_accounting_approval.sql`
29. `0029_order_notes_annotation.sql`
30. `0030_cashbook_manual_transaction_edit.sql`
31. `0031_customer_pricelist_priority_alignment.sql`
32. `0032_reconcile_legacy_customer_receipts.sql`
33. `0033_dashboard_revenue_attribution.sql`
34. `0034_cashbook_customer_history_backfill.sql`
35. `0035_deterministic_sku_price_fallback.sql`
36. `0036_activity_log.sql`
37. `0037_draft_order_activity.sql`
38. `0038_activity_history_bridge.sql`
39. `0039_admin_maintenance_mode.sql`
40. `0040_customer_assigned_price_list_exception.sql`
41. `0041_customer_assigned_pricing_rpc.sql`
42. `0042_order_business_date_clock_skew.sql`
43. `0043_sale_pricing_snapshot_rpc.sql`
44. `0044_cashbook_voucher_amendment.sql`
45. `0045_cashbook_amendment_lineage.sql`
46. `0046_non_sales_customer_receipt_history.sql`
47. `0047_brand_invoice_print_settings.sql`
48. `0048_privileged_manual_order_pricing.sql`
49. `0049_initialize_manual_price_record.sql`
50. `0050_cancel_amended_customer_receipt.sql`
51. `0051_cashbook_window_egress.sql`
52. `0052_short_compact_audit_retention.sql`
53. `0053_customer_assigned_price_list_trigger_repair.sql`
54. `0054_quick_customer_manager_identity.sql`
55. `0055_sales_return_deduction_percent.sql`

Every file is additive and records its version in `public.schema_migrations`.
Apply each version once; the migration table is the source of truth for the
next pending file. None of the P0 migrations deletes business rows.

The clean-database target is a clean **Supabase** project (the chain depends on
`auth.users` and `auth.uid()`), not generic PostgreSQL. Migration `0001` stops
without changing data if a legacy `wl_*` deployment is detected: no authoritative
`wl_*` production schema exists in this repository, so mapping it would require
an exported schema rather than a guess.

The canonical pre-P0 business implementations were identified as:

- `fix_customer_debt_ledger.sql`: order confirmation, receipt, sales return,
  and return cancellation.
- `fix_cancel_customer_payment.sql`: receipt cancellation.
- `update_supabase_schema.sql`: debt adjustment and paginated read RPCs. The
  legacy file is syntactically incomplete at its debt-adjustment function and
  must not be executed again.

The reviewed public RPC signatures are defined once by `0003`/`0004`. Legacy
overloads remain physically present on an upgraded database only to avoid a
destructive drop, but `0004` removes `EXECUTE` from `PUBLIC`, `anon`, and
`authenticated`; it then grants only the reviewed signatures back to
`authenticated`.

From this point onward, do not run a legacy root-level SQL file after the P0
migrations. Doing so can recreate permissive policies or overwrite a secured
RPC. Follow `docs/P0_BACKUP_AND_STAGING.md` for backup, verification, rollout,
and restore instructions.

Migration `0006` is Phase 1 of the final business scope. It makes the database
authoritative for active SKU validation, allowed price-list selection, price
inheritance, monetary calculations, immutable order snapshots and idempotent
finalization. It does not call inventory or production objects. Run
`migrations/tests/phase1_order_pricing_integration.sql` on staging after it.

Migration `0007` is Phase 2. It makes customer collections and manual cashbook
entries idempotent, protects the customer debt ledger as append-only, moves
starting-balance changes behind a reviewed RPC, and cancels receipts/orders by
recording compensating transactions. It does not call inventory, production,
sales-return or supplier-purchase logic. Run
`migrations/tests/phase2_financial_reversals_integration.sql` on staging after it.

Migration `0008` is Phase 3. It validates returned quantities against immutable
order-item snapshots, calculates refund values in the database, separates debt
reduction from actual cash refund, updates order/customer revenue, and appends
commission/debt/cashbook reversals. It has no inventory or production coupling.
Run `migrations/tests/phase3_sales_returns_integration.sql` on staging after it.

Migration `0009` is Phase 4. It creates authoritative supplier purchases,
purchase items, supplier payments and an append-only supplier debt ledger. The
database calculates purchase totals, writes linked payment vouchers/cashbook
entries, and cancels purchases or payments with compensating transactions. It
does not read or update inventory/production objects. Run
`migrations/tests/phase4_supplier_purchases_integration.sql` on staging after it.

Migration `0010` is the additive compatibility repair for legacy supplier
tables that have `created_at` but not `updated_at`. Migration `0009` is kept
immutable after deployment; `0010` adds the timestamp required by its supplier
RPCs without rewriting business rows. Run the Phase 4 integration suite again
after applying it.

Migration `0011` recompiles the Phase 1 order-confirmation RPC with explicit
PL/pgSQL variable precedence. It fixes legacy column/local-variable name
collisions such as `idempotency_key` without changing pricing, debt, inventory,
production or order data. Run the Phase 1 integration suite after applying it.

Migration `0013` adds strong-link metadata for historical cashbook rows and a
single transactional cancellation RPC that classifies receipts/payments before
reversing customer or supplier debt. It also permits paid-order cancellation to
turn preserved receipts into customer credit instead of deleting money or
forcing debt to zero. The old cancellation RPC signatures remain as wrappers.
It has no inventory or production dependency. Run
`migrations/tests/phase6_legacy_compatibility_integration.sql` after applying it.

Migration `0015` adds an Admin/Accounting-only RPC for importing legacy
customer financial baselines. Re-importing replaces the previous imported
contribution instead of adding it again, while totals produced later by orders,
returns and payments remain intact. Direct API writes to both operational totals
and imported baseline columns stay blocked.

Migration `0016` fixes the `customer_id is ambiguous` error for databases that
already ran the first revision of `0015`. It changes only PL/pgSQL identifier
resolution, reasserts the RPC security settings and leaves all imported totals,
ledgers and formulas unchanged.

Migration `0017` lets Admin/Accounting preserve the actual business day for
orders entered after a weekend or holiday. The chosen date drives order history,
debt-ledger timing and reporting, while confirmation/audit timestamps retain the
real posting time. Sale-role payload dates are ignored and future dates are rejected.

Migration `0018` adds a narrow authenticated RPC for creating a customer from
the invoice screen. Admin/Accounting may choose an active manager; Sale users
are forcibly assigned as the new customer's manager. Financial balances remain
server-owned, direct customer-table insert policies are not widened, and every
quick creation is audited.

Migration `0054` normalizes the manager stored by that RPC to the profile
username used by customer screens and filters. It also repairs only previously
quick-created customers whose manager still equals the same profile's Auth UUID;
customers created by other workflows are left unchanged.

Migration `0019` lets Admin/Accounting amend a settled order by atomically
cancelling the immutable original and confirming a replacement. Orders with
active returns remain locked. It also adds customer receipts that may create a
negative customer balance (advance credit) for later orders to consume.

Migration `0020` exposes the existing audited customer-debt correction workflow
in a way that supports the signed balance convention from `0019`. Admin and
Accounting may set either a receivable or advance-credit balance, but every
change still requires a reason and appends both debt-ledger and audit records.

Migration `0032` repairs a legacy receipt that was saved only as a manual
cashbook row. Admin/Accounting explicitly selects the voucher and its uniquely
matched customer; the RPC atomically adds the missing payment and debt-ledger
rows, updates the balance, audits the repair and is safe to retry.

Migration `0021` registers the active order, customer, cashbook and catalog tables
with Supabase Realtime. It changes publication metadata only, preserves every
business row and continues to rely on the existing RLS policies for event access.

Migration `0026` lets a Sale read finalized order history for a dealer already
inside that Sale's managed or assigned customer scope. It keeps price-list
authorization, draft ownership, finalized-order immutability and all mutation
permissions unchanged.

Migration `0027` marks restricted market and `TT 20/07/2026` price lists as
print-only. It blocks inserts into finalized and draft orders when either the
order or an item references such a list, preventing revenue and customer-debt
effects while leaving invoice preview and printing available.

Migration `0028` also marks the existing `TT 20/07/2026` list as print-only.
Accounting (or Admin) can explicitly enable order saving from the price-list
editor; this permission is independent from the existing Sale visibility toggle.

Migration `0029` adds an Admin/Accounting-only RPC for editing an order's note
as an audited annotation. It updates only `orders.notes` plus audit metadata and
does not cancel, replace or recalculate the order; customer debt, payments,
returns, cashbook and commission ledgers remain untouched.

Migration `0030` adds an Admin/Accounting-only audited RPC for editing standalone
manual cashbook vouchers. It rejects cancelled entries and every voucher linked
to customer debt, orders, returns, supplier purchases or reversal records, so
those financial workflows remain immutable and continue to use cancellation.

Migration `0031` aligns authoritative order pricing with the price list selected
in the customer editor. It gives `customers.pricelist_id` priority over the
duplicated compatibility field while preserving active-date checks, role-based
price-list authorization, database price lookup and browser-price rejection.

Migration `0033` corrects dashboard attribution without changing orders or
financial ledgers. Company revenue is grouped from each order item's paint-brand
company, while employee revenue and employee filtering use the salesperson who
manages the customer instead of the user who entered or finalized the order.

Migration `0034` reconciles standalone receipt vouchers whose partner uniquely
and exactly matches one active customer. It atomically links each voucher,
creates the missing payment and debt-ledger rows, reduces customer debt, and
records an audit summary. Orders and revenue are unchanged, and retries cannot
create duplicate payment or ledger rows.

Migration `0035` makes SKU price inheritance deterministic. Global/general
price lists remain independent business levels; private, group and sales lists
follow their explicit parent and then the canonical `Bảng giá chung` fallback.
It changes no stored price, product, order or customer row.

Migration `0036` adds a separate append-only, authenticated Activity Log. It
groups field changes per transaction and target, records the actor only from
`auth.uid()`, exposes paginated/filterable read RPCs, and adds no inventory,
warehouse, stock or production modules. Existing `audit_logs` and business data
are preserved unchanged.

Migration `0037` adds the missing draft-order Activity Log trigger and a narrow
RPC that updates notes in `draft_orders` instead of querying finalized orders.
It also lets authorized users read the activity timeline of their accessible
drafts without changing order totals, prices, debt or existing rows.

Migration `0038` makes the pre-existing, profile-attributed `audit_logs` history
visible in the new Activity Log read model. It deduplicates same-save legacy
rows, ignores unattributed/system activity, and never changes business rows or
the original audit trail.

Migration `0039` adds an Admin-only maintenance switch. While enabled, other
roles are blocked from the application without changing their business data or
permissions after maintenance is turned off.

Migration `0040` lets a Sale use a price list disabled for general sales only
when that exact list was already saved on an active customer inside the Sale's
customer scope. The list remains unavailable for every other customer, and the
same customer-scoped check protects drafts, order history and authoritative
order confirmation.

Migration `0043` adds a read-only Sale pricing snapshot RPC. It returns only
active global price lists explicitly enabled by Accounting and their price
rows, avoiding the expensive customer-assignment RLS predicate on every matrix
row. Dealer-specific exceptions remain isolated behind the exact-customer RPC;
no price, product, customer or order data is changed.

Migration `0044` separates the operational collector/counterparty from the
immutable creator identity and adds one Admin/Accounting-only amendment RPC for
active receipt and payment vouchers. Receipt/payment direction remains fixed.
Manual vouchers update directly; customer receipts and supplier payments append
debt adjustments; return refunds rebalance cash and debt without changing the
return total. Every route runs atomically and writes a before/after audit row.

Migration `0045` separates amendment lineage (`amends_ledger_id`) from true
financial reversal lineage (`reversal_of_id`). It migrates any 0044 amendment
rows without changing balances, preserves the one-cancellation-per-entry
constraint, and replaces the voucher amendment RPC to prevent duplicate-key
errors on repeated edits.

Migration `0046` reconciles later standalone receipts, including non-sales
categories, when the payer uniquely and exactly matches one active customer.
It links only previously unlinked vouchers, creates the missing payment and
debt-ledger rows, reduces the matching customer's debt exactly once, and leaves
unmatched or already-linked transactions unchanged.

Migration `0047` adds two optional, brand-scoped invoice-print settings: the
warehouse text and sales phone. It initializes only missing warehouse text and
does not change orders, prices, customer debt, payments, cashbook or inventory.

Migration `0048` lets Admin and Accounting save drafts and finalize orders with
the explicit `Nhập tay có xác nhận` pricing mode. Finalization accepts browser
prices only when that privileged actor sends the confirmation flag; Sale keeps
the existing customer price-list rules and cannot opt into trusted manual prices.

Migration `0049` initializes an empty canonical price-source record when `0048`
uses confirmed manual prices. It prevents an unassigned-record error during
finalization without changing totals, debt entries or standard price-list lookup.

Migration `0050` makes cancellation of an amended customer receipt reverse its
current effective voucher value instead of its original payment value. It also
appends one guarded correction for voucher `PT-20260810-00000146`, changing
customer `KH000003` debt from `20,587,100` to the confirmed `10,592,100` VND.
Clean staging databases where all three incident-specific rows are absent skip
that correction; a partially restored target set still stops the migration.

Migration `0051` adds a read-only, RLS-respecting cashbook window RPC. It returns
only vouchers in the requested date range plus three small opening-net totals
for cash, bank and wallet, so the browser no longer downloads all older vouchers
just to calculate the opening balance.

Migration `0052` keeps only four days of audit and activity history. It compacts
new rows to business-significant changes, records price-item changes that were
previously missing, and removes older rows only from `audit_logs` and
`activity_logs`. All audit and retention triggers fail safely so logging cannot
block changes to orders, price lists, products, customers or cashbook entries.

Migration `0053` repairs the legacy order/draft trigger that still checked only
the global Sale visibility toggle. A Sale may save an order with a disabled
price list only when that exact active list is assigned to the selected active
customer inside the Sale's scope. The list remains unavailable for all other
customers and its `is_available_for_sales` setting is not changed.

Migration `0055` adds an optional percentage deduction to each returned order
item. The database validates the percentage, calculates the net refund from the
immutable original-order value, and keeps debt, cash refund, revenue, commission
and return cancellation authoritative. A zero or omitted percentage preserves
the previous return calculation exactly.
