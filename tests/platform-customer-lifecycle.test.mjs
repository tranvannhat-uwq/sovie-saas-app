import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const migration = read('migrations/0082_platform_customer_lifecycle.sql');
const service = read('js/services/supabase.js');
const component = read('js/components/platform-admin.js');
const html = read('index.html');

test('platform lifecycle RPC is owner-only, validated and auditable', () => {
  assert.match(migration, /public\.is_platform_staff\(ARRAY\['platform_owner'\]\)/);
  assert.match(migration, /'change_plan','extend_trial','suspend','reactivate','cancel'/);
  assert.match(migration, /FOR UPDATE/);
  assert.match(migration, /INSERT INTO public\.subscription_state_events/);
  assert.match(migration, /INSERT INTO public\.platform_customer_events/);
  assert.match(migration, /Trial extension must contain 1 to 60 days/);
  assert.match(migration, /Type the exact customer slug to confirm cancellation/);
});

test('suspension is reversible while cancellation keeps a 30-day read-only window', () => {
  assert.match(migration, /SET status = 'paused'/);
  assert.match(migration, /Only suspended customers can be reactivated/);
  assert.match(migration, /SET status = 'active'/);
  assert.match(migration, /SET status = 'cancelled'[\s\S]*read_only_ends_at = now\(\) \+ interval '30 days'/);
  assert.doesNotMatch(migration, /DELETE FROM public\.(?:organizations|organization_memberships)/);
});

test('platform console exposes all lifecycle actions with destructive confirmation', () => {
  assert.match(service, /rpc\('rpc_platform_manage_customer'/);
  assert.match(component, /managePlatformCustomer\(payload\)/);
  for (const action of ['change_plan', 'extend_trial', 'suspend', 'reactivate', 'cancel']) {
    assert.match(component, new RegExp(`${action}:`));
  }
  assert.match(html, /id="platform-lifecycle-form"/);
  assert.match(html, /id="platform-lifecycle-confirmation"/);
  assert.match(component, /confirmation\.required = action === 'cancel'/);
});
