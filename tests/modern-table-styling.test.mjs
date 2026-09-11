import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('style.css defines modern table system with code chips, role badges, and amounts', () => {
  const css = read('style.css');

  // Table code chips
  assert.match(css, /\.table-code-chip/);
  assert.match(css, /\.code-chip-order/);
  assert.match(css, /\.code-chip-receipt/);
  assert.match(css, /\.code-chip-payment/);
  assert.match(css, /\.code-chip-customer/);
  assert.match(css, /\.code-chip-product/);
  assert.match(css, /\.code-chip-user/);

  // Role badges
  assert.match(css, /\.role-badge\.role-owner/);
  assert.match(css, /\.role-badge\.role-admin/);
  assert.match(css, /\.role-badge\.role-accounting/);
  assert.match(css, /\.role-badge\.role-sales/);

  // Modern headers and row hovers for the 6 core panels
  assert.match(css, /#history-panel \.table thead th/);
  assert.match(css, /#so-quy-panel \.table thead th/);
  assert.match(css, /#customers-panel \.table thead th/);
  assert.match(css, /#products-panel \.table thead th/);
  assert.match(css, /#pricelists-panel \.table thead th/);
  assert.match(css, /#users-panel \.table thead th/);
});

test('customers component fixes white-text bug and uses modern code chip', () => {
  const customersJs = read('js/components/customers.js');

  assert.doesNotMatch(customersJs, /data-customer-column="code" style="[^"]*color:\s*#fff/);
  assert.match(customersJs, /class="table-code-chip code-chip-customer"/);
});

test('users component fixes white-text bug and uses modern code chip', () => {
  const usersJs = read('js/components/users.js');

  assert.doesNotMatch(usersJs, /style="[^"]*color:\s*#fff[^"]*"[^>]*title="\$\{u\.username\}"/);
  assert.match(usersJs, /class="table-code-chip code-chip-user"/);
});

test('history component uses modern code chip and financial styling', () => {
  const historyJs = read('js/components/history.js');

  assert.match(historyJs, /class="table-code-chip code-chip-order"/);
  assert.match(historyJs, /table-amount-positive/);
  assert.match(historyJs, /table-amount-warning/);
});

test('cashbook component uses modern transaction chips and pill amounts', () => {
  const soQuyJs = read('js/components/so_quy.js');

  assert.match(soQuyJs, /table-code-chip \$\{isReceipt \? 'code-chip-receipt' : 'code-chip-payment'\}/);
  assert.match(soQuyJs, /table-amount-pill \$\{isReceipt \? 'is-positive' : 'is-negative'\}/);
});

test('products and pricelists components use modern product code chips', () => {
  const productsJs = read('js/components/products.js');
  const pricelistsJs = read('js/components/pricelists.js');

  assert.match(productsJs, /class="table-code-chip code-chip-product"/);
  assert.match(pricelistsJs, /class="table-code-chip code-chip-product"/);
});
