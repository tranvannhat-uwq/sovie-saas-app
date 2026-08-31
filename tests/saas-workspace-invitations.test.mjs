import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '0066_workspace_invitations_and_owner_transfer.sql'), 'utf8');
const edge = fs.readFileSync(path.join(root, 'supabase', 'functions', 'workspace-invite-member', 'index.ts'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
const users = fs.readFileSync(path.join(root, 'js', 'components', 'users.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('email invitations reserve quota and activate only for the invited Auth identity', () => {
  assert.match(migration, /rpc_invite_organization_member/);
  assert.match(migration, /status = 'invited'/);
  assert.match(migration, /WHERE auth_user_id = auth\.uid\(\) AND status = 'invited'/);
  assert.match(service, /rpc_accept_my_organization_invitations/);
  assert.ok(service.indexOf('rpc_accept_my_organization_invitations') < service.indexOf("rpc('rpc_my_saas_context')"));
});

test('invite Edge Function reuses existing accounts and rolls back incomplete new invitations', () => {
  assert.match(edge, /inviteUserByEmail/);
  assert.match(edge, /rpc\('rpc_add_organization_member'/);
  assert.match(edge, /rpc\('rpc_invite_organization_member'/);
  assert.match(edge, /existingAccount: true/);
  assert.match(edge, /admin\.deleteUser\(invited\.user\.id\)/);
  assert.doesNotMatch(edge, /payload\?\.redirectTo/);
});

test('Owner transfer preserves exactly one active Owner and is database authorized', () => {
  assert.match(migration, /organization_memberships_one_active_owner_uidx/);
  assert.match(migration, /has_organization_role\(active_organization_id, ARRAY\['owner'\]\)/);
  assert.match(migration, /SET role = 'admin'/);
  assert.match(migration, /SET role = 'owner'/);
  assert.match(users, /transferSaasOrganizationOwnership/);
});

test('invite completion requires a new password without current-password verification', () => {
  assert.match(html, /id="invitation-password-modal"/);
  assert.match(html, /id="invitation-new-password"/);
  assert.match(users, /openInvitationPasswordSetup/);
  assert.match(users, /auth\.updateUser\(\{ password \}\)/);
});
