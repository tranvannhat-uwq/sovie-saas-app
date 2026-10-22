import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
const rangeLoaderStart = source.indexOf('export async function dbLoadOrdersForHistoryRange(');
const rangeLoaderEnd = source.indexOf('\n// Realtime already carries', rangeLoaderStart);
const rangeLoader = source.slice(rangeLoaderStart, rangeLoaderEnd);

test('history range reload fetches Cloud drafts and restores them to saved orders', () => {
  assert.notEqual(rangeLoaderStart, -1, 'history range loader must exist');
  assert.notEqual(rangeLoaderEnd, -1, 'history range loader must have a stable end marker');
  assert.match(rangeLoader, /Promise\.all\(\[\s*fetchOrderRowsForHistoryWindow\(startIso, endExclusiveIso\),\s*fetchFullTableData\(tableDraftOrdersName\)\s*\]\)/);
  assert.match(rangeLoader, /replaceLoadedDraftOrders\(rawDrafts\)/);
});

test('replacing Cloud drafts removes stale cached drafts but preserves finalized orders', () => {
  const helperStart = source.indexOf('function replaceLoadedDraftOrders(');
  const helperEnd = source.indexOf('\nexport async function dbLoadOrdersForHistoryRange(', helperStart);
  const helper = source.slice(helperStart, helperEnd);

  assert.match(helper, /map\(order => mapOrderRowForState\(order, true\)\)/);
  assert.match(helper, /filter\(order => order\.status !== 'draft'\)/);
  assert.match(helper, /state\.savedOrders = \[\.\.\.mappedDrafts, \.\.\.withoutOldDrafts\]/);
  assert.match(helper, /cacheOrdersLocally\(state\.savedOrders\)/);
});
