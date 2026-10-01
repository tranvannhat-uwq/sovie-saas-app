import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const service = fs.readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');

test('purchase records, lines and payments are loaded through stable complete pagination', () => {
  const purchaseLoader = service.slice(
    service.indexOf('const fetchPurchases = async () => {'),
    service.indexOf('const fetchRawMaterials = async () => {')
  );
  assert.equal((purchaseLoader.match(/collectAllPages\(/g) || []).length, 3);
  assert.match(purchaseLoader, /order\('purchase_date', \{ ascending: false \}\)\s*\.order\('id', \{ ascending: true \}\)/);
  assert.match(purchaseLoader, /order\('purchase_id', \{ ascending: true \}\)[\s\S]*order\('line_number', \{ ascending: true \}\)[\s\S]*order\('id', \{ ascending: true \}\)/);
  assert.match(purchaseLoader, /order\('created_at', \{ ascending: true \}\)\s*\.order\('id', \{ ascending: true \}\)/);
  assert.match(purchaseLoader, /const \[purchaseRows, itemRows, paymentRows\] = await Promise\.all/);
  assert.match(purchaseLoader, /state\.purchases = purchaseRows\.map/);
});

test('large assigned price lists avoid repeated exact counts and have stable row ordering', () => {
  const pageLoader = service.slice(
    service.indexOf('async function fetchPriceListItemsForIds'),
    service.indexOf('function mapAuthorizedPriceList', service.indexOf('async function fetchPriceListItemsForIds'))
  );
  const fallback = service.slice(
    service.indexOf('if (itemRows === null)'),
    service.indexOf('const items = (itemRows || [])', service.indexOf('if (itemRows === null)'))
  );
  assert.match(pageLoader, /\.select\(PRICE_LIST_ITEM_READ_COLUMNS\)/);
  assert.match(pageLoader, /\.order\('id', \{ ascending: true \}\)/);
  assert.doesNotMatch(pageLoader, /count:\s*'exact'/);
  assert.match(fallback, /fetchPriceListItemsForIds\(\[priceList\.id\]\)/);
  assert.doesNotMatch(fallback, /count:\s*'exact'|\.select\('\*'/);
});

test('all-table reads and supplier reads use stable complete pagination', () => {
  const allTableLoader = service.slice(
    service.indexOf('async function fetchFullTableData'),
    service.indexOf('const CUSTOMER_LIST_COLUMNS', service.indexOf('async function fetchFullTableData'))
  );
  const supplierLoader = service.slice(
    service.indexOf('const fetchSuppliers = async () => {'),
    service.indexOf('const fetchPurchases = async () => {')
  );
  assert.match(allTableLoader, /collectAllPages[\s\S]*order\('id', \{ ascending: true \}\)/);
  assert.match(supplierLoader, /collectAllPages[\s\S]*order\('name', \{ ascending: true \}\)[\s\S]*order\('id', \{ ascending: true \}\)/);

  const productLoader = service.slice(
    service.indexOf('const fetchProducts = async () => {'),
    service.indexOf('const fetchOrders = async () => {')
  );
  const brandLoader = service.slice(
    service.indexOf('const fetchBrands = async () => {'),
    service.indexOf('const fetchCashbook = async () => {')
  );
  assert.match(productLoader, /collectAllPages[\s\S]*order\('code', \{ ascending: true \}\)[\s\S]*order\('id', \{ ascending: true \}\)[\s\S]*range\(offset, end\)/);
  assert.match(brandLoader, /collectAllPages[\s\S]*order\('name', \{ ascending: true \}\)[\s\S]*order\('id', \{ ascending: true \}\)[\s\S]*range\(offset, end\)/);
});
