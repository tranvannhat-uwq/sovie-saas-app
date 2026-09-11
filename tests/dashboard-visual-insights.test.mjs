import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const html = read('index.html');
const dashboard = read('js/components/dashboard.js');

test('dashboard combines line, doughnut and horizontal ranking charts', () => {
  assert.match(html, /id="revenue-chart"/);
  assert.match(dashboard, /type:\s*'doughnut'/);
  assert.match(dashboard, /indexAxis:\s*isDoughnut \? undefined : 'y'/);
  assert.match(dashboard, /dashboardBreakdownCharts\.set\(key, chart\)/);
});

test('all visual breakdowns use the same filtered server payload as before', () => {
  assert.match(dashboard, /rows:\s*payload\.by_company/);
  assert.match(dashboard, /rows:\s*payload\.by_brand/);
  assert.match(dashboard, /rows:\s*filterLoginEmployeeRevenueRows\(payload\.by_salesperson, state\.users\)/);
  assert.match(dashboard, /rows:\s*payload\.by_customer/);
  assert.match(dashboard, /await dbFetchPhase5Dashboard/);
});

test('dashboard exposes and applies the customer autocomplete filter', () => {
  assert.match(html, /id="dashboard-customer-search-input"/);
  assert.match(html, /id="dashboard-customer-suggestions"/);
  assert.match(dashboard, /setupCustomerAutocomplete\(\)/);
  assert.match(dashboard, /customer_id:\s*state\.dashboardFilter\.customerId \|\| 'all'/);
  assert.match(dashboard, /String\(o\.customerId \|\| o\.customer_id\) === String\(state\.dashboardFilter\.customerId\)/);
});

test('chart range buttons update only the chart and leave dashboard filters unchanged', () => {
  const buttonHandler = dashboard.slice(dashboard.indexOf("document.querySelectorAll('.chart-view-btn')"));
  assert.match(buttonHandler, /state\.dashboardChartView\s*=\s*view;/);
  assert.match(buttonHandler, /updateRevenueChartForView\(view\)/);
  assert.doesNotMatch(buttonHandler.slice(0, buttonHandler.indexOf('function setupSaleAutocomplete')), /dashboardFilter\.timeRange\s*=\s*view/);
  assert.match(dashboard, /buildDashboardChartSeries\(payload\?\.series \|\| \[\], state\.dashboardChartView, payload\?\.period \|\| \{\}\)/);
  assert.match(dashboard, /Doanh số gốc[\s\S]*?Doanh số ròng/);
});

test('chart view transitions update one chart instance instead of rebuilding the dashboard', () => {
  assert.match(dashboard, /revenueChartInstance\.data\.labels\s*=\s*chartSeries\.labels/);
  assert.match(dashboard, /revenueChartInstance\.data\.datasets\[0\]\.data\s*=\s*chartSeries\.dataPoints/);
  assert.match(dashboard, /revenueChartInstance\.update\(\)/);
  assert.doesNotMatch(dashboard.slice(dashboard.indexOf('function renderServerRevenueChart'), dashboard.indexOf('function dashboardRequestFiltersForRange')), /revenueChartInstance\.destroy\(\)/);
});

test('dashboard charts use the static animation-free design system', () => {
  assert.match(dashboard, /animation:\s*false/);
  assert.match(dashboard, /duration:\s*0/);
  assert.doesNotMatch(dashboard, /getRevenueChartAnimation/);
  assert.doesNotMatch(dashboard, /createLinearGradient/);
});

test('chart cards have accessible labels and empty states', () => {
  for (const id of ['company', 'brand', 'salesperson', 'customer']) {
    assert.match(html, new RegExp(`id="${id}-revenue-chart"[^>]*role="img"[^>]*aria-label=`));
    assert.match(html, new RegExp(`id="${id}-revenue-chart-empty"`));
  }
});
