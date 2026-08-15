import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('database uses only explicit parents and the canonical general fallback', () => {
  const sql = read('migrations/0035_deterministic_sku_price_fallback.sql');

  assert.match(sql, /requested_is_global_general/);
  assert.match(sql, /canonical_list_id/);
  assert.match(sql, /'bảng giá chung'/);
  assert.match(sql, /list\.parent_price_list_id INTO next_list_id/);
  assert.match(sql, /AND NOT requested_is_global_general/);
  assert.doesNotMatch(sql, /UPDATE public\.(?:products|pricelists|price_list_items|orders|customers)/);
  assert.doesNotMatch(sql, /DELETE FROM/);
});

test('browser uses the canonical list and reports a readable SKU code', () => {
  const pricing = read('js/domain/pricing.js');
  const service = read('js/services/supabase.js');

  assert.match(pricing, /\['bảng giá chung', 'bang gia chung', 'giá chung', 'gia chung'\]/);
  assert.match(pricing, /const requestedIsGlobalGeneral/);
  assert.match(pricing, /requestedIsGlobalGeneral \? null : getStandardPriceList/);
  assert.match(service, /has no effective database price/i);
  assert.match(service, /product\?\.code \|\| missingPrice\[1\]/);
});
