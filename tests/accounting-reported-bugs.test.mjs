import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('invoice Excel action previews parsed rows and saves selected invoices as drafts', () => {
  const invoice = read('js/components/invoice.js');
  const service = read('js/services/supabase.js');
  assert.match(invoice, /sheet_to_json\([^\n]+header: 1/);
  assert.match(invoice, /parseInvoiceImportRows\(usableSheets\[0\]\.rows\)/);
  assert.match(invoice, /invoiceImportGroupReady\(group, pending\.mappings\)/);
  assert.match(invoice, /dbCreateImportedInvoiceDraft\(order, marker\)/);
  assert.match(invoice, /Lưu thành đơn nháp/);
  assert.doesNotMatch(invoice, /Đã nạp file Excel .* thành công/);
  assert.match(service, /status: 'draft'/);
  assert.match(service, /Only Admin|Chỉ Admin hoặc Kế toán/);
  assert.doesNotMatch(service.slice(service.indexOf('export async function dbCreateImportedInvoiceDraft'), service.indexOf('export async function dbDeleteOrder')), /rpc_confirm_order|addCashbookTransaction|dbRecordCustomerPayment/);
});

test('purchase entry keeps save actions reachable and lets accounting reuse or type item codes', () => {
  const purchases = read('js/components/purchases.js');
  const base = read('styles/base.css');
  const app = read('styles/app.css');
  assert.match(purchases, /list="purchase-entry-code-list"/);
  assert.match(purchases, /Mã mới nhập trực tiếp sẽ có trong gợi ý sau khi lưu phiếu/);
  assert.match(purchases, /finally \{\s*formButtons\.forEach\(button => \{ button\.disabled = false; \}\);/);
  assert.match(base, /\.purchase-entry-modal-content\s*\{[^}]*display:\s*flex/);
  assert.match(base, /\.purchase-entry-modal-body\s*\{[^}]*overflow-y:\s*auto/);
  assert.match(app, /#app-layout #purchase-entry-modal \.purchase-entry-modal-content \.modal-footer\s*\{\s*flex-shrink:\s*0/);
});

test('migration 0107 validates per-line VAT before recording the exact source total', () => {
  const migration = read('migrations/0107_order_vat_invoice_details.sql');
  assert.match(migration, /vat_rounding_mode = 'line'/);
  assert.match(migration, /lineTaxBases/);
  assert.match(migration, /lineTaxAmounts/);
  assert.match(migration, /round\(line_base \* \(requested_vat_details->>'rate'\)::numeric \/ 100\)/);
  assert.match(migration, /effective_order := jsonb_set\(effective_order, '\{otherFeeType\}', to_jsonb\('amount'::text\), true\)/);
});
