import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('customer form reports hidden searchable-select validation instead of silently blocking submit', () => {
  const html = read('index.html');
  const customers = read('js/components/customers.js');
  const css = read('style.css');
  assert.match(html, /<form id="customer-form" novalidate>/);
  assert.match(customers, /function validateCustomerForm\(\)/);
  assert.match(customers, /\['cust-province', 'Vui lòng chọn Tỉnh\/Thành phố\.'\]/);
  assert.match(customers, /querySelector\('\.searchable-select-trigger'\)/);
  assert.match(customers, /showToast\(message, 'warning'\)/);
  assert.match(css, /\.searchable-select-trigger\.customer-field-invalid/);
});
