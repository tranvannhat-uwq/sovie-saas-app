import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('cashbook receipt reloads the authoritative customer balance after the RPC', () => {
  const cashbook = read('js/components/so_quy.js');
  const receiptSubmit = cashbook.slice(
    cashbook.indexOf("receiptForm.addEventListener('submit'"),
    cashbook.indexOf('// 17. Modal actions')
  );

  assert.match(
    receiptSubmit,
    /await dbRecordCustomerPayment[\s\S]*await dbRefreshCustomerFinancialState\(matchedCustomer\.id, \{ includeHistory: false \}\)/
  );
  assert.match(receiptSubmit, /if \(!refreshedCustomer\)[\s\S]*currentCustomer\.debt = newDebt/);
});

test('customer debt collection reloads the authoritative customer balance after the RPC', () => {
  const customers = read('js/components/customers.js');
  const paymentSubmit = customers.slice(
    customers.indexOf('export async function handlePayDebtSubmit'),
    customers.indexOf('export function openCustomerDebtAdjustModal')
  );

  assert.match(
    paymentSubmit,
    /await dbRecordCustomerPayment[\s\S]*await dbRefreshCustomerFinancialState\(cust\.id, \{ includeHistory: false \}\)/
  );
  assert.match(paymentSubmit, /if \(!refreshedCustomer\)[\s\S]*currentCustomer\.debt = fallbackDebt/);
  assert.match(paymentSubmit, /currentCustomer\.debt < 0/);
});
