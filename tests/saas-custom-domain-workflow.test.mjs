import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '0070_custom_domain_workflow.sql'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'migrations', 'tests', 'saas_custom_domain_workflow_integration.sql'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
const workspaces = fs.readFileSync(path.join(root, 'js', 'components', 'workspaces.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('custom domains are Owner-only, plan-gated and globally unique', () => {
  assert.match(migration, /rpc_request_custom_domain/);
  assert.match(migration, /ARRAY\['owner'\]/);
  assert.match(migration, /limits->>'custom_domains'/);
  assert.match(migration, /organization_domains_hostname_uidx|Hostname is already registered/);
  assert.match(integration, /starter_plan_cannot_request_custom_domain/);
  assert.match(integration, /custom_domain_quota_is_enforced/);
});

test('verification is service-only and activation requires both DNS and SSL', () => {
  assert.match(migration, /rpc_apply_domain_verification/);
  assert.match(migration, /p_verified[\s\S]*p_ssl_active/);
  assert.match(migration, /TO service_role/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /CREATE TABLE public\.domain_verification_events/);
  assert.match(integration, /service_verification_requires_dns_and_ssl/);
});

test('verification tokens remain tenant-private and disabling restores Sovie primary', () => {
  assert.match(migration, /rpc_my_custom_domain_verification/);
  assert.match(migration, /candidate\.organization_id = active_organization_id/);
  assert.match(migration, /domain_type = 'sovie_subdomain'/);
  assert.match(integration, /verification_secret_is_tenant_private/);
  assert.match(integration, /disabling_primary_restores_sovie_subdomain/);
});

test('Owner UI manages custom domain requests without exposing service verification writes', () => {
  assert.match(service, /rpc_request_custom_domain/);
  assert.match(service, /rpc_my_custom_domain_verification/);
  assert.doesNotMatch(service, /rpc_apply_domain_verification/);
  assert.match(workspaces, /renderCustomDomainManagement/);
  assert.match(html, /id="custom-domain-section"/);
  assert.match(html, /id="custom-domain-verification-output"/);
});
