import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('the application keeps one horizontal navigation layout', () => {
  const html = read('index.html');
  const main = read('js/main.js');
  const component = read('js/components/navigation-theme.js');
  const css = read('styles/app.css');

  assert.match(html, /id="app-layout" data-nav-layout="horizontal"/);
  assert.doesNotMatch(html, /nav-layout-settings|nav-layout-option|data-nav-layout="vertical"/);
  assert.doesNotMatch(main, /setupNavigationColorSettings|applyNavigationLayout/);
  assert.doesNotMatch(component, /nav-layout-option|applyNavigationLayout/);
  assert.match(component, /localStorage\.removeItem\(key\)/);
  assert.match(component, /item\.classList\.toggle\('is-open', shouldOpen\)/);
  assert.match(component, /setAttribute\('aria-expanded', String\(shouldOpen\)\)/);
  assert.match(css, /#app-layout\[data-nav-layout="horizontal"\] \.sidebar/);
  assert.doesNotMatch(css, /data-nav-layout="vertical"|nav-layout-settings|nav-layout-option/);
});

test('horizontal navigation uses the SoVie gradient bar and Lucide SVG icons', () => {
  const html = read('index.html');
  const tokens = read('styles/base.css');
  const css = read('styles/app.css');

  assert.match(html, /styles\/app\.css\?v=20260924-ui-cleanup-v3/);
  assert.doesNotMatch(css, /Material Symbols Rounded|data-reference-icon\]::before/);
  assert.match(tokens, /--vi-primary:\s*#0057cd/);
  assert.match(tokens, /--vi-primary-container:\s*#006eff/);
  assert.match(css, /#app-layout\[data-nav-layout="horizontal"\] \.sidebar\s*\{[\s\S]*border-bottom:/);
  assert.match(css, /linear-gradient\(135deg, var\(--vi-primary\), var\(--vi-primary-container\)\)/);
  assert.match(css, /\.nav-link\.active > svg[\s\S]*color:\s*var\(--vi-on-primary\) !important/);
  assert.match(css, /backdrop-filter:\s*blur\(16px\)/);
});

test('navigation submenus stay usable and their harness initializes the dropdowns', () => {
  const css = read('styles/app.css');
  const harness = read('tests/navigation-theme-harness.html');
  assert.match(css, /#app-layout \.purchase-menu\s*\{[\s\S]*?min-width:\s*340px !important/);
  assert.match(css, /#app-layout \.staff-menu\s*\{[\s\S]*?min-width:\s*248px !important/);
  assert.doesNotMatch(harness, /nav-layout-settings|nav-color-settings/);
  assert.match(harness, /setupNavigationDropdowns\(\)/);
});
