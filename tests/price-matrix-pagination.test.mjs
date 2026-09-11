import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('state defines pagination attributes for price matrix', () => {
  const stateContent = read('js/state.js');
  assert.match(stateContent, /priceMatrixPage:\s*1/);
  assert.match(stateContent, /priceMatrixPageSize:\s*25/);
});

test('index.html contains the price matrix pagination container', () => {
  const htmlContent = read('index.html');
  assert.match(htmlContent, /<div\s+id="price-matrix-pagination"><\/div>/);
});

test('pricelists component implements pagination controls and slicing', () => {
  const pricelistsContent = read('js/components/pricelists.js');

  // Renders pagination UI
  assert.match(pricelistsContent, /function renderPriceMatrixPagination\(totalItems, totalPages\)/);
  assert.match(pricelistsContent, /id="price-matrix-prev-page"/);
  assert.match(pricelistsContent, /id="price-matrix-next-page"/);
  assert.match(pricelistsContent, /id="price-matrix-page-size"/);

  // Slices allProducts according to page and pageSize
  assert.match(pricelistsContent, /const allProducts = getFilteredMatrixProducts\(\);/);
  assert.match(pricelistsContent, /const products = allProducts\.slice\(startIndex, startIndex \+ pageSize\);/);

  // Page navigation updates state and re-renders
  assert.match(pricelistsContent, /state\.priceMatrixPage -= 1/);
  assert.match(pricelistsContent, /state\.priceMatrixPage \+= 1/);
  assert.match(pricelistsContent, /state\.priceMatrixPageSize = Number\(event\.target\.value\)/);

  // Search & filter resets to page 1
  assert.match(pricelistsContent, /state\.priceMatrixPage = 1/);
});

test('excel export preserves all filtered products rather than only the current page', () => {
  const pricelistsContent = read('js/components/pricelists.js');

  // exportPriceMatrixExcel calls getFilteredMatrixProducts directly
  const exportFnStart = pricelistsContent.indexOf('export function exportPriceMatrixExcel()');
  assert.ok(exportFnStart !== -1, 'exportPriceMatrixExcel function must exist');
  const exportFnEnd = pricelistsContent.indexOf('export function', exportFnStart + 20);
  const exportFnBody = pricelistsContent.slice(exportFnStart, exportFnEnd !== -1 ? exportFnEnd : undefined);

  assert.match(exportFnBody, /const products = getFilteredMatrixProducts\(\);/);
  assert.doesNotMatch(exportFnBody, /products\.slice\(/, 'Excel export should not slice the products list by pagination');
});

test('page size select has proper width and right-padding to avoid overlapping the dropdown arrow', () => {
  const pricelistsContent = read('js/components/pricelists.js');
  const styleContent = read('style.css');

  assert.match(pricelistsContent, /price-matrix-page-size-select/);
  assert.match(styleContent, /select#price-matrix-page-size[\s\S]*?padding:\s*0\.2rem\s+1\.75rem/);
  assert.match(styleContent, /select#price-matrix-page-size[\s\S]*?width:\s*78px/);
});
