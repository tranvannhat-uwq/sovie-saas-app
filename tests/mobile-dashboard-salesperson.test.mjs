import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const migration = readFileSync(new URL('../migrations/0085_mobile_admin_read_models.sql', import.meta.url), 'utf8');

test('mobile admin dashboard RPC exposes salesperson revenue to authenticated users', () => {
  const functionBody = migration.match(/CREATE OR REPLACE FUNCTION public\.rpc_mobile_admin_dashboard\([\s\S]*?AS \$\$[\s\S]*?\$\$;/i)?.[0] || '';
  assert.ok(functionBody, 'the mobile dashboard RPC must be defined in this repository');
  assert.match(functionBody, /'by_salesperson'/);
  assert.match(functionBody, /SECURITY DEFINER/i);
  assert.match(functionBody, /actor\.role <> 'admin'/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.rpc_mobile_admin_dashboard\(jsonb\) TO authenticated/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_mobile_admin_dashboard\(jsonb\) FROM PUBLIC, anon/i);
});
