import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getNavigationTheme, normalizeNavigationColor, normalizeNavigationLayout } from '../js/domain/navigation-theme.js';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('navigation colors normalize safely and retain readable contrast', () => {
  assert.equal(normalizeNavigationColor('#ABC'), '#aabbcc');
  assert.equal(normalizeNavigationColor('not-a-color'), '#0057cd');
  assert.equal(getNavigationTheme('#ffffff').foreground, '#0f172a');
  assert.equal(getNavigationTheme('#0e59f2').foreground, '#ffffff');
});

test('navigation layout accepts only the two supported persistent modes and defaults to horizontal', () => {
  assert.equal(normalizeNavigationLayout('vertical'), 'vertical');
  assert.equal(normalizeNavigationLayout('horizontal'), 'horizontal');
  assert.equal(normalizeNavigationLayout('unsupported'), 'horizontal');
});

test('gear menu keeps layout controls but hides obsolete navigation colour controls', () => {
  const html = read('index.html');
  const main = read('js/main.js');
  const component = read('js/components/navigation-theme.js');
  const css = read('style.css');
  const uiCss = read('ui-system.css');

  assert.doesNotMatch(html, /id="nav-color-settings"/);
  assert.doesNotMatch(html, /id="nav-color-picker"/);
  assert.doesNotMatch(html, /id="btn-reset-nav-color"/);
  assert.match(html, /id="nav-layout-settings"/);
  assert.match(html, /data-nav-layout="vertical"/);
  assert.match(html, /data-nav-layout="horizontal"/);
  assert.equal((html.match(/class="nav-color-swatch"/g) || []).length, 0);
  assert.match(component, /localStorage\.setItem\(NAV_COLOR_STORAGE_KEY, theme\.background\)/);
  assert.match(main, /setupNavigationColorSettings\(\);[\s\S]*setupNavigation\(\);/);
  assert.match(main, /setupNavigationDropdowns\(\)/);
  assert.match(component, /item\.classList\.toggle\('is-open', shouldOpen\)/);
  assert.match(component, /setAttribute\('aria-expanded', String\(shouldOpen\)\)/);
  assert.match(uiCss, /\.purchase-nav-item\.is-open[\s\S]*\.purchase-menu/);
  assert.match(css, /background-color: var\(--nav-background-color\)/);
  assert.match(css, /\.sidebar > \.nav-menu > \.nav-item > \.nav-link[\s\S]*var\(--nav-foreground-color\)/);
  assert.doesNotMatch(css, /\.sidebar \.nav-link\s*\{\s*color:\s*var\(--nav-foreground-color\)/);
  assert.match(css, /\.purchase-menu-link\s*\{[\s\S]*color:\s*var\(--text-primary\)/);
  assert.match(css, /\.staff-menu \.staff-menu-link\s*\{[\s\S]*color:\s*var\(--text-primary\)/);
  assert.match(read('tests/navigation-theme-harness.html'), /window\.__app_initialized\s*=\s*true/);
});

test('horizontal navigation uses the Luminous Engine glass bar and gradient active pill', () => {
  const html = read('index.html');
  const luminousCss = read('luminous-engine.css');
  assert.match(html, /luminous-engine\.css\?v=20260910-luminous-engine-v11-submenu-specificity/);
  assert.doesNotMatch(html, /Material\+Symbols|Material Symbols Rounded/);
  assert.match(luminousCss, /SoVie Luminous Engine/);
  assert.match(luminousCss, /--vi-primary:\s*#0057cd/);
  assert.match(luminousCss, /--vi-primary-container:\s*#006eff/);
  assert.match(luminousCss, /#app-layout\[data-nav-layout="horizontal"\] \.sidebar\s*\{[\s\S]*border-bottom:/);
  assert.match(luminousCss, /#app-layout\[data-nav-layout="horizontal"\] \.sidebar \.app-navigation > \.nav-menu > \.nav-item > \.nav-link\.active[\s\S]*linear-gradient\(135deg, var\(--vi-primary\), var\(--vi-primary-container\)\)/);
  assert.match(luminousCss, /#app-layout\[data-nav-layout="horizontal"\] \.sidebar \.app-navigation > \.nav-menu > \.nav-item > \.nav-link\s*,[\s\S]*color:\s*var\(--vi-on-surface-variant\) !important/);
  assert.match(luminousCss, /\.nav-link\.active > svg[\s\S]*color:\s*var\(--vi-on-primary\) !important/);
  assert.match(luminousCss, /animation:\s*none !important/);
  assert.match(luminousCss, /backdrop-filter:\s*blur\(16px\)/);
});

test('navigation submenus keep readable compact links on their light surface', () => {
  const luminousCss = read('luminous-engine.css');
  assert.match(luminousCss, /#app-layout\[data-nav-layout\] \.purchase-menu \.purchase-menu-link\.nav-link,\s*#app-layout\[data-nav-layout\] \.staff-menu \.staff-menu-link\.nav-link\s*\{[\s\S]*?color:\s*var\(--vi-on-surface\) !important/);
  assert.match(luminousCss, /#app-layout \.purchase-menu\s*\{[\s\S]*?min-width:\s*340px !important/);
  assert.match(luminousCss, /#app-layout \.staff-menu\s*\{[\s\S]*?min-width:\s*248px !important/);
});
