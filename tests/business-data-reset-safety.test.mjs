import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'scripts/reset-business-data.sql'), 'utf8');
const runner = fs.readFileSync(path.join(root, 'scripts/run-reset-business-data.ps1'), 'utf8');

test('business reset requires owner, exact confirmation and a verified backup', () => {
  assert.match(sql, /current_user <> 'postgres'/);
  assert.match(sql, /PRODUCTION_APPROVED/);
  assert.match(sql, /DELETE_ALL_CASHBOOK_ORDERS_CUSTOMERS_PURCHASES/);
  assert.match(runner, /Type exactly \$confirmationText/);
  assert.match(runner, /pg_dump[\s\S]*--schema-only/);
  assert.match(runner, /pg_dump[\s\S]*--data-only/);
  assert.match(runner, /Backup verification failed; no data was deleted/);
  assert.match(runner, /function Test-DockerEngineReady/);
  assert.match(runner, /Starting Docker Desktop/);
  assert.match(runner, /did not become ready within 120 seconds/);
});

test('business reset deletes requested operational data and resets supplier balances', () => {
  for (const table of [
    'sales_return_items', 'sales_returns', 'commission_transactions',
    'supplier_debt_transactions', 'purchase_payments', 'purchase_items', 'purchases',
    'payments', 'customer_debt_transactions', 'cashbook_transactions',
    'order_items', 'draft_orders', 'orders', 'customer_assignments',
    'starting_balances', 'customers'
  ]) {
    assert.match(sql, new RegExp(`'${table}'|DELETE FROM public\\.${table}`));
  }
  assert.match(sql, /opening_debt = 0[\s\S]*total_purchase = 0[\s\S]*total_paid = 0[\s\S]*debt = 0/);
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /COMMIT;\s*$/);
});

test('every price list and price-list item is preserved and only customer linkage is detached', () => {
  assert.match(sql, /UPDATE public\.pricelists[\s\S]*customer_id = NULL/);
  assert.doesNotMatch(sql, /DELETE FROM public\.pricelists/);
  assert.doesNotMatch(sql, /DELETE FROM public\.price_list_items/);
  assert.match(sql, /'price_lists_deleted', 0/);
  assert.match(sql, /'price_list_items_deleted', 0/);
  for (const table of ['profiles', 'companies', 'brands', 'products', 'pricelists', 'price_list_items', 'suppliers', 'schema_migrations']) {
    assert.match(sql, new RegExp(`'${table}'.+public\\.${table}`));
  }
});
