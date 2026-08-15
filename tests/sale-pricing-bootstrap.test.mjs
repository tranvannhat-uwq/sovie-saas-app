import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');
const invoice = fs.readFileSync(path.join(root, 'js/components/invoice.js'), 'utf8');
const fetchStart = service.indexOf('const fetchPricelists = async ({ includeItems = true } = {}) =>');
const fetchEnd = service.indexOf('const fetchUsers = async () =>', fetchStart);
const fetchFlow = service.slice(fetchStart, fetchEnd);

test('sale pricing bootstrap requests only lists explicitly visible to sale', () => {
  assert.match(fetchFlow, /rpc\('rpc_get_sale_pricing_snapshot'\)/);
  assert.match(fetchFlow, /snapshot\?\.price_lists/);
  assert.match(fetchFlow, /snapshot\?\.items/);
  const visibleLists = fetchFlow.indexOf('const visiblePricelists = filterPriceListsForUser');
  const visibleIds = fetchFlow.indexOf('const visiblePriceListIds = new Set');
  const scopedItems = fetchFlow.indexOf('await fetchPriceListItemsForIds([...visiblePriceListIds])');
  assert.ok(visibleLists >= 0 && visibleIds > visibleLists && scopedItems > visibleIds);
  assert.match(fetchFlow, /state\.currentUser\?\.role === 'sale'/);
});

test('sale snapshot RPC is role-bound and does not change pricing data', () => {
  const migration = fs.readFileSync(path.join(root, 'migrations/0043_sale_pricing_snapshot_rpc.sql'), 'utf8');
  assert.match(migration, /actor := public\.require_authenticated_profile\(\)/);
  assert.match(migration, /actor\.role <> 'sale'/);
  assert.match(migration, /is_available_for_sales = true/);
  assert.match(migration, /price_list\.customer_id IS NULL/);
  assert.match(migration, /JOIN allowed_lists price_list ON price_list\.id = item\.price_list_id/);
  assert.doesNotMatch(migration, /\b(?:UPDATE|DELETE|TRUNCATE)\s+public\.(?:pricelists|price_list_items)\b/i);
  assert.doesNotMatch(migration, /GRANT\s+EXECUTE[\s\S]{0,80}\bTO\s+anon\b/i);
});

test('scoped item loader filters on price_list_id and keeps pagination', () => {
  const start = service.indexOf('async function fetchPriceListItemsForIds');
  const end = service.indexOf('function mapAuthorizedPriceList', start);
  const loader = service.slice(start, end);
  assert.match(loader, /\.in\('price_list_id', chunk\)/);
  assert.match(loader, /collectAllPages/);
  assert.match(loader, /uniqueIds\.length === 0/);
});

test('dealer-specific pricing remains an exact on-demand request', () => {
  assert.match(service, /export async function dbLoadCustomerAssignedPricing\(customer\)/);
  assert.match(service, /rpc_get_customer_assigned_pricing/);
  assert.match(service, /\.eq\('price_list_id', priceList\.id\)/);
  assert.match(invoice, /const assignedListNeedsScopedItems = Boolean\(/);
  assert.match(invoice, /!canUserViewPriceList\(state\.currentUser, applicablePricing\.priceList\)/);
  assert.match(invoice, /applicablePricing\.selectionSource !== 'customer_default' \|\| assignedListNeedsScopedItems/);
});
