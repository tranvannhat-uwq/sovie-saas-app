import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const layout = read('js/components/module-filter-layout.js');
const main = read('js/main.js');
const css = read('styles/app.css');
const luminous = read('styles/app.css');

test('list and report modules use shared floating filter windows', () => {
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
  for (const searchId of [
    'product-search-input',
    'history-search-input',
    'customer-search-input',
    'supplier-search-input',
    'price-matrix-product-search',
    'user-search-input',
    'activity-search',
    'platform-account-search',
    'report-debt-search',
    'report-return-search'
  ]) assert.match(layout, new RegExp(`#${searchId}`));
  assert.match(layout, /sidebar\.dataset\.filterOwner = ownerId/);
  assert.match(layout, /overlayRoot\.append\(backdrop, sidebar\)/);
  assert.match(layout, /document\.documentElement\.classList\.add\('module-filter-drawer-open'\)/);
  assert.match(layout, /document\.addEventListener\('keydown'/);
  assert.match(luminous, /Unified floating filter window across every data module/);
  assert.match(luminous, /\.module-split-layout[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(luminous, /\.module-filter-sidebar\.is-mobile-open[\s\S]*?position:\s*fixed/);
  assert.match(luminous, /transform:\s*translate\(-50%, -50%\)/);
  assert.match(luminous, /height:\s*min\(86dvh, 820px\)\s*!important/);
  assert.match(luminous, /flex:\s*1 1 0%\s*!important;[\s\S]*?overflow-y:\s*auto\s*!important/);
  assert.doesNotMatch(luminous, /filterDrawerSlideIn/);
  assert.match(luminous, /html\.module-filter-drawer-open[\s\S]*?overflow:\s*hidden\s*!important/);
});

test('dashboard and input-only screens are not forced into the filter layout', () => {
  assert.doesNotMatch(layout, /setupPanelSurface\(['"]dashboard-panel/);
  assert.doesNotMatch(layout, /setupPanelSurface\(['"]invoice-panel/);
  assert.doesNotMatch(layout, /setupPanelSurface\(['"]settings-panel/);
});

test('customer advanced filters remain compact grouped controls inside the popup', () => {
  assert.match(layout, /setupCompactCustomerFilterGroups\(advancedFilter\)/);
  assert.match(layout, /document\.createElement\(['"]details['"]\)/);
  assert.match(layout, /customer-filter-compact-summary/);
  assert.match(layout, /\.customer-sort-toolbar-row/);
  assert.match(css, /\.customer-filter-compact-group/);
  assert.match(css, /\.customer-advanced-filter-panel[\s\S]*?position:\s*static\s*!important/);
  assert.match(css, /\.customer-advanced-filter-panel[\s\S]*?opacity:\s*1\s*!important/);
  assert.match(css, /\.customer-sort-toolbar-row/);
});

test('shared filters have labels, active count, reset and accessible popup controls', () => {
  assert.match(layout, /FILTER_LABELS/);
  assert.match(layout, /module-filter-field-label/);
  assert.match(layout, /module-filter-count/);
  assert.match(layout, /resetFilters\(sidebar\)/);
  assert.match(layout, /setAttribute\(['"]role['"], ['"]dialog['"]\)/);
  assert.match(layout, /setAttribute\(['"]aria-modal['"], ['"]true['"]\)/);
  assert.match(layout, /event\.key !== ['"]Escape['"]/);
  assert.match(layout, /setupStandaloneSidebar\(['"]#so-quy-panel \.so-quy-sidebar['"]/);
  assert.match(layout, /\.module-filter-content, \.so-quy-content, \.so-quy-main/);
  assert.match(layout, /module-filter-mobile-trigger-cashbook/);
  assert.match(layout, /so-quy-search-tools/);
  assert.match(layout, /function placeFilterTrigger\(/);
  assert.match(layout, /module-list-heading-with-filter/);
  assert.match(layout, /module-list-toolbar-title/);
  assert.match(layout, /content\.querySelector\(':scope > \.panel-header, :scope > \.platform-accounts-toolbar'\)/);
  assert.match(layout, /function getFilterTriggers\(/);
  assert.match(css, /\.history-status-multi-filter\s*\{[\s\S]*?grid-template-columns:\s*repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(luminous, /\.module-filter-mobile-trigger\s*\{[\s\S]*?display:\s*inline-flex/);
  assert.match(luminous, /#so-quy-panel \.module-filter-mobile-trigger-cashbook/);
  assert.match(luminous, /\.module-list-heading-with-filter \.module-filter-mobile-trigger-inline/);
  assert.match(luminous, /\.module-list-toolbar\s*\{/);
});

test('exports reusable filter component builders for all data modules', () => {
  for (const fn of [
    'createFilterPanel',
    'createFilterSection',
    'createFilterField',
    'createFilterSearch',
    'createFilterSelect',
    'createFilterCheckboxGroup',
    'createFilterRadioGroup',
    'createFilterDateRange',
    'createFilterNumberRange',
    'createActiveFilterChips'
  ]) {
    assert.match(layout, new RegExp(`export\\s+function\\s+${fn}\\b`));
  }
});

test('filter layout eliminates horizontal scrollbar and enforces modern SaaS design', () => {
  assert.match(css, /\.module-filter-active-chips/);
  assert.match(css, /\.module-filter-active-chip/);
  assert.match(css, /\.module-filter-footer/);
  assert.match(css, /\.module-filter-backdrop/);
  assert.match(css, /\.module-filter-mobile-trigger/);
  assert.match(css, /\.module-filter-body\s*\{[\s\S]*?overflow-x:\s*hidden\s*!important/);
  assert.match(css, /\.module-filter-sidebar[\s\S]*?box-sizing:\s*border-box\s*!important/);
  assert.match(css, /\.custom-control\s*\{[\s\S]*?flex-direction:\s*row\s*!important/);
  assert.match(css, /#history-filter-range\[style\*="display:\s*none"\][\s\S]*?display:\s*none\s*!important/);
  assert.match(luminous, /\.module-filter-backdrop\s*\{[\s\S]*?background:\s*rgba\(30, 45, 70, 0\.24\)/);
  assert.match(luminous, /\.module-filter-backdrop\s*\{[\s\S]*?backdrop-filter:\s*blur\(4px\)/);
  assert.match(luminous, /\.module-filter-backdrop\[hidden\][\s\S]*?display:\s*none/);
});

test('floating filter popup uses a polished responsive two-column layout', () => {
  assert.match(luminous, /width:\s*min\(780px, calc\(100vw - 40px\)\)/);
  assert.match(luminous, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(luminous, /\.module-filter-heading \.module-filter-reset\s*\{[\s\S]*?display:\s*none/);
  assert.match(luminous, /\.module-filter-footer-btn\s*\{[\s\S]*?flex:\s*0 0 auto/);
  assert.match(luminous, /@media \(max-width: 640px\)[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\)/);
});

test('dashboard uses header actions and a popup filter modal without hidden summary markup', () => {
  const html = read('index.html');
  const dashboard = read('js/components/dashboard.js');
  assert.doesNotMatch(html, /dashboard-compact-bar|dashboard-summary-(?:time|mode|extra)/);
  assert.match(html, /id="btn-open-dashboard-filter"/);
  assert.match(html, /id="dashboard-filter-modal"/);
  assert.match(html, /id="btn-apply-dashboard-filters"/);
  assert.match(dashboard, /export function openDashboardFilterModal\b/);
  assert.match(dashboard, /export function closeDashboardFilterModal\b/);
  assert.match(dashboard, /export function updateDashboardFilterSummary\b/);
  assert.doesNotMatch(dashboard, /dashboard-summary-(?:time|mode|extra)/);
  assert.match(dashboard, /dashboard-filter-count/);
  assert.doesNotMatch(css, /dashboard-compact-bar|dashboard-summary-chip/);
  assert.match(css, /#dashboard-filter-modal \.dashboard-filter-modal-content/);
});

test('dashboard filter and refresh buttons are placed alongside system overview in top-header', () => {
  const html = read('index.html');
  assert.match(html, /<header class="top-header">[\s\S]*?id="dashboard-header-actions"[\s\S]*?id="btn-open-dashboard-filter"[\s\S]*?id="btn-refresh-dashboard-data"[\s\S]*?<\/header>/);
  assert.match(main, /dashHeaderActions\.style\.display\s*=\s*panelId === 'dashboard-panel'\s*\?\s*'inline-flex'\s*:\s*'none'/);
  assert.match(luminous, /#app-layout \.top-header \.dashboard-header-actions/);
});
