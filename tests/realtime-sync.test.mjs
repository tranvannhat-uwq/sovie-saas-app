import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('realtime migration changes publication metadata without rewriting business data', () => {
  const sql = read('migrations/0021_enable_scoped_realtime.sql');
  assert.match(sql, /pg_catalog\.pg_publication_tables/i);
  assert.match(sql, /ALTER PUBLICATION supabase_realtime ADD TABLE/i);
  assert.match(sql, /to_regclass/i);
  assert.doesNotMatch(sql, /\b(?:UPDATE|DELETE)\s+public\./i);
  assert.doesNotMatch(sql, /INSERT\s+INTO\s+public\.(?!schema_migrations\b)/i);
});

test('realtime client batches events and applies changed records without full-table refreshes', () => {
  const realtime = read('js/services/realtime.js');
  const service = read('js/services/supabase.js');
  assert.match(realtime, /REALTIME_DEBOUNCE_MS\s*=\s*250/);
  assert.match(realtime, /postgres_changes/);
  assert.match(realtime, /dbRefreshOrderById/);
  assert.match(realtime, /applyCustomerDebtRealtimePayload\(event\.payload\)/);
  assert.match(realtime, /applyCashbookRealtimePayload\(event\.payload\)/);
  assert.match(realtime, /applyProductRealtimePayload\(event\.payload\)/);
  assert.match(realtime, /applyPricingRealtimePayload\('priceListItem', event\.payload\)/);
  assert.match(realtime, /dbRefreshSalesReturnById\(returnId, \{ deleted \}\)/);
  assert.doesNotMatch(realtime, /refreshDomains\.add/);
  assert.match(service, /Array\.isArray\(options\.onlyDomains\)/);
  assert.match(service, /export async function dbRefreshOrderById/);
  assert.match(service, /if \(!onlyDomains\)[\s\S]{0,300}\.delete\(\)/);
  assert.doesNotMatch(realtime, /document\.addEventListener\('visibilitychange'/);
});

test('realtime lifecycle follows authentication and disconnect paths', () => {
  const users = read('js/components/users.js');
  const main = read('js/main.js');
  assert.match(users, /void startRealtimeSync\(renderAll\)/);
  assert.match(users, /await stopRealtimeSync\(\)/);
  assert.match(main, /if \(activeUser\) \{[\s\S]{0,100}void startRealtimeSync\(renderAll\)/);
  assert.match(main, /await stopRealtimeSync\(\);\s*disconnectSupabase\(\)/);
});
