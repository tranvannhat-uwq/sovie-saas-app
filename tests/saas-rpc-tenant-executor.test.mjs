import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(
  path.join(root, 'migrations', '0060_tenant_scoped_rpc_executor.sql'),
  'utf8'
);

test('business RPCs execute as a non-login non-BYPASSRLS role', () => {
  assert.match(sql, /CREATE ROLE saas_rpc_executor NOLOGIN NOBYPASSRLS/);
  assert.match(sql, /ALTER ROLE saas_rpc_executor NOLOGIN NOBYPASSRLS/);
  assert.match(sql, /GRANT saas_rpc_executor TO %I/);
  assert.match(sql, /ALTER FUNCTION %s OWNER TO saas_rpc_executor/);
  assert.match(sql, /has_function_privilege\('authenticated'/);
});

test('the RPC executor receives only organization-scoped business policies', () => {
  assert.match(sql, /saas_rpc_executor_tenant_scope/);
  assert.match(sql, /organization_id = public\.current_organization_id\(\)/);
  assert.match(sql, /saas_rpc_executor_profile_scope/);
  assert.match(sql, /membership\.organization_id = public\.current_organization_id\(\)/);
});

test('database business roles come from active SaaS membership', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.current_profile_role\(\)/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.require_authenticated_profile\(\)/);
  assert.match(sql, /membership\.status = 'active'/);
  assert.match(sql, /WHEN 'owner' THEN 'admin'/);
  assert.match(sql, /active organization membership required/);
});

test('identity and control-plane helpers stay outside the RPC owner rewrite', () => {
  assert.match(sql, /procedure\.proname NOT IN \(/);
  assert.match(sql, /'current_organization_id'/);
  assert.match(sql, /'require_authenticated_profile'/);
});
