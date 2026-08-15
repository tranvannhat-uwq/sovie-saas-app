import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

test('0013 keeps old RPCs and routes cancellation through one secured classifier', async () => {
  const sql = await read('migrations/0013_legacy_cashbook_customer_and_order_compatibility.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.p13_classify_cashbook/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_cancel_cashbook_entry/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_cancel_cashbook_transaction/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_cancel_customer_payment/);
  assert.match(sql, /SET search_path = pg_catalog, public/g);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.rpc_cancel_cashbook_entry\(text, text\) FROM PUBLIC, anon/);
  assert.match(sql, /customer_debt_receipt/);
  assert.match(sql, /sale_receipt/);
  assert.match(sql, /supplier_payment/);
  assert.match(sql, /other_receipt/);
  assert.doesNotMatch(sql, /DELETE FROM public\.(customers|orders|cashbook_transactions|payments|suppliers)/);
  assert.doesNotMatch(sql, /(inventory|finished_goods_stock|production_logs)/i);
});

test('customer profile persistence is a non-financial whitelist', async () => {
  const service = await read('js/services/supabase.js');
  const mapper = service.slice(service.indexOf('function mapCustomerToDbRow'), service.indexOf('export async function dbSaveCustomer'));
  for (const forbidden of ['debt:', 'total_transaction:', 'total_return:', 'net_revenue:', 'debt_history:', 'last_order_at:', 'last_payment_at:']) {
    assert.equal(mapper.includes(forbidden), false, `profile payload leaked ${forbidden}`);
  }
  const html = await read('index.html');
  assert.match(html, /id="cust-debt"[^>]*readonly/);
});

test('cashbook UI never guesses the financial route', async () => {
  const ui = await read('js/components/so_quy.js');
  const service = await read('js/services/supabase.js');
  assert.match(ui, /dbCancelCashbookEntry/);
  assert.doesNotMatch(ui, /isCustomerDebtReceipt\(t\)/);
  assert.match(service, /rpc_cancel_cashbook_entry/);
  assert.match(service, /missingCompatibilityRpc/);
  assert.doesNotMatch(service, /isCustomerDebtReceipt\(transaction/);
});

test('market pricing exposes line discount input but agent invoice never prints its percentage', async () => {
  const html = await read('index.html');
  const invoice = await read('js/components/invoice.js');
  const history = await read('js/components/history.js');
  assert.match(html, /id="invoice-discount-header"[^>]*>Chiết khấu \(%\)<\/th>/);
  assert.match(invoice, /supportsInvoiceLineDiscount/);
  assert.match(invoice, /class="form-control-inline item-discount"/);
  assert.match(history, /const orderPriceListId = order\.pricelistId \|\| 'retail'/);
  assert.match(history, /plSelect\.value = orderPriceListId/);
  assert.match(history, /new CustomEvent\('loadDraftOrder'/);
  assert.doesNotMatch(invoice, /item\.discountPercent[^\n]*%<\/td>/);
  assert.match(invoice, /Chiết khấu bán hàng\$\{order\.discountType === 'percent'/);
  assert.match(invoice, /discountMultiplier/); // calculation remains intact
  assert.match(invoice, /discountAmount/);
});

test('purchase table uses the full scoped layout and all ten columns', async () => {
  const css = await read('style.css');
  const purchases = await read('js/components/purchases.js');
  assert.match(css, /\.purchase-page\s*\{[^}]*width:\s*100%/s);
  assert.match(css, /\.purchase-table\s*\{[^}]*min-width:\s*1120px/s);
  assert.match(purchases, /colspan="10"/);
  for (const header of ['Mã phiếu', 'Ngày mua', 'Số hóa đơn', 'Nhà cung cấp', 'Tổng tiền', 'Đã thanh toán', 'Còn nợ', 'Trạng thái', 'Người tạo', 'Thao tác']) {
    assert.match(purchases, new RegExp(header));
  }
});
