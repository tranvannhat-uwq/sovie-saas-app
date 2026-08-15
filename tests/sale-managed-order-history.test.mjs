import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const migration = read('migrations/0026_sale_managed_customer_order_history.sql');
const history = read('js/components/history.js');

test('order RLS includes managed dealers without weakening price-list checks', () => {
  assert.match(migration, /DROP POLICY IF EXISTS orders_select ON public\.orders/);
  assert.match(migration, /public\.can_access_customer\(customer_id\)/);
  assert.match(migration, /public\.can_use_order_price_lists\(pricelist_id, items\)/);
  assert.match(migration, /created_by = auth\.uid\(\)::text/);
  assert.match(migration, /has_table_privilege\('authenticated', 'public\.orders', 'DELETE'\)/);
});

test('Sale history keeps orders whose customer is in the RLS-scoped customer set', () => {
  assert.match(history, /function orderIsVisibleToSale\(order, user, lookups\)/);
  assert.match(history, /lookups\.customerById\.has\(String\(order\.customerId\)\)/);
  assert.match(history, /orderIsVisibleToSale\(o, state\.currentUser, lookups\)/);
  assert.doesNotMatch(history, /if \(!orderWasCreatedByUser\(o, state\.currentUser\)\) return false/);
});
