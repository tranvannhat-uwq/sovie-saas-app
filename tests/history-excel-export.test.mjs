import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('history Excel export preserves the visible order date range', () => {
  const customers = read('js/components/customers.js');
  const openStart = customers.indexOf('export function openHistoryOrderExportModal');
  const openEnd = customers.indexOf('function closeCustomerOrderExportModal', openStart);
  const open = customers.slice(openStart, openEnd);

  assert.match(open, /rangeMode\.value = 'current_filter'/);
  assert.match(open, /selectedOrderIds\.length > 0[\s\S]*?selectedOrderIds\.map\(String\)[\s\S]*?: null/);
  assert.match(open, /activeExportOrderIds = selectedIds/);
  assert.match(open, /datedOrders[\s\S]*?getVnDateInputValueFromDate/);
  assert.match(open, /customRange\.style\.display = 'none'/);
  assert.doesNotMatch(open, /rangeMode\.value = 'last_month'/);
  assert.match(customers, /if \(mode === 'current_filter'\)[\s\S]*?label: 'BoLocLichSuDon'/);
});

test('history Excel export keeps guest and legacy orders and reports failures', () => {
  const customers = read('js/components/customers.js');
  const exportStart = customers.indexOf('async function exportCustomerOrderHistoryExcel');
  const exportEnd = customers.indexOf('function getCustomerDebtSource', exportStart);
  const exporter = customers.slice(exportStart, exportEnd);

  assert.match(exporter, /const isHistoryExport = Array\.isArray\(activeExportOrders\)/);
  assert.match(exporter, /name: order\.customerName \|\| order\.customer_name \|\| 'Khách lẻ'/);
  assert.match(exporter, /if \(!globalThis\.XLSX\)/);
  assert.match(exporter, /catch \(error\)[\s\S]*?Không thể xuất Excel lịch sử đơn hàng/);
  assert.match(customers, /order\.items\.length > 0 \? order\.items : \[\{\}\]/);
});

test('history Excel export emits exactly one row per order', () => {
  const customers = read('js/components/customers.js');

  assert.match(customers, /function buildHistoryOrderExportRow\(order, customer\)/);
  assert.match(customers, /HISTORY_ORDER_ITEM_EXPORT_COLUMNS\.forEach/);
  assert.match(customers, /\.map\(row => row\[column\] \?\? ''\)\s*\.join\('\\n'\)/);
  assert.match(customers, /if \(isHistoryExport\)[\s\S]*?buildHistoryOrderExportRow\(order, customer\)/);
  assert.match(customers, /Đã xuất \$\{exportRows\.length\} đơn hàng, mỗi đơn một dòng\./);
});
