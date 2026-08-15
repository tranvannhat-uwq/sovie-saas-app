import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const html = read('index.html');
const customerUi = read('js/components/customers.js');
const styles = read('style.css');

test('customer debt history includes a clickable source-document column and detail modal', () => {
  const historyTable = html.slice(html.indexOf('detail-debt-history-body') - 1800, html.indexOf('detail-debt-history-body') + 200);
  assert.match(historyTable, /<colgroup>[\s\S]*<th>[^<]*ch[^<]*ng t[^<]*<\/th>/i);
  assert.match(html, /id="customer-debt-source-modal"/);
  assert.match(html, /id="customer-debt-source-items"/);
  assert.match(customerUi, /class="customer-debt-source-link"/);
  assert.match(customerUi, /openCustomerDebtSourceDetail\(\{ kind: sourceKind, id: sourceId \}, historyEntry, cust\)/);
});

test('source links use database relations and refresh the authoritative source record', () => {
  const resolverStart = customerUi.indexOf('function getCustomerDebtSource');
  const resolverEnd = customerUi.indexOf('function debtSourceMeta', resolverStart);
  const resolver = customerUi.slice(resolverStart, resolverEnd);
  assert.match(resolver, /historyEntry\.orderId \|\| historyEntry\.order_id/);
  assert.match(resolver, /historyEntry\.cashbookTransactionId \|\| historyEntry\.cashbook_transaction_id/);
  assert.match(resolver, /historyEntry\.salesReturnId \|\| historyEntry\.sales_return_id/);
  assert.doesNotMatch(resolver, /note|description|match\(/);
  assert.match(customerUi, /await dbRefreshOrderById\(source\.id\)/);
  assert.match(customerUi, /await dbFetchCashbookTransactionById\(source\.id\)/);
  assert.doesNotMatch(customerUi, /await dbFetchCashbookTransactions\(\)/);
});

test('source-document modal is read-only and does not alter debt workflows', () => {
  const modalStart = html.indexOf('id="customer-debt-source-modal"');
  const modalEnd = html.indexOf('id="customer-order-export-modal"', modalStart);
  const modal = html.slice(modalStart, modalEnd);
  assert.doesNotMatch(modal, /<(?:form|input|select|textarea)\b/i);

  const detailStart = customerUi.indexOf('async function openCustomerDebtSourceDetail');
  const detailEnd = customerUi.indexOf('export async function openCustomerDetailModal', detailStart);
  const detail = customerUi.slice(detailStart, detailEnd);
  assert.doesNotMatch(detail, /dbRecordCustomerPayment|dbAdjustCustomerDebt|dbSave|\.rpc\(/);
});

test('debt history keeps long document codes inside a compact non-overlapping layout', () => {
  assert.match(html, /class="modal-content customer-detail-modal-content"/);
  assert.match(html, /class="table-container customer-debt-history-scroll"/);
  assert.match(html, /class="table customer-debt-history-table"/);
  assert.match(customerUi, /function getCustomerDebtSourceDisplayCode/);
  assert.match(customerUi, /customer-debt-time-cell/);
  assert.match(styles, /\.customer-debt-history-table\s*\{[\s\S]*?min-width:\s*760px/);
  assert.match(styles, /\.customer-debt-source-link\s*\{[\s\S]*?max-width:\s*100%/);
  assert.match(styles, /\.customer-debt-source-link span\s*\{[\s\S]*?text-overflow:\s*ellipsis/);
});

test('customer detail export button uses the correct Vietnamese label', () => {
  const exportButton = html.match(/<button[^>]*id="btn-open-customer-order-export"[\s\S]*?<\/button>/)?.[0] || '';
  assert.match(exportButton, /Xuất Excel/);
  assert.doesNotMatch(exportButton, /Xu\?t Excel/);
});
