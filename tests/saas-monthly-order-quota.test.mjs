import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '0069_monthly_order_quota.sql'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'migrations', 'tests', 'saas_monthly_order_quota_integration.sql'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
const workspaces = fs.readFileSync(path.join(root, 'js', 'components', 'workspaces.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('monthly order quota is tenant-derived and serialized in the database', () => {
  assert.match(migration, /enforce_monthly_order_quota/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /limits->>'monthly_orders'/);
  assert.match(migration, /NEW\.organization_id <> public\.current_organization_id\(\)/);
  assert.match(migration, /BEFORE INSERT ON public\.orders/);
  assert.match(integration, /third_order_is_blocked/);
  assert.match(integration, /quota_is_independent_per_tenant/);
  assert.match(integration, /browser_cannot_bypass_order_rpc/);
});

test('quota uses confirmation month and excludes draft or cancelled records', () => {
  assert.match(migration, /COALESCE\(sale\.confirmed_at, sale\.created_at\)/);
  assert.match(migration, /AT TIME ZONE 'Asia\/Bangkok'/);
  assert.match(migration, /NOT IN \('draft','cancelled','canceled'\)/);
  assert.match(integration, /cancelled_order_does_not_consume_quota/);
});

test('workspace UI loads authoritative plan usage', () => {
  assert.match(service, /rpc_my_plan_usage/);
  assert.match(workspaces, /workspace-plan-usage/);
  assert.match(html, /id="workspace-plan-usage"/);
});
