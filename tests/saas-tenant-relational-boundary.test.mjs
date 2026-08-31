import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'migrations', '0058_tenant_relational_boundary.sql'), 'utf8');
const integration = fs.readFileSync(
  path.join(root, 'migrations', 'tests', 'saas_tenant_relational_boundary_integration.sql'),
  'utf8'
);

test('global business uniqueness is replaced by organization-scoped keys', () => {
  for (const table of ['companies', 'customers', 'products', 'purchases', 'raw_materials', 'semi_finished']) {
    assert.match(sql, new RegExp(`\\('${table}', '${table}_organization`));
  }
  assert.match(sql, /DROP CONSTRAINT IF EXISTS/);
  assert.match(integration, /duplicate_business_code_is_allowed_across_tenants/);
});

test('existing business foreign keys require the same organization', () => {
  assert.match(sql, /FOREIGN KEY \(organization_id, purchase_id\)/);
  assert.match(sql, /FOREIGN KEY \(organization_id, supplier_id\)/);
  assert.match(sql, /FOREIGN KEY \(organization_id, payment_id\)/);
  assert.match(sql, /FOREIGN KEY \(organization_id, period\)/);
  assert.match(sql, /VALIDATE CONSTRAINT/);
  assert.match(integration, /count\(\*\) = 9 AND bool_and\(convalidated AND cardinality\(conkey\) = 2\)/);
});

test('all business tables receive a restrictive tenant policy', () => {
  assert.match(sql, /AS RESTRICTIVE FOR ALL TO authenticated/);
  assert.match(sql, /organization_id = public\.current_organization_id\(\)/);
  assert.match(integration, /count\(\*\) = 35 AND bool_and\(permissive = 'RESTRICTIVE'\)/);
  assert.match(integration, /tenant_a_direct_read_cannot_see_tenant_b/);
});

test('migration remains additive to business rows', () => {
  assert.doesNotMatch(sql, /DELETE FROM|TRUNCATE|DROP TABLE/i);
  assert.match(sql, /VALUES \('0058'/);
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
});
