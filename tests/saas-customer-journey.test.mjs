import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const html = read('index.html');
const main = read('js/main.js');
const users = read('js/components/users.js');
const service = read('js/services/supabase.js');
const workspaces = read('js/components/workspaces.js');
const dashboard = read('js/components/dashboard.js');

test('customer journey uses one personal password and no organization password', () => {
  assert.equal((html.match(/id="login-password"/g) || []).length, 1);
  assert.doesNotMatch(html, /mật khẩu doanh nghiệp/i);
  assert.match(users, /auth\.signInWithPassword/);
  assert.match(users, /loadSaasContext\(\{ allowMissingOrganization: true \}\)/);
});

test('authenticated users accept invitations before tenant context is resolved', () => {
  const acceptIndex = service.indexOf("rpc_accept_my_organization_invitations");
  const contextIndex = service.indexOf("rpc_my_saas_context");
  assert.ok(acceptIndex >= 0 && contextIndex > acceptIndex);
});

test('a user without a workspace is routed into required onboarding', () => {
  assert.match(users, /openWorkspaceOnboarding\(\{ required: true \}\)/);
  assert.match(workspaces, /rpc_create_organization|createSaasOrganization/);
  assert.match(workspaces, /Starter trong 14 ngày/);
});

test('an established tenant can switch workspace and follow first-run actions', () => {
  assert.match(workspaces, /switchSaasOrganization\(organizationId\)/);
  assert.match(main, /renderWorkspaceSwitcher\(\)/);
  assert.match(dashboard, /renderOnboardingChecklist\(\)/);
  assert.match(dashboard, /target: 'invoice-panel'/);
});
