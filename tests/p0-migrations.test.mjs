import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(root, 'migrations');
const migrationNames = [
  '0001_core_schema_and_migration_registry.sql',
  '0002_auth_profiles_and_rls.sql',
  '0003_secure_rpc_boundary.sql',
  '0004_lock_down_legacy_objects.sql',
  '0005_profile_identity_integrity.sql',
  '0006_authoritative_order_pricing_and_idempotency.sql',
  '0007_payments_debt_cashbook_and_order_reversals.sql',
  '0008_authoritative_sales_returns_and_reversals.sql',
  '0009_supplier_purchases_debt_and_payments.sql',
  '0010_supplier_updated_at_compatibility.sql',
  '0011_confirm_order_variable_conflict_fix.sql',
  '0012_phase5_reporting_kpi_payroll.sql',
  '0013_legacy_cashbook_customer_and_order_compatibility.sql',
  '0014_sales_return_variable_conflict_fix.sql',
  '0015_customer_opening_financial_import.sql',
  '0016_customer_import_rpc_variable_conflict_fix.sql',
  '0017_privileged_order_business_date.sql',
  '0018_quick_customer_creation_rpc.sql',
  '0019_order_amendment_and_customer_advance.sql',
  '0020_customer_debt_adjustment_credit.sql',
  '0021_enable_scoped_realtime.sql',
  '0022_dot_color_surcharge.sql',
  '0023_authoritative_color_surcharges.sql',
  '0024_sale_managed_customer_debt_history.sql',
  '0025_global_price_list_order_override.sql',
  '0026_sale_managed_customer_order_history.sql',
  '0027_market_price_lists_are_print_only.sql',
  '0028_tt_20072026_requires_accounting_approval.sql',
  '0029_order_notes_annotation.sql',
  '0030_cashbook_manual_transaction_edit.sql',
  '0031_customer_pricelist_priority_alignment.sql',
  '0032_reconcile_legacy_customer_receipts.sql',
  '0033_dashboard_revenue_attribution.sql',
  '0034_cashbook_customer_history_backfill.sql',
  '0035_deterministic_sku_price_fallback.sql',
  '0036_activity_log.sql',
  '0037_draft_order_activity.sql',
  '0038_activity_history_bridge.sql',
  '0039_admin_maintenance_mode.sql',
  '0040_customer_assigned_price_list_exception.sql',
  '0041_customer_assigned_pricing_rpc.sql',
  '0042_order_business_date_clock_skew.sql',
  '0043_sale_pricing_snapshot_rpc.sql',
  '0044_cashbook_voucher_amendment.sql',
  '0045_cashbook_amendment_lineage.sql',
  '0046_non_sales_customer_receipt_history.sql',
  '0047_brand_invoice_print_settings.sql',
  '0048_privileged_manual_order_pricing.sql',
  '0049_initialize_manual_price_record.sql',
  '0050_cancel_amended_customer_receipt.sql',
  '0051_cashbook_window_egress.sql',
  '0052_short_compact_audit_retention.sql',
  '0053_customer_assigned_price_list_trigger_repair.sql',
  '0054_quick_customer_manager_identity.sql',
  '0055_sales_return_deduction_percent.sql'
];
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('P0 migrations are ordered and tracked', () => {
  const actual = fs.readdirSync(migrationDir)
    .filter(name => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  assert.deepEqual(actual, migrationNames);
  migrationNames.forEach((name, index) => {
    const sql = read(path.join('migrations', name));
    const version = String(index + 1).padStart(4, '0');
    assert.match(sql, new RegExp(`VALUES \\('${version}'`));
    assert.match(sql, /BEGIN;/);
    assert.match(sql, /COMMIT;/);
  });
});

test('new migration chain never grants anon business access', () => {
  const sql = migrationNames.map(name => read(path.join('migrations', name))).join('\n');
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL|EXECUTE)[\s\S]{0,120}\bTO\s+anon\b/i);
  assert.doesNotMatch(sql, /CREATE\s+POLICY[\s\S]{0,240}(?:USING|WITH\s+CHECK)\s*\(true\)[\s\S]{0,80}\bTO\s+anon\b/i);
  assert.match(sql, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/i);
});

