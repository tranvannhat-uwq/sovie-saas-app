import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const dashboard = read('js/components/dashboard.js');
const html = read('index.html');
const css = read('style.css');
const migration = read('migrations/0033_dashboard_revenue_attribution.sql');

test('company revenue is attributed from each item paint brand', () => {
  assert.match(dashboard, /getCompanyIdByBrand\(rBrand, state\.brands\)/);
  assert.match(migration, /brand\.company_id/);
  assert.match(migration, /GROUP BY revenue_company_id/);
  assert.doesNotMatch(migration.match(/'by_company'[\s\S]*?'by_brand'/)?.[0] || '', /FROM visible_orders GROUP BY company_id/);
});

test('sales revenue is attributed to the customer manager, not the order closer', () => {
  assert.match(dashboard, /customer\?\.managedBy \|\| customer\?\.managed_by \|\| order\?\.customerManagerId/);
  assert.match(migration, /COALESCE\(NULLIF\(customer\.managed_by, ''\), NULLIF\(sale\.customer_manager_id, ''\), 'unassigned'\) managed_salesperson_id/);
  const salespersonSection = migration.match(/'by_salesperson'[\s\S]*?'kpi_by_employee'/)?.[0] || '';
  assert.match(salespersonSection, /GROUP BY managed_salesperson_id/);
  assert.doesNotMatch(salespersonSection, /sale\.created_by|sale\.salesperson_id|'key',\s*salesperson_id/);
});

test('unused manager and province cards are removed and revenue insights use charts', () => {
  assert.doesNotMatch(html, /manager-breakdown-body|province-breakdown-body|Doanh số theo Quản lý|Doanh số theo Tỉnh thành/);
  for (const id of ['company-revenue-chart', 'brand-revenue-chart', 'salesperson-revenue-chart', 'customer-revenue-chart']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /company-revenue-breakdown-body|brand-revenue-breakdown-body|salesperson-breakdown-body|customer-breakdown-body/);
  assert.match(css, /\.dashboard-insights-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(12/);
});

test('salesperson and customer rankings stay compact and preserve the FESTIVAL detail table', () => {
  assert.match(html, /dashboard-insight-salesperson[\s\S]*?salesperson-revenue-chart/);
  assert.match(html, /dashboard-insight-customer[\s\S]*?customer-revenue-chart/);
  assert.match(css, /\.dashboard-breakdown-chart-tall\s*\{\s*height:\s*310px/);
  assert.match(html, /festival-allocation-breakdown-body/);
});
