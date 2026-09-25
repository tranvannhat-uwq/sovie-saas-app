import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const invoice = fs.readFileSync(path.join(root, 'js/components/invoice.js'), 'utf8');
const goods = fs.readFileSync(path.join(root, 'js/components/goods.js'), 'utf8');
const supabase = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');

test('active order and SKU picker have no inventory dependency', () => {
  assert.doesNotMatch(invoice, /finishedGoodsStock|getVariantStock|Tồn kho/);
});

test('goods navigation activates purchases without legacy inventory listeners', () => {
  assert.match(goods, /export function renderGoodsPanel\(\)[\s\S]*renderPurchasesPanel\(panel\)/);
  assert.doesNotMatch(goods, /setupGoodsPanel|goods-main-tab-btn|inventory-subpanel|production-subpanel/);
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const goodsPanel = html.match(/<section id="goods-panel"[\s\S]*?<\/section>/)?.[0] || '';
  assert.match(goodsPanel, /purchase-loading-state/);
  assert.doesNotMatch(goodsPanel, /goods-inventory-subpanel|goods-production-subpanel|raw-materials-table-body/);
  const main = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');
  assert.match(main, /'goods-panel': \['goods-panel',[^\]]*Đang tải phiếu mua hàng/);
});

test('purchase details keep presentation in stylesheet classes', () => {
  const purchases = fs.readFileSync(path.join(root, 'js/components/purchases.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'styles/app.css'), 'utf8');
  const harness = fs.readFileSync(path.join(root, 'tests/purchases-ui-harness.html'), 'utf8');
  assert.doesNotMatch(purchases, /\sstyle=/);
  assert.match(css, /\.purchase-template-detail[\s\S]*\.purchase-template-payment-row/);
  assert.match(harness, /state\.js\?v=20260924-ui-cleanup-v3/);
  assert.match(harness, /purchases\.js\?v=20260924-ui-cleanup-v3/);
});

test('normal Cloud loading does not fetch inventory or production tables', () => {
  const start = supabase.indexOf('const secondaryLoad = Promise.all(');
  const promiseAll = supabase.slice(start, supabase.indexOf(']);', start) + 3);
  assert.doesNotMatch(promiseAll, /fetchRawMaterials|fetchSemiFinished|fetchRecipes|fetchProductionLogs|fetchFinishedGoodsStock/);
  assert.match(promiseAll, /fetchPurchases/);
  assert.match(promiseAll, /leanBootstrap \? \[\] :/);
});
