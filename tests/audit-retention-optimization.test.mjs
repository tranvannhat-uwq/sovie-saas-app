import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '0052_short_compact_audit_retention.sql'), 'utf8');
const migrationList = fs.readFileSync(path.join(root, 'tests', 'p0-migrations.test.mjs'), 'utf8');

test('migration 0052 is tracked and limits both log stores to four days', () => {
  assert.match(migrationList, /0052_short_compact_audit_retention\.sql/);
  assert.match(migration, /DELETE FROM public\.audit_logs WHERE created_at < now\(\) - interval '4 days'/);
  assert.match(migration, /DELETE FROM public\.activity_logs WHERE created_at < now\(\) - interval '4 days'/);
  assert.match(migration, /SELECT public\.p52_prune_short_audit_logs\(\)/);
  assert.match(migration, /CREATE TRIGGER p52_prune_audit_logs AFTER INSERT ON public\.audit_logs/);
  assert.match(migration, /CREATE TRIGGER p52_prune_activity_logs AFTER INSERT ON public\.activity_logs/);
});

test('activity readers never return rows outside the retention window', () => {
  const fourDayReadGuards = migration.match(/created_at >= now\(\) - interval '4 days'/g) || [];
  assert.equal(fourDayReadGuards.length, 2);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.rpc_get_activity_logs/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.rpc_get_order_activity/);
});

test('audit payloads retain only compact business-significant fields', () => {
  assert.match(migration, /p52_is_important_change_field/);
  assert.match(migration, /\(price\|amount\|total\|subtotal\|debt\|refund\|discount\|fee\|value\|paid\|product\|variant\|sku\|unit\|package\)/);
  assert.match(migration, /WHEN lower\(entry\.key\) = 'items' THEN public\.p52_compact_items/);
  assert.match(migration, /NEW\.old_data := NULLIF\(compact_old, '\{\}'::jsonb\)/);
  assert.match(migration, /NEW\.changes := compact_changes/);
  assert.match(migration, /IF compact_changes = '\{\}'::jsonb AND NOT public\.p52_is_essential_action\(NEW\.action\) THEN RETURN NULL/);
});

test('price changes are logged without making price writes depend on audit', () => {
  assert.match(migration, /CREATE TRIGGER p52_price_activity_row AFTER INSERT OR UPDATE OR DELETE ON public\.price_list_items/);
  assert.match(migration, /create_price/);
  assert.match(migration, /update_price/);
  assert.match(migration, /delete_price/);
  assert.match(migration, /Price activity logging failed without blocking the price change/);
});

test('retention never mutates business data and audit failures are fail-safe', () => {
  assert.doesNotMatch(migration, /(?:UPDATE|DELETE FROM) public\.(?:orders|draft_orders|products|price_list_items|pricelists|customers|cashbook_transactions|payments|customer_debt_ledger)\b/i);
  assert.match(migration, /Audit compaction skipped one log row/);
  assert.match(migration, /Activity compaction skipped one log row/);
  assert.match(migration, /Audit retention cleanup deferred without blocking business data/);
  assert.ok((migration.match(/EXCEPTION WHEN OTHERS/g) || []).length >= 4);
});
