import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('all navigation targets exist exactly once', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const counts = new Map(ids.map(id => [id, ids.filter(item => item === id).length]));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  assert.deepEqual(duplicates, []);

  const targets = [...new Set([...html.matchAll(/data-target="([^"]+)"/g)].map(match => match[1]))];
  assert.deepEqual(targets.filter(target => !counts.has(target)), []);
});

test('deferred payroll and legacy warehouse modules are not navigation destinations', () => {
  const visibleNavigation = html.slice(html.indexOf('<nav class="nav-menu">'), html.indexOf('</nav>'));
  assert.match(visibleNavigation, /style="display: none;"[^>]*data-feature-status="deferred"[\s\S]*data-target="payroll-panel"/);
  assert.doesNotMatch(visibleNavigation, /goods-inventory-subpanel|goods-production-subpanel/);
});
