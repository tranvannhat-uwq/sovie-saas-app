import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const layout = read('js/components/module-filter-layout.js');
const main = read('js/main.js');
const css = read('ui-system.css');

test('list and report modules use a shared left filter workspace', () => {
  for (const panel of [
    'products-panel',
    'history-panel',
    'customers-panel',
    'suppliers-panel',
    'pricelists-panel',
    'users-panel',
    'activity-log-panel',
    'platform-admin-panel'
  ]) assert.match(layout, new RegExp(`['"]${panel}['"]`));
  assert.match(layout, /report-subtab-debt/);
  assert.match(layout, /report-subtab-returns/);
  assert.match(main, /setupModuleFilterLayouts\(\);[\s\S]*?setupProductManagement\(\)/);
  assert.match(css, /\.module-split-layout\s*\{[\s\S]*?grid-template-columns:\s*264px minmax\(0, 1fr\)/);
  assert.match(css, /\.module-filter-sidebar\s*\{[\s\S]*?position:\s*sticky/);
});

test('dashboard and input-only screens are not forced into the filter layout', () => {
  assert.doesNotMatch(layout, /setupPanelSurface\(['"]dashboard-panel/);
  assert.doesNotMatch(layout, /setupPanelSurface\(['"]invoice-panel/);
  assert.doesNotMatch(layout, /setupPanelSurface\(['"]settings-panel/);
});

test('customer advanced filters are compact grouped controls in the left rail', () => {
  assert.match(layout, /setupCompactCustomerFilterGroups\(advancedFilter\)/);
  assert.match(layout, /document\.createElement\(['"]details['"]\)/);
  assert.match(layout, /customer-filter-compact-summary/);
  assert.match(css, /\.customer-filter-compact-group/);
});
