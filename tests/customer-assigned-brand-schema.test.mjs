import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('customer brand id written by the browser exists in the migration chain', () => {
  const service = read('js/services/supabase.js');
  const component = read('js/components/customers.js');
  const migration = read('migrations/0094_customer_assigned_brand_id.sql');

  assert.match(service, /assigned_brand_id: customer\.assignedBrandId \|\| null/);
  assert.match(component, /assignedBrand === 'Tất cả'[\s\S]*?\? null/);
  assert.doesNotMatch(component, /assignedBrand === 'Tất cả' \? 'Tất cả'/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS assigned_brand_id text/);
  assert.match(migration, /FOREIGN KEY \(assigned_brand_id\)[\s\S]*REFERENCES public\.brands\(id\)/);
  assert.match(migration, /customer\.organization_id = brand\.organization_id/);
  assert.doesNotMatch(migration, /DELETE FROM|TRUNCATE/i);
});

test('sale customer policy resolves identity without protected auth schema access', () => {
  const migration = read('migrations/0095_customer_access_request_claim_identity.sql');

  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.can_access_customer/);
  assert.match(migration, /current_setting\('request\.jwt\.claim\.sub', true\)/);
  assert.doesNotMatch(migration, /auth\.uid\(\)/);
  assert.doesNotMatch(migration, /GRANT\s+USAGE\s+ON\s+SCHEMA\s+auth/i);
});
