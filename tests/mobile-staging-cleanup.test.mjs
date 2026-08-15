import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(
  new URL('../scripts/cleanup-mobile-staging-data.sql', import.meta.url),
  'utf8',
);

test('mobile staging cleanup is explicitly guarded', () => {
  assert.match(sql, /mqxqswwssmemkimnolfu/);
  assert.match(sql, /current_user <> 'postgres'/);
  assert.match(sql, /schema_migrations WHERE version = '0053'/);
  assert.doesNotMatch(sql, /coebrkerpcgwckkwxlfo/);
});

test('mobile staging cleanup removes only the sample namespace', () => {
  assert.match(sql, /id LIKE 'STG-CUSTOMER-%'/);
  assert.match(sql, /id LIKE 'STG-PRODUCT-%'/);
  assert.match(sql, /price_list_id = 'STG-PRICELIST-MOBILE'/);
  assert.match(sql, /MOBILE_STAGING_SAMPLE_REMOVAL_AND_TEXT_REPAIR/);
});

test('mobile staging cleanup repairs anonymized names and invalid codes', () => {
  assert.match(sql, /'Khách hàng ' \|\| upper\(substr\(md5\(id\), 1, 8\)\)/);
  assert.match(sql, /'KH-ANON-' \|\| upper\(substr\(md5\(id\), 1, 12\)\)/);
  assert.match(sql, /code !~ '\^\[A-Za-z0-9\._\/-\]\+\$'/);
});
