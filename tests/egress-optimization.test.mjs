import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const service = read('js/services/supabase.js');
const realtime = read('js/services/realtime.js');
const main = read('js/main.js');
const users = read('js/components/users.js');
const dashboard = read('js/components/dashboard.js');
const history = read('js/components/history.js');
const cashbook = read('js/components/so_quy.js');
const html = read('index.html');

test('login uses a lean bootstrap and defers historical domains until their panels open', () => {
  assert.match(users, /leanBootstrap:\s*true/);
  assert.match(main, /leanBootstrap:\s*true/);
  assert.match(service, /\.\.\.\(leanBootstrap \? \[\] : \[fetchOrders\(\)\]\)/);
  assert.match(service, /Promise\.all\(leanBootstrap \? \[\] : \[/);
  assert.match(service, /fetchPricelists\(\{ includeItems: !leanBootstrap \}\)/);
  assert.match(service, /if \(!includeItems\) \{\s*itemData = \[\]/);
  assert.match(main, /'invoice-panel': \['pricelists'\]/);
  assert.match(main, /'pricelists-panel': \['pricelists'\]/);
  assert.match(main, /'history-panel': \['orders', 'salesReturns'\]/);
  assert.match(main, /'so-quy-panel': \['cashbook', 'startingBalances'\]/);
  assert.match(main, /loadedPanelDomains\.has\(domain\)/);
  assert.match(main, /pendingPanelDomainLoads\.has\(loadKey\)/);
});

test('customer bootstrap excludes the duplicated legacy debt-history payload', () => {
  assert.match(service, /const CUSTOMER_LIST_COLUMNS = \[/);
  const columns = service.slice(
    service.indexOf('const CUSTOMER_LIST_COLUMNS'),
    service.indexOf('].join', service.indexOf('const CUSTOMER_LIST_COLUMNS'))
  );
  assert.doesNotMatch(columns, /debt_history/);
  assert.match(service, /fetchFullTableData\(tableCustomersName, CUSTOMER_LIST_COLUMNS\)/);
});

test('routine refresh actions do not download every business table', () => {
  assert.doesNotMatch(dashboard, /fetchCloudData/);
  assert.match(dashboard, /dashboardStatsInFlight/);
  assert.match(dashboard, /DASHBOARD_STATS_CACHE_MS = 10_000/);
  assert.match(dashboard, /updateDashboardStats\(\{ force: true \}\)/);
  assert.match(history, /dbLoadOrdersForHistoryRange\(window\.startIso, window\.endExclusiveIso\)/);
  assert.match(history, /ensurePanelCloudData\('history-panel', \{ force: true, domains: \['salesReturns'\] \}\)/);
  assert.doesNotMatch(history, /await fetchCloudData\(\)/);
  assert.doesNotMatch(cashbook, /await dbFetchCashbookTransactions\(\)/);
  assert.match(cashbook, /dbFetchCashbookTransactionById/);
});

test('invoice history defaults to the current week and filters orders at Supabase', () => {
  assert.match(html, /<option value="week" selected>Tuần này<\/option>/);
  assert.match(service, /fetchOrderRowsForHistoryWindow\(currentWeek\.startIso, currentWeek\.endExclusiveIso\)/);
  assert.match(service, /\.gte\('order_date', startIso\)/);
  assert.match(service, /\.lt\('order_date', endExclusiveIso\)/);
  assert.match(service, /\.limit\(500\)/);
  assert.doesNotMatch(service, /p_limit:\s*10000/);
  assert.match(history, /const onDateFilterChange = \(\) => \{[\s\S]*reloadHistoryDateWindow\(\)/);
  assert.match(history, /if \(dateMode !== 'all'\)[\s\S]*oDate >= endExclusiveDate/);
});

test('cashbook defaults to the current week and loads only the selected date window', () => {
  assert.match(html, /name="so-quy-time" value="week" checked/);
  assert.match(cashbook, /timeMode:\s*'week'/);
  assert.match(cashbook, /dbLoadCashbookForRange\(range\.startIso, range\.endExclusiveIso\)/);
  assert.match(cashbook, /state\.cashbookOpeningNetByMethod/);
  assert.match(cashbook, /state\.cashbookOpeningStartIso === rangeStart\.toISOString\(\)/);
  assert.match(service, /rpc\('rpc_get_cashbook_window'/);
  assert.match(service, /dbLoadCashbookForRange\(currentWeek\.startIso, currentWeek\.endExclusiveIso\)/);
});

test('cashbook window RPC returns an opening aggregate without exposing anonymous access', () => {
  const migration = read('migrations/0051_cashbook_window_egress.sql');
  assert.match(migration, /SECURITY INVOKER/i);
  assert.match(migration, /require_authenticated_profile\(\)/);
  assert.match(migration, /opening_net_by_method/);
  assert.match(migration, />= p_start/);
  assert.match(migration, /< p_end_exclusive/);
  assert.match(migration, /GRANT EXECUTE[\s\S]*TO authenticated/i);
  assert.doesNotMatch(migration, /GRANT EXECUTE[\s\S]*TO anon/i);
});

test('range refresh preserves unrelated cached orders and refreshes returns separately', () => {
  assert.match(service, /const retained = \(state\.savedOrders \|\| \[\]\)\.filter\(order => !isInsideWindow\(order\)\)/);
  assert.match(service, /state\.savedOrders = \[\.\.\.mapped, \.\.\.retained\]/);
  assert.match(main, /domains: domainOverride = null/);
  assert.match(main, /domainOverride\.filter\(domain => panelDomains\.includes\(domain\)\)/);
});

test('realtime applies row deltas and tab visibility does not trigger refetching', () => {
  for (const updater of [
    'applyCashbookRealtimePayload', 'applyCustomerDebtRealtimePayload', 'applyStartingBalanceRealtimePayload',
    'applyProductRealtimePayload', 'applyPricingRealtimePayload', 'applyBrandRealtimePayload',
    'applyOrderRealtimePayload', 'applyCustomerRealtimePayload'
  ]) {
    assert.match(realtime, new RegExp(`${updater}\\(`));
  }
  assert.match(realtime, /applyOrderRealtimePayload\(change\.payload/);
  assert.match(realtime, /applyCustomerRealtimePayload\(payload\)/);
  assert.match(service, /export function applyOrderRealtimePayload/);
  assert.match(service, /export function applyCustomerRealtimePayload/);
  assert.doesNotMatch(realtime, /refreshDomains\.add/);
  assert.doesNotMatch(realtime, /addEventListener\('visibilitychange'/);
  assert.match(realtime, /window\.addEventListener\('online'/);
});
