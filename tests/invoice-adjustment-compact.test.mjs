import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const html = read('index.html');
const css = read('luminous-engine.css');

test('order adjustments use a simple compact two-row control', () => {
  assert.match(html, /class="summary-adjustments-simple"/);
  assert.match(html, />Giảm giá</);
  assert.match(html, />Thu khác</);
  assert.doesNotMatch(html, /Giảm giá thêm \/ Voucher/);
  assert.doesNotMatch(html, /Cước xe tải tận chân CT/);
  for (const id of [
    'invoice-discount-value',
    'invoice-discount-type',
    'invoice-shipping-fee-value',
    'summary-discount-actual',
    'summary-shipping-fee-actual'
  ]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(css, /\.summary-adjustments-simple \.summary-adjustment-row\s*\{[\s\S]*?background:\s*transparent/);
  assert.match(css, /\.summary-adjustments-simple \.adjustment-pill-input\s*\{[\s\S]*?width:\s*132px/);
  assert.match(css, /> #invoice-shipping-fee-value\s*\{[\s\S]*?width:\s*auto !important;[\s\S]*?min-width:\s*0 !important/);
  assert.match(css, /> \.pill-unit-tag\s*\{[\s\S]*?flex:\s*0 0 54px !important/);
});

test('quick customer action keeps its label on one line', () => {
  assert.match(css, /#app-layout #invoice-panel \.btn-info-card-add\s*\{[\s\S]*?width:\s*auto !important/);
  assert.match(css, /#app-layout #invoice-panel \.btn-info-card-add\s*\{[\s\S]*?white-space:\s*nowrap !important/);
});
