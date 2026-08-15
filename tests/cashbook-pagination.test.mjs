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

test('cashbook table provides page size and page navigation controls', () => {
  for (const id of [
    'so-quy-pagination', 'so-quy-pagination-summary', 'so-quy-page-size',
    'so-quy-first-page', 'so-quy-prev-page', 'so-quy-page-info',
    'so-quy-next-page', 'so-quy-last-page'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<option value="20">20<\/option>/);
  assert.match(html, /<option value="50">50<\/option>/);
  assert.match(html, /<option value="100">100<\/option>/);
});

test('cashbook renders only the current page while keeping totals over filtered data', () => {
  assert.match(cashbook, /let cashbookCurrentPage = 1/);
  assert.match(cashbook, /Math\.ceil\(totalItems \/ cashbookPageSize\)/);
  assert.match(cashbook, /const paginatedTransactions = filteredTransactions\.slice\(pageStart, pageStart \+ cashbookPageSize\)/);
  assert.match(cashbook, /tableBody\.innerHTML = paginatedTransactions\.map/);
  assert.match(cashbook, /const \{ filteredTransactions, stats \} = getProcessedData\(\)/);
});

test('cashbook pagination resets on filters and stays within valid pages', () => {
  assert.match(cashbook, /const filterSignature = JSON\.stringify\(activeFilters\)/);
  assert.match(cashbook, /filterSignature !== cashbookLastFilterSignature[\s\S]*cashbookCurrentPage = 1/);
  assert.match(cashbook, /Math\.min\(Math\.max\(1, cashbookCurrentPage\), cashbookTotalPages\)/);
  assert.match(cashbook, /changeCashbookPage\(cashbookCurrentPage - 1\)/);
  assert.match(cashbook, /changeCashbookPage\(cashbookCurrentPage \+ 1\)/);
});

test('cashbook pagination is responsive', () => {
  assert.match(css, /\.so-quy-pagination \{/);
  assert.match(css, /\.so-quy-pagination-controls \{/);
  assert.match(css, /@media \(max-width: 720px\)[\s\S]*\.so-quy-pagination \{[\s\S]*flex-direction: column/);
});
