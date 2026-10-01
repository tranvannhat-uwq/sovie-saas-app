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
  assert.match(exporter, /await loadExcelJS\(\)/);
  assert.match(exporter, /catch \(error\)[\s\S]*?Không thể xuất Excel lịch sử đơn hàng/);
  assert.match(customers, /function getExportItems\(record\)/);
  assert.match(customers, /record\?\.order_items/);
});

test('history export keeps a one-row order summary and adds one row per product detail', () => {
  const customers = read('js/components/customers.js');

  assert.match(customers, /function buildHistoryOrderExportRow\(order, customer\)/);
  assert.match(customers, /HISTORY_ORDER_ITEM_EXPORT_COLUMNS\.forEach/);
  assert.match(customers, /\.map\(row => row\[column\] \?\? ''\)\s*\.join\('\\n'\)/);
  assert.match(customers, /const summaryRows = \[\]/);
  assert.match(customers, /const productDetailRows = \[\]/);
  assert.match(customers, /productDetailRows\.push\(\.\.\.prepareHistoryItemDetailRows\(orderDetailRows\)\)/);
  assert.match(customers, /buildHistoryExportWorksheet\(workbook, 'Chi tiết mặt hàng'/);
  assert.match(customers, /HISTORY_EXPORT_SUMMARY_ONLY_COLUMNS\.forEach/);
  assert.match(customers, /productLineCount \+= orderItems\.length/);
});

test('history export fixes source order ids and resolves auth ids to display names', () => {
  const customers = read('js/components/customers.js');

  assert.match(customers, /'Mã đơn hàng gốc': ''/);
  assert.match(customers, /getUserDisplayName\(userReference, '', state\.users \|\| \[\]\)/);
  assert.match(customers, /Không xác định/);
  assert.match(customers, /getDisplayUserName\(order\.salespersonId \|\| order\.salesperson_id/);
});

test('history Excel workbook is styled and configured for readable multi-page printing', () => {
  const customers = read('js/components/customers.js');

  assert.match(customers, /EXCELJS_CDN_INTEGRITY = 'sha384-/);
  assert.match(customers, /HISTORY_EXPORT_GROUP_COLORS/);
  assert.match(customers, /cell\.fill = \{ type: 'pattern', pattern: 'solid'/);
  assert.match(customers, /state: 'frozen', xSplit: 1, ySplit: 1, showGridLines: false/);
  assert.match(customers, /orientation: 'landscape'[\s\S]*?fitToWidth: 1[\s\S]*?fitToHeight: 0/);
  assert.match(customers, /worksheet\.pageSetup\.printTitlesRow = '1:1'/);
  assert.match(customers, /worksheet\.autoFilter =/);
});
