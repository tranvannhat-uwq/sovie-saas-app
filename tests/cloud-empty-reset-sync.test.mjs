import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');

test('a successful empty customer response clears browser state and cache', () => {
  const start = service.indexOf('const fetchCustomers = async () =>');
  const end = service.indexOf('const fetchPricelists = async () =>', start);
  const fetchCustomers = service.slice(start, end);

  assert.match(fetchCustomers, /state\.customers = \(customerData \|\| \[\]\)\.map/);
  assert.match(fetchCustomers, /localStorage\.setItem\('billing_system_customers', JSON\.stringify\(state\.customers\)\)/);
  assert.doesNotMatch(fetchCustomers, /customerData\.length > 0/);
  assert.doesNotMatch(fetchCustomers, /else if \(localCust\.length > 0\)/);
  assert.match(fetchCustomers, /catch \(custErr\)[\s\S]*billing_system_customers/);
});

test('successful empty order and cashbook windows clear only their loaded ranges', () => {
  assert.match(service, /function replaceLoadedOrderWindow\(rawOrders, startIso = null, endExclusiveIso = null\)/);
  assert.match(service, /const retained = \(state\.savedOrders \|\| \[\]\)\.filter\(order => !isInsideWindow\(order\)\)/);
  assert.match(service, /state\.savedOrders = \[\.\.\.mapped, \.\.\.retained\][\s\S]*cacheOrdersLocally\(state\.savedOrders\)/);
  assert.match(service, /function replaceLoadedCashbookWindow\(rawTransactions, startIso, endExclusiveIso\)/);
  assert.match(service, /const retained = cached\.filter\(transaction => \{/);
  assert.match(service, /return replaceLoadedCashbookWindow\(rows, startIso, endExclusiveIso\)/);
});
