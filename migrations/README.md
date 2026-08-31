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
56. `0056_saas_control_plane.sql`
57. `0057_business_tenant_envelope.sql`
58. `0058_tenant_relational_boundary.sql`
59. `0059_platform_audit_tenant_bootstrap.sql`
60. `0060_tenant_scoped_rpc_executor.sql`
61. `0061_business_capability_model.sql`
62. `0062_generic_catalog_and_extensions.sql`
63. `0063_workspace_onboarding_and_switching.sql`
64. `0064_workspace_member_management.sql`
65. `0065_tenant_activity_conflict_keys.sql`
66. `0066_workspace_invitations_and_owner_transfer.sql`
67. `0067_organization_people_directory.sql`
68. `0068_subscription_access_lifecycle.sql`
69. `0069_monthly_order_quota.sql`
70. `0070_custom_domain_workflow.sql`
71. `0071_billing_control_plane.sql`
72. `0072_signed_billing_event_ordering.sql`
73. `0073_domain_dns_verification_attempts.sql`
74. `0074_cloudflare_ssl_provisioning.sql`
75. `0075_plan_catalog_branch_warehouse_management.sql`
76. `0076_tenant_backup_inventory.sql`
77. `0077_backup_inventory_membership_hotfix.sql`
78. `0078_organization_archive_workflow.sql`
79. `0079_enforce_business_tenant_not_null.sql`
80. `0080_platform_customer_account_console.sql`
81. `0081_platform_customer_provisioning.sql`
82. `0082_platform_customer_lifecycle.sql`
83. `0083_platform_plan_catalog.sql`
84. `0084_momo_checkout_and_tax_policy.sql`

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

Migration `0056` starts the SaaS control plane. It adds organizations,
auth-linked memberships, plans, subscriptions and authenticated onboarding/context
RPCs. Existing Auth-linked profiles are placed in one compatibility organization;
business tables are deliberately not presented as tenant-isolated until the next
staging migration has backfilled `organization_id` and replaced their RLS/RPCs.
Run `migrations/tests/saas_control_plane_integration.sql` on isolated staging to
verify two-tenant RLS, context selection and server-owned subscription state.

Migration `0057` starts Phase 2A tenantization. It adds `organization_id` to
every business table, backfills existing staging rows into the compatibility
organization, validates organization foreign keys, adds indexes/defaults and
rejects browser tenant tampering or tenant reassignment. It deliberately leaves
existing RLS policies and SECURITY DEFINER RPCs unchanged until the next
migration can replace them as one reviewed isolation boundary. Run
`migrations/tests/saas_business_tenant_envelope_integration.sql` after applying it.

Migration `0058` completes the direct-table and existing relational portion of
the tenant boundary. It replaces 11 global business unique constraints with
organization-scoped equivalents, replaces all nine existing business-to-business
foreign keys with composite tenant keys, and adds a restrictive organization
policy to all 35 business tables. SECURITY DEFINER RPC recompilation remains a
separate reviewed migration. Run
`migrations/tests/saas_tenant_relational_boundary_integration.sql` after applying it.

Migration `0059` repairs Auth bootstrap after the tenant write guard. Platform
audit rows emitted before a new Auth identity has any membership may keep a null
organization and remain invisible to tenant RLS. Authenticated audit and every
business-table write still require the active organization.

Migration `0060` removes database-owner bypass from browser-callable business
RPC graphs. A dedicated `NOLOGIN/NOBYPASSRLS` executor receives tenant-scoped
policies on all 35 business tables, profile visibility is limited to active
co-members, and legacy database role checks derive from the active SaaS
membership.
Run `migrations/tests/saas_rpc_tenant_executor_integration.sql` to verify the
role attributes, all 39 callable functions, membership-role mapping and an
actual cross-tenant activity-log RPC read.

Migration `0061` adds the organization capability model: settings, modules,
branches, warehouses and domains. Existing and newly onboarded organizations
receive conservative defaults, and `rpc_my_business_capabilities()` returns
tenant-scoped configuration without domain verification secrets. Run
`migrations/tests/saas_business_capability_integration.sql` on staging.

Migration `0062` adds an industry-neutral catalog model for units, categories,
typed attributes, product/variant values and opt-in extensions. The legacy
workspace keeps paint color pricing through an explicit `paint_color` extension;
new organizations remain generic. Run
`migrations/tests/saas_generic_catalog_integration.sql` on staging.

