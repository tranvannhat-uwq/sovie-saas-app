import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'scripts/set-mobile-staging-admin.sql'), 'utf8');

test('mobile Admin bootstrap is staging-scoped and targets one linked profile', () => {
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /STAGING_ONLY/);
  assert.match(sql, /mqxqswwssmemkimnolfu/);
  assert.match(sql, /schema_migrations WHERE version = '0053'/);
  assert.match(sql, /linked_profile_count <> 1/);
  assert.match(sql, /SET role = 'admin'/);
  assert.match(sql, /COMMIT;\s*$/);
});

test('mobile Admin bootstrap does not mutate business or financial tables', () => {
  assert.doesNotMatch(sql, /\b(?:DELETE|TRUNCATE|DROP TABLE)\b/i);
  assert.doesNotMatch(sql, /UPDATE public\.(?:orders|customers|products|payments|cashbook_transactions)/i);
  assert.match(sql, /UPDATE public\.profiles/);
});
