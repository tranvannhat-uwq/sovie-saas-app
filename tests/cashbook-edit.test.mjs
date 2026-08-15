import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const html = read('index.html');
const cashbookUi = read('js/components/so_quy.js');
const service = read('js/services/supabase.js');
const migration = read('migrations/0030_cashbook_manual_transaction_edit.sql');
const css = read('style.css');

test('cashbook table and export place address immediately after partner', () => {
  assert.match(html, /Người nộp\/nhận<\/th>\s*<th[^>]*>Địa chỉ<\/th>/);
  assert.match(cashbookUi, /getTransactionPartnerAddress\(t\)[\s\S]*escapeCashbookHtml\(partnerAddress\)/);
  assert.match(cashbookUi, /"Người nộp\/nhận", "Địa chỉ"/);
});

test('cashbook edit UI uses the reviewed Cloud RPC and authoritative refresh', () => {
  assert.match(html, /id="so-quy-edit-modal"/);
  assert.match(html, /id="cashbook-edit-collector"/);
  assert.match(html, /id="cashbook-edit-counterparty-type"/);
  assert.match(cashbookUi, /dbAmendCashbookTransaction\(getCanonicalCashbookId\(transaction\)/);
  assert.match(cashbookUi, /upsertCashbookTransactionSnapshot/);
  assert.match(cashbookUi, /dbFetchCashbookTransactionById\(getCanonicalCashbookId\(transaction\)\)/);
  assert.doesNotMatch(cashbookUi, /await dbFetchCashbookTransactions\(\)/);
  assert.match(service, /supabaseClient\.rpc\('rpc_amend_cashbook_transaction'/);
});

test('cashbook edit modal uses a wide grouped responsive layout', () => {
  assert.match(html, /class="modal-content cashbook-edit-modal-content"/);
  assert.match(html, /Thông tin phiếu/);
  assert.match(html, /Đối tượng giao dịch/);
  assert.match(html, /Thanh toán & ghi chú/);
  assert.match(css, /\.cashbook-edit-modal-content[\s\S]*max-width: 940px/);
  assert.match(css, /\.cashbook-edit-grid[\s\S]*grid-template-columns: repeat\(2/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.cashbook-edit-grid \{ grid-template-columns: 1fr/);
});

test('database edits only active standalone manual vouchers and audits every change', () => {
  assert.match(migration, /actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(migration, /COALESCE\(entry\.transaction_type, ''\) NOT IN \('manual_thu', 'manual_chi'\)/);
  for (const link of ['customer_id', 'order_id', 'sales_return_id', 'supplier_id', 'purchase_id', 'purchase_payment_id', 'reversal_of_id']) {
    assert.match(migration, new RegExp(`entry\\.${link} IS NOT NULL`));
  }
  assert.match(migration, /INSERT INTO public\.audit_logs[\s\S]*'cashbook_transactions', 'UPDATE'/);
  assert.doesNotMatch(migration, /UPDATE public\.(customers|suppliers|orders|payments|customer_debt_transactions|supplier_debt_transactions)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_update_manual_cashbook_transaction\(text, jsonb\)[\s\S]*FROM PUBLIC, anon/);
});
