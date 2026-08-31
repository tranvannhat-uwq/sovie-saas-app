import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const values = new Map();
globalThis.localStorage = {
  getItem: key => values.has(key) ? values.get(key) : null,
  setItem: (key, value) => values.set(key, String(value)),
  removeItem: key => values.delete(key)
};

const storageModule = await import(pathToFileURL(
  path.join(root, 'js', 'services', 'tenant-storage.js')
));
const {
  activateTenantStorage,
  clearTenantStorageContext,
  tenantStorage,
  tenantStorageKey
} = storageModule;

test('business cache is unavailable before tenant identity is established', () => {
  clearTenantStorageContext();
  tenantStorage.setItem('billing_system_customers', '[{"id":"unsafe"}]');
  assert.equal(tenantStorage.getItem('billing_system_customers'), null);
  assert.equal(values.has('billing_system_customers'), false);
});

test('the same business key is isolated between organizations', () => {
  values.clear();
  activateTenantStorage('org-a');
  tenantStorage.setItem('billing_system_customers', '[{"id":"a"}]');
  activateTenantStorage('org-b');
  assert.equal(tenantStorage.getItem('billing_system_customers'), null);
  tenantStorage.setItem('billing_system_customers', '[{"id":"b"}]');
  activateTenantStorage('org-a');
  assert.equal(tenantStorage.getItem('billing_system_customers'), '[{"id":"a"}]');
  assert.equal(values.get(tenantStorageKey('billing_system_customers', 'org-b')), '[{"id":"b"}]');
});

test('unscoped legacy business data is discarded instead of assigned by guess', () => {
  values.clear();
  values.set('billing_system_orders', '[{"id":"legacy"}]');
  activateTenantStorage('org-clean');
  assert.equal(values.has('billing_system_orders'), false);
  assert.equal(tenantStorage.getItem('billing_system_orders'), null);
});

test('non-business browser preferences remain unscoped', () => {
  values.clear();
  activateTenantStorage('org-a');
  tenantStorage.setItem('historyViewMode', 'details');
  activateTenantStorage('org-b');
  assert.equal(tenantStorage.getItem('historyViewMode'), 'details');
});

test('business modules no longer access unscoped localStorage directly', () => {
  const files = [
    'js/services/supabase.js', 'js/services/backup.js',
    'js/components/brands.js', 'js/components/customers.js',
    'js/components/dashboard.js', 'js/components/goods.js',
    'js/components/history.js', 'js/components/invoice.js',
    'js/components/products.js', 'js/components/so_quy.js',
    'js/components/suppliers.js'
  ];
  for (const relative of files) {
    const source = fs.readFileSync(path.join(root, relative), 'utf8');
    assert.doesNotMatch(source, /localStorage\.(?:getItem|setItem|removeItem)\([^\n]*billing_system_(?:brands|customers|products|orders|cashbook|suppliers|sales_returns|raw_materials|semi_finished|recipes|production_logs|finished_goods_stock|goods_receipts|purchase)/);
  }
});
