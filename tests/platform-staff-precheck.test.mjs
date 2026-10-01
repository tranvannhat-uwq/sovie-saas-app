import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const service = fs.readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
const admin = fs.readFileSync(new URL('../js/components/platform-admin.js', import.meta.url), 'utf8');

test('tenant callers are prechecked before the privileged platform accounts RPC', () => {
  const method = service.slice(
    service.indexOf('export async function getPlatformCustomerAccounts'),
    service.indexOf('export async function getPlatformActivePlans')
  );
  assert.match(method, /rpc\('is_platform_staff'/);
  assert.match(method, /if \(isPlatformStaff !== true\) return null;/);
  assert.ok(method.indexOf("rpc('is_platform_staff'") < method.indexOf("rpc('rpc_platform_customer_accounts'"));
});

test('platform capability hydration is single-flight and invalidated on logout', () => {
  assert.match(admin, /let platformHydrationPromise = null/);
  assert.match(admin, /if \(platformHydrationPromise\) return platformHydrationPromise/);
  assert.match(admin, /platformStateEpoch \+= 1/);
  assert.match(admin, /platformHydrationPromise = null/);
});
