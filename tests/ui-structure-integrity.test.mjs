import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const users = fs.readFileSync(path.join(root, 'js/components/users.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const uiSystem = fs.readFileSync(path.join(root, 'ui-system.css'), 'utf8');

test('all navigation targets exist exactly once', () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  const counts = new Map(ids.map(id => [id, ids.filter(item => item === id).length]));
  const duplicates = [...counts].filter(([, count]) => count > 1).map(([id]) => id);
  assert.deepEqual(duplicates, []);

  const targets = [...new Set([...html.matchAll(/data-target="([^"]+)"/g)].map(match => match[1]))];
  assert.deepEqual(targets.filter(target => !counts.has(target)), []);
});

test('deferred payroll and legacy warehouse modules are not navigation destinations', () => {
  const navigationStart = html.indexOf('<nav class="app-navigation"');
  const visibleNavigation = html.slice(navigationStart, html.indexOf('</nav>', navigationStart));
  assert.match(visibleNavigation, /style="display: none;"[^>]*data-feature-status="deferred"[\s\S]*data-target="payroll-panel"/);
  assert.doesNotMatch(visibleNavigation, /goods-inventory-subpanel|goods-production-subpanel/);
});

test('application navigation and login dialog use valid accessible structure', () => {
  assert.match(html, /<nav class="app-navigation" aria-label="Điều hướng nghiệp vụ">\s*<ul class="nav-menu">/);
  assert.match(html, /id="login-screen"[^>]*role="dialog"[^>]*aria-labelledby="login-title"/);
  assert.match(html, /<h1 id="login-title">/);
});

test('authenticated shell exposes a consistent role-aware visual system', () => {
  assert.match(html, /id="header-role-chip"/);
  assert.match(users, /appLayout\.dataset\.uiRole = visualRole/);
  assert.match(css, /#app-layout\[data-ui-role="accounting"\]/);
  assert.match(css, /#app-layout\[data-ui-role="sale"\]/);
  assert.match(css, /SOVIE PROFESSIONAL OPERATIONS UI/);
  assert.match(uiSystem, /SOVIE MODERN LIGHT/);
  assert.match(uiSystem, /linear-gradient\(112deg, rgba\(255,255,255,\.99\).*#e7f9f1 100%\)/);
  assert.match(uiSystem, /#app-layout \.nav-link\.active/);
  assert.match(uiSystem, /#app-layout \.platform-summary-card\.is-attention/);
});
