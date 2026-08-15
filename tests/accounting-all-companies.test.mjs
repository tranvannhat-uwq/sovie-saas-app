import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const dashboard = read('js/components/dashboard.js');
const rls = read('migrations/0040_customer_assigned_price_list_exception.sql');
const reporting = read('migrations/0033_dashboard_revenue_attribution.sql');

test('Accounting can select all companies on the dashboard', () => {
  assert.match(dashboard, /\['admin', 'accounting'\]\.includes/);
  assert.match(dashboard, /if \(currUser && !canViewAllDashboardCompanies\(currUser\)\)/);
  assert.match(dashboard, /canViewAllDashboardCompanies\(currUser\)[\s\S]*state\.dashboardFilter\.companyId/);
  assert.doesNotMatch(dashboard, /currUser\.role === 'accounting' \|\| currUser\.role === 'manager'/);
});

test('legacy Accounting dashboard filters migrate to all companies once', () => {
  assert.match(dashboard, /companyScopeVersion: DASHBOARD_COMPANY_SCOPE_VERSION/);
  assert.match(dashboard, /companyScopeActor: dashboardCompanyScopeActor\(\)/);
  assert.match(dashboard, /state\.currentUser\?\.role === 'accounting'[\s\S]*state\.dashboardFilter\.companyId = 'all'/);
});

test('database visibility remains global for Accounting and scoped only for Sale', () => {
  assert.match(rls, /public\.is_admin_or_accounting\(\)/);
  assert.match(reporting, /actor\.role <> 'sale'/);
  assert.doesNotMatch(reporting, /actor\.company_id/);
});
