import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const migration = read('migrations/0083_platform_plan_catalog.sql');
const service = read('js/services/supabase.js');
const platform = read('js/components/platform-admin.js');
const workspaces = read('js/components/workspaces.js');
const html = read('index.html');

test('commercial plan catalog supports annual pricing without inventing prices', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS price_yearly/);
  assert.match(migration, /UPDATE public\.saas_plans[\s\S]*sort_order/);
  assert.doesNotMatch(migration, /SET price_(?:monthly|yearly)\s*=\s*[1-9]/);
  assert.match(migration, /priceMonthly/);
  assert.match(migration, /priceYearly/);
});

test('only the platform owner can mutate plans and every update is audited', () => {
  assert.match(migration, /rpc_platform_update_plan/);
  assert.match(migration, /public\.is_platform_staff\(ARRAY\['platform_owner'\]\)/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /'plan_catalog_updated'/);
  assert.match(migration, /'before'[\s\S]*'after'/);
  assert.match(migration, /A public plan must also be active/);
});

test('platform UI edits prices and quotas while tenant UI supports monthly and yearly requests', () => {
  assert.match(html, /id="btn-manage-platform-plans"/);
  assert.match(html, /id="platform-plan-form"/);
  assert.match(service, /rpc\('rpc_platform_plan_catalog'/);
  assert.match(service, /rpc\('rpc_platform_update_plan'/);
  assert.match(platform, /await updatePlatformPlan\(fields\)/);
  assert.match(workspaces, /data-cycle="monthly"/);
  assert.match(workspaces, /data-cycle="yearly"/);
  assert.match(workspaces, /button\.dataset\.cycle/);
});
