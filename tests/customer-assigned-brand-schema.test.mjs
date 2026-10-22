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

test('assigned exclusive brand is enforced when Cloud orders are written', () => {
  const migration = read('migrations/0102_enforce_assigned_brand_on_orders.sql');
  const invoice = read('js/components/invoice.js');
  const service = read('js/services/supabase.js');

  assert.match(service, /assigned_brand_id/);
  assert.match(invoice, /function getCustomerAssignedBrandId\(/);
  assert.match(invoice, /filterInvoiceItemsToAssignedBrand\(/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.validate_customer_order_brand_scope\(\)/);
  assert.match(migration, /customer\.organization_id = NEW\.organization_id/);
  assert.match(migration, /product\.organization_id = NEW\.organization_id/);
  assert.match(migration, /NEW\.items/);
  assert.match(migration, /NEW\.customer_id/);
  assert.match(migration, /ERRCODE = '23514'/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF items, customer_id, organization_id ON public\.orders/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF items, customer_id, organization_id ON public\.draft_orders/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.validate_customer_order_brand_scope\(\) FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(migration, /DELETE FROM public\.(?:orders|order_items)|TRUNCATE/i);
});
