import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'scripts/p6-reset-staging-test-data.sql'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'scripts/run-p6-reset-staging.ps1'), 'utf8');

test('staging reset requires database-owner and two explicit confirmations', () => {
  assert.match(sql, /current_user <> 'postgres'/);
  assert.match(sql, /app\.reset_environment[\s\S]*STAGING_ONLY/);
  assert.match(sql, /app\.reset_confirmation[\s\S]*DELETE_OPERATIONAL_TEST_DATA/);
  assert.match(runner, /DatabaseUrl -notmatch \[regex\]::Escape\(\$projectRef\)/);
  assert.match(runner, /Supabase displays a URI template containing \[YOUR-PASSWORD\]/);
  assert.match(runner, /\$connectionUri = \[regex\]::Replace/);
  assert.doesNotMatch(runner, /--dbname \$DatabaseUrl/);
  assert.match(runner, /Type exactly DELETE_OPERATIONAL_TEST_DATA/);
  assert.match(runner, /pg_dump[\s\S]*--schema-only/);
  assert.match(runner, /pg_dump[\s\S]*--data-only/);
  assert.match(runner, /Backup verification failed; no data was deleted/);
});

test('staging reset preserves authentication, catalogue, prices and system configuration', () => {
  for (const table of ['profiles', 'companies', 'brands', 'product_groups', 'products', 'pricelists', 'price_list_items', 'commission_rules', 'schema_migrations']) {
    assert.match(sql, new RegExp(`SELECT '${table}'.+public\\.${table}`));
    assert.doesNotMatch(sql, new RegExp(`DELETE FROM public\\.${table}`));
  }
  assert.match(sql, /price lists still reference a customer/);
});

test('staging reset removes operational ledgers in one transaction and leaves legacy warehouse data untouched', () => {
  for (const table of ['sales_return_items', 'sales_returns', 'supplier_debt_transactions', 'purchase_payments', 'purchase_items', 'purchases', 'payments', 'customer_debt_transactions', 'cashbook_transactions', 'order_items', 'draft_orders', 'orders', 'customers', 'suppliers']) {
    assert.match(sql, new RegExp(`'${table}'`));
  }
  assert.doesNotMatch(sql, /'finished_goods_stock'|'raw_materials'|'semi_finished'|'recipes'|'production_logs'/);
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
  assert.match(sql, /STAGING_TEST_DATA_RESET/);
});
