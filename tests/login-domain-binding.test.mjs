import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const migration = read('migrations/0106_workspace_domain_login_binding.sql');
const service = read('js/services/supabase.js');
const authProfile = read('js/domain/auth-profile.js');

test('login and recovered sessions bind the workspace before loading tenant data', () => {
  const bindIndex = service.indexOf("'rpc_bind_login_to_workspace_domain'");
  const contextIndex = service.indexOf("rpc('rpc_my_saas_context')", bindIndex);
  assert.ok(bindIndex >= 0);
  assert.ok(contextIndex > bindIndex);
  assert.match(service, /p_hostname:\s*hostname/);
  assert.match(service, /domainBinding\?\.allowed !== true/);
});

test('workspace login binding requires an exact active host with active SSL and membership', () => {
  assert.match(migration, /lower\(domain\.hostname\) = normalized_hostname/);
  assert.match(migration, /domain\.status = 'active'/);
  assert.match(migration, /domain\.ssl_status = 'active'/);
  assert.match(migration, /public\.can_access_organization\(active_organization_id\)/);
  assert.match(migration, /membership\.status = 'active'/);
});

test('browser origin must agree with the hostname sent to the binding RPC', () => {
  assert.match(migration, /current_setting\('request\.headers', true\)/);
  assert.match(migration, /origin_hostname <> normalized_hostname/);
});

test('a domain mismatch has a clear safe login message', () => {
  assert.match(authProfile, /WORKSPACE_DOMAIN_MISMATCH/);
  assert.match(authProfile, /không thuộc doanh nghiệp của tên miền hiện tại/i);
});
