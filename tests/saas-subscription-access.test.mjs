import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '0068_subscription_access_lifecycle.sql'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'migrations', 'tests', 'saas_subscription_access_integration.sql'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
const workspaces = fs.readFileSync(path.join(root, 'js', 'components', 'workspaces.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('subscription lifecycle has full, grace and read-only database access states', () => {
  assert.match(migration, /organization_write_access_allowed/);
  assert.match(migration, /interval '7 days'/);
  assert.match(migration, /interval '30 days'/);
  assert.match(migration, /'full'/);
  assert.match(migration, /'grace'/);
  assert.match(migration, /'read_only'/);
  assert.match(integration, /paused_subscription_is_read_only/);
  assert.match(integration, /paused_subscription_blocks_real_table_write/);
});

test('all business mutations receive a restrictive subscription guard', () => {
  assert.match(migration, /AS RESTRICTIVE FOR INSERT/);
  assert.match(migration, /AS RESTRICTIVE FOR UPDATE/);
  assert.match(migration, /AS RESTRICTIVE FOR DELETE/);
  assert.match(migration, /TO authenticated, saas_rpc_executor/);
  assert.match(migration, /public\.organization_write_access_allowed\(organization_id\)/);
});

test('subscription changes are service-only, audited and idempotent', () => {
  assert.match(migration, /CREATE TABLE public\.subscription_state_events/);
  assert.match(migration, /event_key text NOT NULL UNIQUE/);
  assert.match(migration, /TO service_role/);
  assert.match(migration, /FROM PUBLIC, anon, authenticated/);
  assert.match(integration, /provider_events_are_idempotent/);
  assert.match(integration, /browser_cannot_apply_subscription_events/);
});

test('browser reads authoritative access state and displays grace or read-only notice', () => {
  assert.match(service, /rpc_my_subscription_access/);
  assert.match(service, /subscriptionAccess/);
  assert.match(workspaces, /renderSubscriptionAccessNotice/);
  assert.match(workspaces, /accessMode/);
  assert.match(html, /id="subscription-access-notice"/);
});
