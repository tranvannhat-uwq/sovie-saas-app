import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('editing one customer refreshes only that authoritative row', () => {
  const customers = read('js/components/customers.js');
  const service = read('js/services/supabase.js');
  const saveCustomer = customers.slice(customers.indexOf('export async function saveCustomer'), customers.indexOf('export async function deleteCustomer'));
  const singleRefresh = service.slice(service.indexOf('export async function dbFetchCustomerById'), service.indexOf('export async function dbFetchCashbookTransactions'));

  assert.match(saveCustomer, /await dbFetchCustomerById\(customerId\)/);
  assert.doesNotMatch(saveCustomer, /await dbFetchCustomers\(\)/);
  assert.match(singleRefresh, /\.eq\('id', customerId\)[\s\S]*\.single\(\)/);
  assert.doesNotMatch(singleRefresh, /fetchFullTableData|hydrateCustomerDebtHistory/);
});

test('login renders from core data while historical panels remain lazy', () => {
  const users = read('js/components/users.js');
  const service = read('js/services/supabase.js');
  const login = users.slice(users.indexOf('export async function handleLogin'), users.indexOf('export function handleLogout'));

  assert.match(login, /deferSecondary:\s*true/);
  assert.match(login, /hydrateCustomerHistory:\s*false/);
  assert.match(login, /leanBootstrap:\s*true/);
  assert.match(login, /cloudLoad\?\.background/);
  assert.ok(login.indexOf("switchTab(state.currentUser.role === 'sale' ? 'invoice-panel' : 'dashboard-panel')") < login.indexOf('cloudLoad?.background'));
  assert.match(service, /const coreLoad = Promise\.all/);
  assert.match(service, /const secondaryLoad = Promise\.all/);
  assert.match(service, /leanBootstrap \? \[\] :/);
  assert.match(service, /return \{ background \}/);
});

test('customer debt history is loaded on demand and successful login email is reused', () => {
  const customers = read('js/components/customers.js');
  const users = read('js/components/users.js');

  assert.match(customers, /export async function openCustomerDetailModal/);
  assert.match(customers, /await dbRefreshCustomerFinancialState\(cust\.id\)/);
  assert.match(users, /billing_system_login_email:/);
  assert.match(users, /new Set\(\[rememberedEmail/);
  assert.match(users, /`\$\{usernameInput\}@lendon\.com`/);
  assert.match(users, /`\$\{usernameInput\}@gmail\.com`/);
  assert.doesNotMatch(users, /@weblendon\.com/);
});

test('order history reuses filtered pages and indexes related records', () => {
  const history = read('js/components/history.js');

  assert.match(history, /scheduleHistoryFilter\(onFilterChange\)/);
  assert.match(history, /renderHistoryOrders\(\{ reuseFiltered: true \}\)/);
  assert.match(history, /const customerById = new Map\(\)/);
  assert.match(history, /const returnsByOrderId = new Map\(\)/);
  assert.match(history, /lookups\.activeReturnsByOrderId\.get\(String\(order\.id\)\)/);

  const render = history.slice(
    history.indexOf('export function renderHistoryOrders'),
    history.indexOf('function loadDraftOrderIntoInvoice')
  );
  assert.doesNotMatch(render, /state\.customers\.find/);
  assert.doesNotMatch(render, /\(state\.salesReturns \|\| \[\]\)\.filter/);
});
