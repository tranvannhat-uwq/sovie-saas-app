import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(
  path.join(root, 'migrations', '0101_rpc_executor_dependency_permissions.sql'),
  'utf8'
);

test('order price-list helper is executable only by the internal RPC executor', () => {
  assert.match(
    sql,
    /REVOKE ALL ON FUNCTION public\.p1_price_list_is_effective\(public\.pricelists\)[\s\S]*FROM PUBLIC, anon, authenticated/
  );
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION public\.p1_price_list_is_effective\(public\.pricelists\)[\s\S]*TO saas_rpc_executor/
  );
  assert.match(sql, /NOT rolcanlogin[\s\S]*NOT rolbypassrls/);
});

test('all reachable business RPC dependencies receive and verify executor access', () => {
  assert.match(sql, /WITH RECURSIVE functions AS/);
  assert.match(sql, /JOIN edges edge ON edge\.caller_oid = parent\.oid/);
  assert.match(
    sql,
    /GRANT EXECUTE ON FUNCTION %s TO saas_rpc_executor/
  );
  assert.match(sql, /RPC executor lacks dependency privileges/);
});

test('migration records the permission repair', () => {
  assert.match(
    sql,
    /VALUES \('0101', 'Grant private business RPC dependencies to the tenant-scoped executor'\)/
  );
});