Migration `0063` makes first-workspace onboarding possible for an authenticated
active profile that has no membership yet. It validates reserved/duplicate
subdomains, stores business type and industry, and creates Owner membership plus
Starter trial in the same transaction. The existing two-argument RPC remains as
a compatibility wrapper.
Run `migrations/tests/saas_workspace_onboarding_integration.sql` to verify a
profile with no membership can create its first fully initialized workspace and
switch between two defaults.

Migration `0064` replaces the legacy global profile directory with a
workspace-membership directory, adds Owner/Admin member RPCs, enforces the plan
user quota under an organization row lock, protects the Owner and prevents
self-suspension. Direct authenticated profile mutations are closed; Auth user
creation must attach a membership or roll the new Auth identity back.
Run `migrations/tests/saas_workspace_member_management_integration.sql` on staging.

Migration `0065` updates the three pre-tenant activity trigger functions so
their `ON CONFLICT` targets include `organization_id`, matching the unique key
introduced by migration `0058`. This keeps audit logging non-blocking for
profile, draft and price updates without reintroducing a global business key.

Migration `0066` adds pending workspace invitations, login-time acceptance and
transactional Owner transfer. A partial unique index guarantees one active
Owner per organization; extra Owners created by the early legacy backfill are
deterministically demoted to Admin before the invariant is installed.
Run `migrations/tests/saas_workspace_invitations_integration.sql` on staging.

Migration `0067` adds a tenant-scoped personnel directory independent from
Supabase Auth and workspace memberships. Owner/Admin can maintain employees,
contractors and external partners without consuming the login-user quota; all
active members may read the directory for business assignment selectors.
Direct browser writes remain closed.
Run `migrations/tests/saas_organization_people_integration.sql` on staging.

Migration `0068` adds the subscription access lifecycle. Active/trial tenants
may write, past-due tenants receive a seven-day grace period, and paused or
cancelled tenants become read-only without losing export/read access. Restrictive
RLS guards cover all 35 business tables for both browser and RPC executor writes.
Provider/back-office state events are service-role only, audited and idempotent.
Run `migrations/tests/saas_subscription_access_integration.sql` on staging.

Migration `0069` enforces each plan's monthly confirmed-order allowance with a
tenant-derived `BEFORE INSERT` trigger and an organization row lock, preventing
concurrent confirmations from oversubscribing the final slot. Cancelled/draft
records do not consume allowance. `rpc_my_plan_usage()` exposes authoritative
member and order usage for the workspace switcher.
Run `migrations/tests/saas_monthly_order_quota_integration.sql` on staging.

Migration `0070` adds the Owner-only, plan-gated custom-domain workflow. Domain
verification tokens remain tenant-private, while DNS/SSL evidence can only be
applied through a service-role RPC with idempotent event keys. A custom hostname
becomes primary only after both verification and SSL are active; disabling it
atomically restores the workspace's `sovie.vn` subdomain as primary.
Run `migrations/tests/saas_custom_domain_workflow_integration.sql` on staging.

Migration `0071` adds provider-neutral plan-change requests, tenant-scoped
invoices and idempotent billing events. Owners may read billing state and queue
a plan change, but only `service_role` can apply payment outcomes to the
subscription lifecycle. Run
`migrations/tests/saas_billing_control_plane_integration.sql` on staging.

Migration `0072` retires service access to the unsigned billing RPC and adds a
signed-event RPC with provider occurrence timestamps. Stale or duplicate
deliveries remain auditable but cannot regress a newer invoice or subscription
state. Run `migrations/tests/saas_signed_billing_event_ordering_integration.sql`
on staging.

Migration `0073` adds Owner-triggered DNS verification attempts with a one-minute
per-domain rate limit, tenant audit history and a service-only completion RPC.
Successful TXT checks mark DNS as verified but deliberately leave SSL pending.
Run `migrations/tests/saas_domain_dns_verification_integration.sql` on staging.

Migration `0074` adds tenant-audited Cloudflare custom-hostname provisioning
jobs. Pending provider state never regresses DNS verification; a domain becomes
active only when Cloudflare reports both hostname and SSL status as `active`.
Run `migrations/tests/saas_cloudflare_ssl_provisioning_integration.sql` on staging.

Migration `0075` publishes the baseline Starter, Pro and Business quota catalog
and adds Owner/Admin RPCs for branch and warehouse management. Organization row
locks serialize quota decisions; branch links are tenant checked and default
locations cannot be deactivated without selecting another default. Direct
authenticated table writes remain closed. Run
`migrations/tests/saas_branch_warehouse_management_integration.sql` on staging.

