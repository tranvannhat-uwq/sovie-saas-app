import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = relative => readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const migration = read('migrations/0081_platform_customer_provisioning.sql');
const hardening = read('migrations/0098_platform_customer_provisioning_hardening.sql');
const edge = read('supabase/functions/platform-create-customer/index.ts');
const service = read('js/services/supabase.js');
const component = read('js/components/platform-admin.js');
const html = read('index.html');

test('platform customer provisioning is restricted and atomically initializes the tenant', () => {
  assert.match(migration, /public\.is_platform_staff\(ARRAY\['platform_owner'\]\)/);
  assert.match(migration, /Platform staff cannot own a customer organization/);
  assert.match(migration, /INSERT INTO public\.organizations/);
  assert.match(migration, /INSERT INTO public\.organization_memberships[\s\S]*'owner', 'invited'/);
  assert.match(migration, /INSERT INTO public\.organization_subscriptions/);
  assert.match(migration, /INSERT INTO public\.platform_customer_events/);
  assert.match(migration, /p_trial_days < 1 OR p_trial_days > 60/);
  assert.match(migration, /REVOKE ALL ON public\.platform_customer_events FROM PUBLIC, anon, authenticated/);
});

test('platform invitation function verifies the caller and compensates failed provisioning', () => {
  assert.match(edge, /rpc\('is_platform_staff', \{ p_roles: \['platform_owner'\] \}\)/);
  assert.match(edge, /inviteUserByEmail\(payload\.email/);
  assert.match(edge, /auth\.admin\.listUsers\(\{ page, perPage: 1000 \}\)/);
  assert.match(edge, /rpc\('rpc_platform_provision_customer'/);
  const rollbackStart = edge.indexOf('if (createdAuthUserId)');
  const profileDelete = edge.indexOf(".from('profiles').delete().eq('auth_user_id', createdAuthUserId)", rollbackStart);
  const authDelete = edge.indexOf('auth.admin.deleteUser(createdAuthUserId)', rollbackStart);
  assert.ok(rollbackStart >= 0 && profileDelete > rollbackStart && authDelete > profileDelete);
  assert.match(edge, /typeof error === 'object' && 'message' in error/);
  assert.match(edge, /jsonResponse\(\{ error: getErrorMessage\(error\) \}, 400\)/);
  assert.doesNotMatch(edge, /payload\?\.password|password:/);
});

test('all tenant inputs are validated before an Auth invitation is sent', () => {
  assert.ok(edge.indexOf('const payload = validatePayload') < edge.indexOf('inviteUserByEmail'));
  assert.ok(edge.indexOf("rpc('rpc_validate_organization_slug'") < edge.indexOf('inviteUserByEmail'));
  assert.ok(edge.indexOf("from('saas_plans')") < edge.indexOf('inviteUserByEmail'));
  assert.match(edge, /normalizeIndustryKey/);
  assert.match(edge, /'da-nganh': 'general'/);
});

test('database provisioning rejects hostname collisions and incomplete workspaces atomically', () => {
  assert.match(hardening, /organization_domains[\s\S]*normalized_hostname/);
  assert.match(hardening, /Workspace hostname is already in use/);
  assert.match(hardening, /Workspace capability provisioning is incomplete/);
  assert.match(hardening, /Workspace domain provisioning failed/);
  assert.match(hardening, /Workspace membership or subscription provisioning failed/);
  assert.match(hardening, /VALUES \('0098'/);
});

test('platform console exposes a validated create-customer workflow', () => {
  assert.match(html, /id="btn-create-platform-customer"/);
  assert.match(html, /id="platform-customer-form"/);
  assert.match(html, /id="platform-customer-industry" name="industryKey" required/);
  assert.match(html, /value="general">Đa ngành \/ Tổng hợp/);
  assert.doesNotMatch(html, /id="platform-customer-industry"[^>]*<input/);
  assert.match(html, /Tạo và gửi lời mời/);
  assert.match(service, /functions\.invoke\('platform-create-customer'/);
  assert.match(service, /await error\.context\?\.json\?\.\(\)/);
  assert.match(component, /await validateSaasOrganizationSlug\(slug\)/);
  assert.match(component, /await createPlatformCustomer/);
  assert.match(component, /Khách hàng đã được tạo thành công và vừa được đồng bộ lại/);
  assert.match(component, /Customer created but platform list refresh failed/);
  assert.match(component, /state\.platformRole !== 'platform_owner'/);
});
