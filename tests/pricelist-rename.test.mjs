import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('Admin and Accounting can open price-list editing directly from the matrix heading', () => {
  const source = read('js/components/pricelists.js');
  const matrixHeader = source.slice(
    source.indexOf('const selectedLists = sortPriceLists'),
    source.indexOf('const allProducts = getFilteredMatrixProducts')
  );
  const setup = source.slice(source.indexOf('export function setupPricelistManagement'));

  assert.match(matrixHeader, /price-matrix-edit-price-list/);
  assert.match(matrixHeader, /canManagePriceLists\(\)/);
  assert.match(setup, /matrixHead\.addEventListener\('click'/);
  assert.match(setup, /openPricelistModal\(index\)/);
  assert.match(source, /function canManagePriceLists\(\)\s*\{\s*return isPrivilegedPricingRole\(state\.currentUser\);/);
});

test('renaming preserves the price-list identity and existing brand discounts', () => {
  const source = read('js/components/pricelists.js');
  const save = source.slice(source.indexOf('export async function savePricelist'), source.indexOf('export async function savePriceMatrix'));

  assert.match(save, /const id = index === -1 \? `pl-\$\{Date\.now\(\)\}` : editId/);
  assert.match(save, /brandDiscounts: existingPriceList\?\.brandDiscounts \|\| \{\}/);
  assert.match(save, /if \(!priceList\.name\) \{[\s\S]*?showToast\('Vui lòng nhập tên bảng giá\.'/);
  assert.match(save, /if \(!\(await dbSavePricelist\(priceList\)\)\) return;/);
});
