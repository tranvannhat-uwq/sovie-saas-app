import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(
  path.join(root, 'migrations/0049_initialize_manual_price_record.sql'),
  'utf8'
);

test('manual order confirmation initializes the skipped price resolver record', () => {
  assert.match(migration, /IF manual_pricing THEN/);
  assert.match(migration, /NULL::numeric AS price/);
  assert.match(migration, /NULL::text AS source_list_id/);
  assert.match(migration, /INTO resolved_price/);
  assert.match(migration, /ELSE/);
  assert.match(migration, /p40_resolve_sku_price_for_customer/);
});

test('record initialization changes no business rows or financial formulas', () => {
  assert.doesNotMatch(migration, /(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?public\.(?:orders|order_items|customers|customer_debt_transactions)/i);
  assert.doesNotMatch(migration, /total_payable\s*:=|debt_amount\s*:=|balance_after\s*:=/i);
});
