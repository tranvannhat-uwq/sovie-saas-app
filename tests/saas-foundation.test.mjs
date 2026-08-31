import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'migrations', '0056_saas_control_plane.sql'), 'utf8');
const integrationSql = fs.readFileSync(
  path.join(root, 'migrations', 'tests', 'saas_control_plane_integration.sql'),
  'utf8'
);

test('SaaS control plane defines organizations, membership and subscriptions', () => {
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.organizations/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.organization_memberships/);
  assert.match(sql, /UNIQUE \(organization_id, auth_user_id\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.organization_subscriptions/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.saas_plans/);
});

test('staging integration matrix exercises two isolated tenants', () => {
  assert.match(integrationSql, /tenant_a_reads_only_its_organization/);
  assert.match(integrationSql, /tenant_b_reads_only_its_organization/);
  assert.match(integrationSql, /tenant_a_cannot_select_tenant_b/);
  assert.match(integrationSql, /authenticated_cannot_mutate_subscription_directly/);
  assert.match(integrationSql, /ROLLBACK;/);
});

test('existing identities are backfilled without unauthenticated profiles', () => {
  assert.match(sql, /WHERE profile\.auth_user_id IS NOT NULL/);
  assert.match(sql, /legacy-weblendon/);
  assert.match(sql, /ON CONFLICT \(organization_id, auth_user_id\) DO NOTHING/);
});

test('tenant helpers derive access only from auth membership', () => {
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.can_access_organization/);
  assert.match(sql, /membership\.auth_user_id = auth\.uid\(\)/);
  assert.match(sql, /membership\.status = 'active'/);
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.current_organization_id/);
  assert.doesNotMatch(sql, /raw_user_meta_data/);
});

test('onboarding is authenticated, atomic and creates a trial subscription', () => {
  assert.match(sql, /actor := public\.require_authenticated_profile\(\)/);
  assert.match(sql, /INSERT INTO public\.organizations/);
  assert.match(sql, /'owner', 'active', true/);
  assert.match(sql, /'starter', 'trialing'/);
  assert.match(sql, /now\(\) \+ interval '14 days'/);
  assert.match(sql, /EXCEPTION WHEN unique_violation/);
});

test('SaaS tables use RLS and expose no anonymous access', () => {
  for (const table of ['saas_plans', 'organizations', 'organization_memberships', 'organization_subscriptions']) {
    assert.match(sql, new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.doesNotMatch(sql, /GRANT[\s\S]{0,100}\bTO anon\b/i);
  assert.match(sql, /REVOKE ALL ON TABLE[\s\S]+FROM PUBLIC, anon, authenticated/);
  assert.match(sql, /organization_subscriptions_member_read/);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE)[^;]*organization_memberships/i);
  assert.doesNotMatch(sql, /GRANT (?:INSERT|UPDATE|DELETE)[^;]*organization_subscriptions/i);
});
