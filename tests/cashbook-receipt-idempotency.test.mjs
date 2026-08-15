import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cashbook = fs.readFileSync(path.join(root, 'js/components/so_quy.js'), 'utf8');

test('receipt modal uses a fresh stable UUID instead of the display code', () => {
  assert.match(cashbook, /let pendingReceiptIdempotencyKey = ''/);
  assert.match(cashbook, /addThuBtn\.addEventListener\('click',[\s\S]*pendingReceiptIdempotencyKey = globalThis\.crypto\.randomUUID\(\)/);
  assert.match(cashbook, /idempotencyKey: pendingReceiptIdempotencyKey/);
  assert.match(cashbook, /dbRecordCustomerPayment\([\s\S]*pendingReceiptIdempotencyKey/);
  assert.doesNotMatch(cashbook, /dbRecordCustomerPayment\([\s\S]{0,300}`receipt:\$\{finalCode\}`/);
});

test('closing the receipt clears the attempt key while failed saves keep it for retry', () => {
  assert.match(cashbook, /const hideReceiptModal = \(\) => \{[\s\S]*pendingReceiptIdempotencyKey = ''/);
  const submit = cashbook.slice(cashbook.indexOf("receiptForm.addEventListener('submit'"), cashbook.indexOf('// 17. Modal actions'));
  assert.match(submit, /if \(!paymentResult\) return;/);
  assert.match(submit, /hideReceiptModal\(\);/);
});
