import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getNavigationTheme, normalizeNavigationColor, normalizeNavigationLayout } from '../js/domain/navigation-theme.js';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('navigation colors normalize safely and retain readable contrast', () => {
  assert.equal(normalizeNavigationColor('#ABC'), '#aabbcc');
  assert.equal(normalizeNavigationColor('not-a-color'), '#0b365f');
  assert.equal(getNavigationTheme('#ffffff').foreground, '#0f172a');
  assert.equal(getNavigationTheme('#0e59f2').foreground, '#ffffff');
});

test('navigation layout accepts only the two supported persistent modes', () => {
  assert.equal(normalizeNavigationLayout('vertical'), 'vertical');
  assert.equal(normalizeNavigationLayout('horizontal'), 'horizontal');
  assert.equal(normalizeNavigationLayout('unsupported'), 'vertical');
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