Migration `0076` adds an Owner/Admin-only tenant backup inventory RPC. Migration
`0077` immediately corrects its membership count to use the deployed
`auth_user_id` membership schema. The inventory returns a workspace identity,
schema version and authoritative row counts used to bind Excel metadata and
manifest validation to exactly one tenant. Run
`migrations/tests/saas_tenant_backup_inventory_integration.sql` on staging.

Migration `0078` adds the post-cancellation organization archive workflow.
Only an Owner can request it after the 30-day read-only deadline, with exact
slug confirmation and a verified backup reference. Only `service_role` can
complete the request; completion suspends memberships and routing domains but
does not delete business rows. Run
`migrations/tests/saas_organization_archive_integration.sql` on staging.

Migration `0079` closes the tenant-envelope rollout by requiring
`organization_id NOT NULL` on all 33 business-data tables after a zero-null
precondition. `audit_logs` and `activity_logs` remain nullable only for the
explicit unauthenticated platform-audit bootstrap. Run
`migrations/tests/saas_business_tenant_not_null_integration.sql` on staging.

Migration `0080` separates platform staff from tenant roles and adds the
cross-tenant customer account console. Migration `0081` adds the
platform-owner-only customer provisioning RPC, active plan catalog and an
append-only platform customer event trail. New customer Owners begin as invited
members; the Edge Function owns Auth invitation delivery and removes a newly
created Auth account if tenant provisioning fails.

Migration `0082` adds platform-owner-only lifecycle controls for plan changes,
trial extensions, suspension/reactivation and cancellation. Every mutation
locks the customer row, updates the existing subscription access state and
writes both subscription and platform audit events. Cancellation requires the
exact workspace slug and preserves a 30-day read-only window; it does not delete
tenant data.

Migration `0083` adds annual plan pricing, ordering and an audited platform plan
editor. It intentionally leaves the existing zero prices unchanged until the
commercial prices are approved. The tenant billing summary exposes both monthly
and yearly prices, while checkout requests remain provider-neutral.

Migration `0084` selects MoMo as the checkout adapter, adds an explicit
VAT-exclusive/not-subject tax policy, stores authoritative checkout totals and
provides service-only RPCs for MoMo responses and signed IPN events. Billing
remains disabled until prices, tax treatment, invoice identity and Edge secrets
are configured.

Migration `0085` adds compact, read-only RPCs for the Admin mobile application.
It provides server-side merged order pagination, summary/detail payload
separation, compact dashboard data, customer debt history and employee metrics.
All functions preserve tenant RLS/role boundaries and change no business row.

Migration `0086` grants the non-login, non-BYPASSRLS tenant RPC executor the
missing read access needed by its existing profile-membership policy. It makes
the mobile dashboard and employee read models executable without granting any
new permission to browser roles or exposing cross-tenant rows.

Migration `0087` introduces the database-enforced `mobile_admin_viewer`
identity. It remains an authenticated tenant member but is rejected by ordinary
business RPCs, so the mobile client can use only the reviewed read models.
Migration `0088` explicitly makes those read models `SECURITY DEFINER` under the
non-login, non-BYPASSRLS executor.

Migrations `0089` and `0090` complete mobile identity resolution. `0089` records
the intermediate Auth schema requirement; `0090` replaces it with the
authenticated request claim so the executor needs no broad Auth-table access.

Migration `0091` isolates the legacy reporting call behind a transaction-local,
read-only dashboard context. Migration `0092` applies the same request-claim
identity to mobile access metadata. Migration `0093` finishes the chain with a
membership RLS policy limited to the authenticated user, active organization
and active membership.

Migration `0094` adds the missing canonical `customers.assigned_brand_id`
relation already used by the current customer form. It retains the legacy brand
name for imports and display, backfills unambiguous tenant-local name matches,
and prevents browser customer writes from failing against the deployed schema.

Migration `0095` fixes Sale customer reads under the tenant-scoped executor by
resolving the authenticated identity from the JWT request claim. This removes
the accidental dependency on Supabase's protected `auth` schema while retaining
the existing tenant and customer-assignment boundaries.

Migration `0096` moves every platform-managed workspace hostname from
platform-managed workspace domains to `*.sovie.vn`, provisions new workspaces on the canonical suffix and
prevents the internal suffix from being registered as an external custom domain.
Existing custom domains and all domain status/primary metadata are preserved.

Migration `0097` is the guarded staging reconciliation for installations where
an earlier migration history entry kept the legacy `*.sovie.io.vn` function
definitions. It checks custom-domain and hostname collisions, rewrites only
platform-managed domains to `*.sovie.vn`, updates provisioning/boundary
functions and preserves status, primary-domain and SSL metadata. Run
`migrations/tests/saas_commercial_launch_readiness.sql` after deployment.
