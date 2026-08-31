import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'migrations', '0064_workspace_member_management.sql'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'admin-create-user', 'index.ts'), 'utf8');
const users = fs.readFileSync(path.join(root, 'js', 'components', 'users.js'), 'utf8');

test('workspace membership is the only browser user-directory boundary', () => {
  assert.match(sql, /rpc_my_organization_members/);
  assert.match(sql, /JOIN public\.profiles profile ON profile\.auth_user_id = membership\.auth_user_id/);
  assert.match(sql, /profiles_tenant_select/);
  assert.match(sql, /REVOKE INSERT, UPDATE, DELETE ON public\.profiles FROM authenticated/);
  assert.match(service, /rpc\('rpc_my_organization_members'\)/);
  assert.doesNotMatch(service.slice(service.indexOf('const fetchUsers = async')), /\.from\(tableUsersName\)\s*\.select/);
});

test('member mutations are tenant-derived, role protected and quota serialized', () => {
  assert.match(sql, /public\.current_organization_id\(\)/);
  assert.match(sql, /has_organization_role\(active_organization_id, ARRAY\['owner','admin'\]\)/);
  assert.match(sql, /FOR UPDATE/);
  assert.match(sql, /limits->>'users'/);
  assert.match(sql, /target\.role = 'owner'/);
  assert.match(sql, /cannot suspend your own active membership/);
});

test('Auth account creation attaches membership or rolls the Auth user back', () => {
  assert.match(edge, /rpc\('rpc_my_saas_context'\)/);
  assert.match(edge, /\['owner', 'admin'\]/);
  assert.match(edge, /rpc\('rpc_add_organization_member'/);
  assert.match(edge, /admin\.deleteUser\(created\.user\.id\)/);
});

test('member UI supports workspace status without deleting global identities', () => {
  assert.match(service, /rpc\('rpc_update_organization_member'/);
  assert.match(users, /membershipStatus/);
  assert.match(users, /Khóa thành viên/);
  assert.match(users, /doanh nghiệp khác không bị ảnh hưởng/);
});
