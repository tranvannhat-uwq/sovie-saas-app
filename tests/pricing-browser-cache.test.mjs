import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const cacheService = read('js/services/pricing-cache.js');
const cloudService = read('js/services/supabase.js');
const main = read('js/main.js');

test('pricing cache is isolated by authenticated account and role', async () => {
  const moduleUrl = pathToFileURL(path.join(root, 'js/services/pricing-cache.js')).href;
  const { getPricingCacheKey, loadAuthorizedPricingCache, saveAuthorizedPricingCache } = await import(moduleUrl);

  assert.equal(getPricingCacheKey({ authUserId: 'user-1', role: 'sale' }), 'user-1::sale');
  assert.equal(getPricingCacheKey({ authUserId: 'user-1', role: 'accounting' }), 'user-1::accounting');
  assert.equal(getPricingCacheKey(null), '');
  assert.equal(await loadAuthorizedPricingCache({ authUserId: 'user-1', role: 'sale' }), null);
  assert.equal(await saveAuthorizedPricingCache({ authUserId: 'user-1', role: 'sale' }, [], []), false);
});

test('pricing cache uses IndexedDB and never the permission-sensitive localStorage keys', () => {
  assert.match(cacheService, /indexedDB\.open\(DATABASE_NAME, DATABASE_VERSION\)/);
  assert.match(cacheService, /database\.createObjectStore\(SNAPSHOT_STORE/);
  assert.doesNotMatch(cacheService, /localStorage/);
  assert.match(cacheService, /actorId.*role.*key:/s);
});

test('lean login hydrates cached items and Cloud refresh replaces the complete snapshot', () => {
  const start = cloudService.indexOf('const fetchPricelists = async ({ includeItems = true } = {}) =>');
  const end = cloudService.indexOf('const fetchUsers = async () =>', start);
  const flow = cloudService.slice(start, end);

  assert.match(flow, /await hydrateAuthorizedPricingCache\(pricingActorId\)/);
  assert.match(flow, /if \(!includeItems\)[\s\S]*state\.allPriceListItems/);
  assert.match(flow, /state\.pricingSnapshotSource = includeItems \? 'cloud'/);
  assert.match(flow, /scheduleAuthorizedPricingCachePersist\(\)/);
});

test('price-list panels render a cached snapshot while background refresh continues', () => {
  assert.match(main, /function panelHasPricingSnapshot\(panelId\)/);
  assert.match(main, /waitForCloud && !panelHasPricingSnapshot\(panelId\)/);
  assert.match(main, /void ensurePanelCloudData\(panelId\)/);
  assert.match(main, /state\.pricingSnapshotRole === String\(state\.currentUser\?\.role \|\| ''\)/);
});
