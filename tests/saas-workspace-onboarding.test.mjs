import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(
  path.join(root, 'migrations', '0063_workspace_onboarding_and_switching.sql'), 'utf8'
);
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
const workspaceUi = fs.readFileSync(path.join(root, 'js', 'components', 'workspaces.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('first workspace requires Auth profile but not a prior membership', () => {
  assert.match(sql, /profile\.auth_user_id = auth\.uid\(\) AND profile\.is_active = true/);
  const createBody = sql.slice(sql.indexOf('CREATE OR REPLACE FUNCTION public.rpc_create_organization(\n'));
  assert.doesNotMatch(createBody, /require_authenticated_profile\(\)/);
  assert.match(sql, /First-workspace onboarding deliberately does not require an existing/);
});

test('organization creation atomically initializes business type and trial', () => {
  assert.match(sql, /UPDATE public\.organization_settings[\s\S]*business_type = normalized_business_type/);
  assert.match(sql, /INSERT INTO public\.organization_memberships/);
  assert.match(sql, /'owner', 'active', true/);
  assert.match(sql, /INSERT INTO public\.organization_subscriptions/);
  assert.match(sql, /'starter', 'trialing'/);
});

test('slug validation rejects reserved, malformed and duplicate hostnames', () => {
  assert.match(sql, /rpc_validate_organization_slug/);
  assert.match(sql, /'www','app','api','admin','auth','dashboard','billing'/);
  assert.match(sql, /Organization slug is reserved/);
  assert.match(sql, /Organization slug is already in use/);
});

test('new users may onboard while invalid existing tenant roles still fail closed', () => {
  assert.match(service, /loadSaasContext\(\{ allowMissingOrganization = false \} = \{\}\)/);
  assert.match(service, /if \(allowMissingOrganization &&/);
  assert.match(service, /const context = resolveActiveSaasContext\(data\)/);
  assert.match(workspaceUi, /openWorkspaceOnboarding\(\{ required = false \} = \{\}\)/);
});

test('workspace onboarding remains available without company selection in the account menu', () => {
  assert.match(service, /rpc_validate_organization_slug/);
  assert.match(service, /rpc_create_organization/);
  assert.match(service, /rpc_set_default_organization/);
  assert.match(workspaceUi, /window\.location\.reload\(\)/);
  for (const id of [
    'workspace-current-name',
    'workspace-current-domain',
    'workspace-plan-usage',
    'workspace-onboarding-modal',
    'workspace-onboarding-form'
  ]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.doesNotMatch(html, /id="(?:workspace-select|btn-switch-workspace|btn-create-workspace)"/);
});
