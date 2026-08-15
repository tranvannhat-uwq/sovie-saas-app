import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('customer history shows only effective business transactions without an audit toggle', () => {
  const html = read('index.html');
  const customers = read('js/components/customers.js');
  const debt = read('js/domain/customer-debt.js');
  const service = read('js/services/supabase.js');

  assert.doesNotMatch(html, /id="customer-debt-show-technical"/);
  assert.match(customers, /buildCustomerDebtDisplayHistory\(cust\.debtHistory \|\| \[\], cust\.debt\)/);
  assert.match(debt, /export function buildCustomerDebtDisplayHistory/);
  assert.match(html, /<th>Thời gian ghi sổ<\/th>/);
  assert.match(service, /postedAt:\s*row\.created_at \|\| row\.transaction_date/);
  assert.match(service, /\.order\('created_at', \{ ascending: true \}\)/);
  assert.doesNotMatch(customers, /customer-debt-neutralized-row|technicalHistoryToggle/);
  assert.match(debt, /DEBT_CANCELLATION_TYPES/);
  assert.match(debt, /DEBT_AMENDMENT_TYPES/);
  assert.match(debt, /type === 'payment_cancel'[\s\S]*cashbookTransactionId/);
  assert.match(debt, /type === 'order_cancel'[\s\S]*orderId/);
  assert.match(debt, /type === 'return_cancel'[\s\S]*salesReturnId/);
});
