import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(
  path.join(root, 'migrations/0024_sale_managed_customer_debt_history.sql'),
  'utf8'
);
const rls = fs.readFileSync(path.join(root, 'migrations/0002_auth_profiles_and_rls.sql'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');

test('Sale can read debt history only through the existing customer scope', () => {
  assert.match(migration, /FOR SELECT\s+TO authenticated/i);
  assert.match(migration, /current_profile_role\(\) = 'sale'/);
  assert.match(migration, /can_access_customer\(customer_id\)/);
  assert.match(rls, /customer\.managed_by = auth\.uid\(\)::text/);
  assert.match(rls, /lower\(customer\.managed_by\) = lower\(public\.current_profile_username\(\)\)/);
});

test('debt history access does not grant Sale direct financial writes', () => {
  assert.match(
    migration,
    /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.customer_debt_transactions FROM authenticated/i
  );
  assert.doesNotMatch(migration, /FOR (?:INSERT|UPDATE|DELETE|ALL)\b/i);
});

test('the customer detail refresh still requests only the selected customer ledger', () => {
  const refresh = service.slice(
    service.indexOf('export async function dbRefreshCustomerFinancialState'),
    service.indexOf('export async function dbDeleteCustomer')
  );
  assert.match(refresh, /fetchCustomerDebtRows\(customerId\)/);
  assert.match(service, /\.eq\('customer_id', customerId\)/);
});
