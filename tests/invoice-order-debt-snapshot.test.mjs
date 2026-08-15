import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('agent invoice reads the order ledger snapshot without changing shared customer state', () => {
  const invoice = read('js/components/invoice.js');
  const service = read('js/services/supabase.js');

  assert.match(invoice, /type === 'agent'[\s\S]{0,180}dbFetchOrderDebtSnapshot\(order\.id, order\.customerId\)/);
  assert.match(invoice, /getOrderDebtSnapshot\(order, cust, orderDebtSnapshot\)/);
  assert.doesNotMatch(invoice, /debtHistory\.find\(h => h\.id === order\.id\)/);
  assert.match(service, /export async function dbFetchOrderDebtSnapshot/);
  assert.match(service, /\.eq\('order_id', orderId\)[\s\S]*\.eq\('customer_id', customerId\)[\s\S]*\.eq\('transaction_type', 'order'\)/);
});