test('roles and financial actors come from auth-linked profiles', () => {
  const authSql = read('migrations/0002_auth_profiles_and_rls.sql');
  const rpcSql = read('migrations/0003_secure_rpc_boundary.sql');
  assert.match(authSql, /auth_user_id\s*=\s*auth\.uid\(\)/);
  assert.match(authSql, /'sale', false, true/);
  assert.doesNotMatch(authSql, /raw_user_meta_data->>'role'/);
  assert.doesNotMatch(authSql, /lower\(auth_user\.email\)\s*=\s*lower\(legacy\.username\)/);
  assert.match(authSql, /NULL::uuid/);
  assert.match(rpcSql, /actor\s*:=\s*public\.require_authenticated_profile\(\)/);
  assert.match(rpcSql, /actor\.auth_user_id/);
  assert.match(rpcSql, /NOT public\.can_use_price_list/);
});

test('profile identity integrity is enforced by migration 0005', () => {
  const sql = read('migrations/0005_profile_identity_integrity.sql');
  assert.match(sql, /FOREIGN KEY \(auth_user_id\) REFERENCES auth\.users\(id\)/);
  assert.match(sql, /UNIQUE \(auth_user_id\)/);
  assert.match(sql, /role IN \('admin', 'accounting', 'sale'\)/);
  assert.match(sql, /auth_user_id = auth\.uid\(\)/);
  assert.match(sql, /rpc_my_profile_link_status/);
  assert.doesNotMatch(sql, /email[^\n]{0,80}(?:admin|role)/i);
});

test('admin bootstrap requires explicit staging and elevation confirmations', () => {
  const sql = read('scripts/p0-bootstrap-admin-staging.sql');
  assert.match(sql, /environment_confirmation.*STAGING_ONLY/s);
  assert.match(sql, /I_UNDERSTAND_GRANT_ADMIN/);
  assert.match(sql, /Expected exactly one existing Auth user/);
  assert.match(sql, /Expected exactly one legacy profile/);
  assert.match(sql, /already linked to a different Auth user/);
  assert.match(sql, /Auth user is already linked to a different profile/);
  assert.match(sql, /GET DIAGNOSTICS changed_count = ROW_COUNT/);
  assert.match(sql, /INSERT INTO public\.audit_logs/);
  assert.doesNotMatch(sql, /@[a-z0-9.-]+\.[a-z]{2,}/i);
});

test('frontend contains no local or session authorization fallback', () => {
  const users = read('js/components/users.js');
  const main = read('js/main.js');
  const service = read('js/services/supabase.js');
  const combined = `${users}\n${main}\n${service}`;
  assert.doesNotMatch(combined, /password\s*:\s*['"][^'"]+['"]/);
  assert.doesNotMatch(combined, /sessionStorage\.getItem\('billing_system_auth'\)/);
  assert.doesNotMatch(combined, /localStorage\.getItem\('billing_system_users'\)/);
  assert.doesNotMatch(combined, /\.auth\.signUp\(/);
  assert.doesNotMatch(combined, /localStorage\.setItem\('billing_system_(?:pricelists|price_list_items)'/);
  assert.doesNotMatch(combined, /localStorage\.getItem\('billing_system_(?:pricelists|price_list_items)'/);
  assert.match(service, /tableUsersName = 'profiles'/);
});

test('frontend profile bootstrap uses the Auth session UUID and clears rejected sessions', () => {
  const users = read('js/components/users.js');
  const main = read('js/main.js');
  assert.match(users, /data\?\.session\?\.user/);
  assert.match(users, /\.eq\('auth_user_id', authUserId\)/);
  assert.match(users, /validateProfileRows/);
  assert.match(users, /rpc_my_profile_link_status/);
  assert.match(users, /await supabaseClient\.auth\.signOut\(\)/);
  assert.match(users, /clearAuthenticatedSessionState\(\)/);
  assert.doesNotMatch(users, /\.eq\('is_active', true\)\s*\.single\(\)/);
  assert.doesNotMatch(users, /from\(['"]users['"]\)/);
  assert.match(main, /loadAuthenticatedProfile\(session\.user\.id\)/);
});

test('SQL integration fixtures tolerate automatic auth profile triggers', () => {
  const suites = [
    'phase1_order_pricing_integration.sql',
    'phase2_financial_reversals_integration.sql',
    'phase3_sales_returns_integration.sql',
    'phase4_supplier_purchases_integration.sql'
  ];
  for (const suite of suites) {
    const sql = read(path.join('migrations', 'tests', suite));
    assert.doesNotMatch(sql, /ON CONFLICT \(id\) DO UPDATE SET auth_user_id/i);
    assert.match(sql, /ON CONFLICT DO NOTHING;[\s\S]*UPDATE public\.profiles/);
  }
});
