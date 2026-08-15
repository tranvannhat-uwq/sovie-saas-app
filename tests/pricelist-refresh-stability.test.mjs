import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const service = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');
const users = fs.readFileSync(path.join(root, 'js/components/users.js'), 'utf8');
const priceListUi = fs.readFileSync(path.join(root, 'js/components/pricelists.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'js/main.js'), 'utf8');
const start = service.indexOf('const fetchPricelists = async ({ includeItems = true } = {}) =>');
const end = service.indexOf('const fetchUsers = async () =>', start);
const refreshFlow = service.slice(start, end);

test('pricing refresh publishes lists and item rows as one complete snapshot', () => {
  const itemFetch = refreshFlow.indexOf('const mappedPriceListItems = (itemData || []).map');
  const listCommit = refreshFlow.indexOf('state.allPricelists = mappedPricelists');
  const itemCommit = refreshFlow.indexOf('state.allPriceListItems = mappedPriceListItems');

  assert.ok(itemFetch >= 0, 'price-list item fetch must exist');
  assert.ok(listCommit > itemFetch, 'price lists must not be published before item rows load');
  assert.ok(itemCommit > itemFetch, 'price-list items must be mapped before the snapshot is published');
  assert.match(refreshFlow, /const visiblePricelists = filterPriceListsForUser\(mappedPricelists, state\.currentUser\)/);
});

test('a transient pricing refresh error keeps the current authorized snapshot', () => {
  const catchFlow = refreshFlow.slice(refreshFlow.lastIndexOf('} catch (plErr)'));

  assert.match(catchFlow, /keeping the last snapshot/);
  assert.match(catchFlow, /state\.pricingSnapshotActorId === pricingActorId/);
  assert.match(refreshFlow, /state\.pricingSnapshotActorId = pricingActorId/);
  assert.match(users, /clearAuthenticatedSessionState[\s\S]{0,500}state\.pricingSnapshotActorId = ''/);
});

test('local price-list mutations keep visible and full pricing snapshots synchronized', () => {
  assert.match(priceListUi, /function upsertPriceListSnapshot\(priceList\)/);
  assert.match(priceListUi, /state\.allPricelists = allLists;[\s\S]{0,100}state\.pricelists = filterPriceListsForUser/);
  assert.match(priceListUi, /function commitPriceListItemSnapshot\(changes, deletedKeys = new Set\(\)\)/);
  assert.match(priceListUi, /state\.allPriceListItems = allItems;[\s\S]{0,100}state\.priceListItems = allItems\.filter/);
  assert.match(priceListUi, /if \(!\(await dbSavePricelist\(priceList\)\)\) return;[\s\S]{0,100}upsertPriceListSnapshot\(priceList\)/);
  assert.match(priceListUi, /commitPriceListItemSnapshot\(changes, pendingDeletes\)/);
});

test('session recovery loads role-scoped pricing only after profile validation', () => {
  assert.match(service, /if \(connectionSession\?\.user && state\.currentUser\)/);
  assert.match(main, /if \(activeUser\) \{[\s\S]{0,150}state\.currentUser = activeUser;[\s\S]{0,150}fetchCloudData\(\{/);
  assert.match(main, /hydrateCustomerHistory: false/);
});
