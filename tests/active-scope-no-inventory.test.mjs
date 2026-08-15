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
  const setup = goods.slice(goods.indexOf('export function setupGoodsPanel()'));
  assert.ok(setup.indexOf('return;') < setup.indexOf("document.querySelectorAll('.goods-main-tab-btn')"));
});

test('normal Cloud loading does not fetch inventory or production tables', () => {
  const start = supabase.indexOf('const secondaryLoad = Promise.all(');
  const promiseAll = supabase.slice(start, supabase.indexOf(']);', start) + 3);
  assert.doesNotMatch(promiseAll, /fetchRawMaterials|fetchSemiFinished|fetchRecipes|fetchProductionLogs|fetchFinishedGoodsStock/);
  assert.match(promiseAll, /fetchPurchases/);
  assert.match(promiseAll, /leanBootstrap \? \[\] :/);
});
