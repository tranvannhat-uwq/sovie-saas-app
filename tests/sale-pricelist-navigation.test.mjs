import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const users = fs.readFileSync(path.join(root, 'js/components/users.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');

test('sale navigation hides product-list and price-list management pages', () => {
  const permissions = users.slice(
    users.indexOf('export function applyUserPermissions'),
    users.indexOf('export function setupUserManagement')
  );
  const saleVisibleTargets = permissions.match(/if \(target === 'invoice-panel'[\s\S]*?\) \{/)?.[0] || '';

  assert.doesNotMatch(saleVisibleTargets, /pricelists-panel/);
  assert.doesNotMatch(saleVisibleTargets, /products-panel/);
  assert.match(main, /state\.currentUser\?\.role === 'sale' && \['products-panel', 'pricelists-panel'\]\.includes\(panelId\)[\s\S]{0,100}panelId = 'invoice-panel'/);
});
