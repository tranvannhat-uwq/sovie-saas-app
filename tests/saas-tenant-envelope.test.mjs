import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'migrations', '0057_business_tenant_envelope.sql'), 'utf8');
const integration = fs.readFileSync(
  path.join(root, 'migrations', 'tests', 'saas_business_tenant_envelope_integration.sql'),
  'utf8'
);

const businessTables = [
  'companies', 'customers', 'brands', 'product_groups', 'products',
  'pricelists', 'price_list_items', 'orders', 'draft_orders', 'order_items',
  'cashbook_transactions', 'payments', 'sales_returns', 'sales_return_items',
  'customer_debt_transactions', 'finished_goods_stock', 'raw_materials',
  'semi_finished', 'recipes', 'production_logs', 'audit_logs',
  'commission_transactions', 'customer_assignments', 'commission_rules',
  'starting_balances', 'suppliers', 'purchases', 'purchase_items',
  'purchase_payments', 'supplier_debt_transactions', 'kpi_targets',
  'payroll_periods', 'payroll_adjustments', 'payroll_entries', 'activity_logs'
];

test('Phase 2A covers every existing business table', () => {
  for (const table of businessTables) {
    assert.match(sql, new RegExp(`'${table}'`), table);
  }
  assert.doesNotMatch(sql, /'profiles'/);
  assert.doesNotMatch(sql, /'organization_memberships'/);
});

test('legacy data is backfilled before the foreign key is validated', () => {
  const updateIndex = sql.indexOf("UPDATE public.%I SET organization_id = $1");
  const validateIndex = sql.indexOf('VALIDATE CONSTRAINT');
  assert.ok(updateIndex >= 0 && validateIndex > updateIndex);
  assert.match(sql, /00000000-0000-4000-8000-000000000001/);
  assert.match(sql, /WHERE organization_id IS NULL/);
  assert.match(sql, /ALTER TABLE public\.draft_orders REPLICA IDENTITY FULL/);
});

test('new writes derive tenant from authenticated membership and reject tampering', () => {
  assert.match(sql, /active_organization_id uuid := public\.current_organization_id\(\)/);
  assert.match(sql, /cross-organization write rejected/);
  assert.match(sql, /organization_id is immutable/);
  assert.match(sql, /ALTER COLUMN organization_id SET DEFAULT public\.current_organization_id\(\)/);
  assert.match(sql, /BEFORE INSERT OR UPDATE/);
});

test('Phase 2A stays additive and does not claim premature RLS completion', () => {
  assert.doesNotMatch(sql, /DROP TABLE|DELETE FROM|TRUNCATE/i);
  assert.doesNotMatch(sql, /CREATE POLICY|DROP POLICY|ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /Isolation is complete[\s\S]*follow-up migration/);
});

test('staging verification checks columns, backfill, foreign keys and trigger privilege', () => {
  assert.match(integration, /all_business_tables_have_organization_id/);
  assert.match(integration, /legacy_backfill_/);
  assert.match(integration, /all_foreign_keys_are_validated/);
  assert.match(integration, /guard_function_is_not_browser_callable/);
  assert.match(integration, /ROLLBACK;/);
});
