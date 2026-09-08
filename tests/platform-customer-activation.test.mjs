import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const migration = read('migrations/0100_manual_trial_activation.sql');
const component = read('js/components/platform-admin.js');
const html = read('index.html');

test('manual trial activation remains owner-only, validated and fully audited', () => {
  assert.match(migration, /public\.is_platform_staff\(ARRAY\['platform_owner'\]\)/);
  assert.match(migration, /'activate', 'change_plan', 'extend_trial', 'suspend', 'reactivate', 'cancel'/);
  assert.match(migration, /Only trialing customers can be activated manually/);
  assert.match(migration, /Active SaaS plan required/);
  assert.match(migration, /Service period must contain 1 to 3650 days/);
  assert.match(migration, /SET plan_id = normalized_plan_id,[\s\S]*?status = 'active',[\s\S]*?current_period_start = now\(\)/);
  assert.match(migration, /UPDATE public\.organizations[\s\S]*?SET status = 'active', trial_ends_at = NULL/);
  assert.match(migration, /'customer_activated'/);
  assert.match(migration, /INSERT INTO public\.subscription_state_events/);
  assert.match(migration, /INSERT INTO public\.platform_customer_events/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_platform_manage_customer/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.rpc_platform_manage_customer/);
});

test('platform owner sees the activation flow only for trial subscriptions', () => {
  assert.match(component, /subscriptionStatus === 'trialing' && organization\.status === 'trialing'/);
  assert.match(component, /data-platform-action="activate"/);
  assert.match(component, /activate: \{/);
  assert.match(component, /\['activate', 'change_plan'\]\.includes\(action\)/);
  assert.match(component, /reason\.required = \['activate', 'suspend', 'cancel'\]\.includes\(action\)/);
  assert.match(component, /periodLabel\.textContent = 'Thời hạn gói \*'/);
  assert.match(html, /id="platform-lifecycle-trial-days-label"/);
  assert.match(html, /id="platform-lifecycle-trial-days-help"/);
});
