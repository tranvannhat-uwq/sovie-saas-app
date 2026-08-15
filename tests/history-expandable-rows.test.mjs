import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const history = fs.readFileSync(path.join(root, 'js/components/history.js'), 'utf8');
const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const tableBranch = history.slice(
  history.indexOf("if (state.historyViewMode === 'details')"),
  history.indexOf('// ---------------------- DẠNG THẺ')
);

test('details table renders one accessible expandable row pair per order', () => {
  assert.match(tableBranch, /class="history-order-row\$\{isExpanded/);
  assert.match(tableBranch, /tabindex="0" role="button" aria-expanded="\$\{isExpanded\}" aria-controls="\$\{detailId\}"/);
  assert.match(tableBranch, /class="history-expanded-row\$\{isExpanded/);
  assert.match(tableBranch, /<td colspan="11">/);
  assert.doesNotMatch(tableBranch, />Thao tác<\/th>/);
  assert.doesNotMatch(tableBranch, /class="history-row-toggle"/);
  assert.match(tableBranch, />KDQL<\/th>/);
  assert.match(tableBranch, /getManagerDisplayName\(managerValue, state\.users\)/);
});

test('expanded panel uses real notes, payment fields and existing action handlers', () => {
  assert.match(tableBranch, /renderHistoryExpandedItems\(order\)/);
  assert.match(tableBranch, /placeholder="Nhập ghi chú cho đơn hàng này\.\.\."/);
  assert.match(tableBranch, /escapeHistoryHtml\(order\.notes \|\| ''\)/);
  assert.match(tableBranch, /paymentSummary\.totalGoods/);
  assert.match(tableBranch, /paymentSummary\.invoiceDiscount/);
  assert.match(tableBranch, /paymentSummary\.shippingFeeAmount/);
  assert.match(tableBranch, /paymentSummary\.customerPayable/);
  assert.match(tableBranch, /paymentSummary\.paidAmount/);
  for (const action of ['notes', 'edit', 'copy', 'print', 'return', 'cancel', 'delete']) {
    assert.match(tableBranch, new RegExp(`history-${action}-btn`));
  }
  assert.doesNotMatch(history, /history-view-btn/);
  assert.match(history, /dbUpdateOrderNotes\(order\.id, nextNotes\.trim\(\), order\.status === 'draft'\)/);
  assert.doesNotMatch(tableBranch, /on(?:click|change|input)=/);
});

test('expanded panel renders the full product list without requiring the view action', () => {
  assert.match(history, /function renderHistoryExpandedItems\(order\)/);
  assert.match(history, /Danh sách sản phẩm/);
  for (const heading of ['Mã hàng', 'Tên hàng', 'Mã màu', 'Số lượng', 'Đơn giá', 'Giá bán', 'Thành tiền']) {
    assert.match(history, new RegExp(heading));
  }
  assert.match(history, /colorCode: item\?\.colorCode \|\| item\?\.color_code \|\| ''/);
  assert.match(history, /history-product-color[^>]*>\$\{escapeHistoryHtml\(values\.colorCode \|\| '—'\)\}/);
  const productTable = history.slice(history.indexOf('function renderHistoryExpandedItems'), history.indexOf('function populateHistoryCompanyAndBrandFilters'));
  assert.doesNotMatch(productTable, /<th>Giảm giá<\/th>/);
  assert.match(history, /item\?\.variantCode \|\| item\?\.variantCodeSnapshot \|\| item\?\.productCode/);
  assert.match(history, /item\?\.lineTotal \?\? item\?\.total/);
  assert.match(styles, /\.history-expanded-products\s*\{[\s\S]*grid-column:\s*1 \/ -1/);
  assert.match(styles, /\.history-expanded-products-scroll\s*\{[\s\S]*overflow-x:\s*auto/);
  assert.match(styles, /\.history-expanded-products-table th:nth-child\(3\)\s*\{[\s\S]*text-align:\s*center/);
  assert.match(styles, /\.history-product-color\s*\{[\s\S]*text-align:\s*center/);
});

test('accordion keeps one row open and isolates interactive controls', () => {
  assert.match(history, /let expandedHistoryOrderId = null/);
  assert.match(history, /expandedHistoryOrderId === normalizedId \? null : normalizedId/);
  assert.match(history, /!visibleOrderIds\.has\(String\(expandedHistoryOrderId \|\| ''\)\)/);
  assert.match(history, /\['Enter', ' '\]\.includes\(event\.key\)/);
  assert.match(history, /history-export-checkbox[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(history, /history-expanded-panel button, \.history-expanded-panel textarea/);
});

test('expanded detail has a scoped animated responsive layout', () => {
  assert.match(styles, /\.history-expanded-motion\s*\{[\s\S]*grid-template-rows:\s*0fr[\s\S]*0\.22s/);
  assert.match(styles, /\.history-expanded-row\.is-expanded \.history-expanded-motion\s*\{[\s\S]*grid-template-rows:\s*1fr/);
  assert.match(styles, /\.history-expanded-panel\s*\{[\s\S]*grid-template-columns:[^;]*1\.7fr/);
  assert.match(styles, /@media \(max-width: 1100px\)[\s\S]*\.history-expanded-panel/);
  assert.match(styles, /@media \(max-width: 700px\)[\s\S]*\.history-expanded-panel[\s\S]*grid-template-columns:\s*minmax\(0, 1fr\)/);
});
