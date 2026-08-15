import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('index.html');
const cashbook = read('js/components/so_quy.js');
const css = read('style.css');

test('cashbook voucher details expand inside the table instead of a floating modal', () => {
  assert.doesNotMatch(html, /id="so-quy-detail-modal"/);
  assert.match(cashbook, /let expandedCashbookTransactionId = ''/);
  assert.match(cashbook, /renderCashbookInlineDetail\(t\)/);
  assert.match(cashbook, /class="so-quy-inline-detail-row"/);
  assert.match(cashbook, /aria-expanded="\$\{isExpanded\}"/);
  assert.doesNotMatch(cashbook, /showTransactionDetails|detailModal\.classList\.add\('active'\)/);
});

test('inline detail keeps voucher information and existing financial actions', () => {
  for (const label of [
    'Số tiền', 'Loại thu chi', 'Phương thức thanh toán',
    'Người tạo', 'Thời gian', 'Chưa có ghi chú'
  ]) {
    assert.match(cashbook, new RegExp(label));
  }
  assert.match(cashbook, /js-cashbook-inline-edit/);
  assert.match(cashbook, /js-cashbook-inline-cancel/);
  assert.match(cashbook, /js-cashbook-inline-reconcile/);
  assert.match(cashbook, /dbCancelCashbookEntry/);
  assert.match(cashbook, /dbReconcileLegacyCustomerReceipt/);
});

test('expanded voucher layout is responsive and visually joined to its row', () => {
  assert.match(css, /\.so-quy-transaction-row\.is-expanded td/);
  assert.match(css, /\.so-quy-inline-detail-row > td/);
  assert.match(css, /\.so-quy-inline-grid[\s\S]*grid-template-columns: repeat\(4/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.so-quy-inline-grid \{ grid-template-columns: 1fr/);
});
