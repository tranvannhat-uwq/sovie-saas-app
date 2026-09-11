import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertValidMigrationChain } from '../scripts/migration-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migrationDir = path.join(root, 'migrations');
const migrationNames = assertValidMigrationChain(migrationDir);
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('P0 migrations are ordered and tracked', () => {
  const actual = fs.readdirSync(migrationDir)
    .filter(name => /^\d{4}_.+\.sql$/.test(name))
    .sort();
  assert.deepEqual(actual, migrationNames);
  migrationNames.forEach((name, index) => {
    const sql = read(path.join('migrations', name));
    const version = String(index + 1).padStart(4, '0');
    assert.match(sql, new RegExp(`VALUES \\('${version}'`));
    assert.match(sql, /BEGIN;/);
    assert.match(sql, /COMMIT;/);
  });
});

test('new migration chain never grants anon business access', () => {
  const sql = migrationNames.map(name => read(path.join('migrations', name))).join('\n');
  assert.doesNotMatch(sql, /GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL|EXECUTE)[\s\S]{0,120}\bTO\s+anon\b/i);
  assert.doesNotMatch(sql, /CREATE\s+POLICY[\s\S]{0,240}(?:USING|WITH\s+CHECK)\s*\(true\)[\s\S]{0,80}\bTO\s+anon\b/i);
  assert.match(sql, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, anon, authenticated/i);
  assert.match(sql, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/i);
});

test('roles and financial actors come from auth-linked profiles', () => {
  const authSql = read('migrations/0002_auth_profiles_and_rls.sql');
  const rpcSql = read('migrations/0003_secure_rpc_boundary.sql');
  assert.match(authSql, /auth_user_id\s*=\s*auth\.uid\(\)/);
  assert.match(authSql, /'sale', false, true/);
  assert.doesNotMatch(authSql, /raw_user_meta_data->>'role'/);
  assert.doesNotMatch(authSql, /lower\(auth_user\.email\)\s*=\s*lower\(legacy\.username\)/);
  assert.match(authSql, /NULL::uuid/);
  assert.match(rpcSql, /actor\s*:=\s*public\.require_authenticated_profile\(\)/);
  assert.match(rpcSql, /actor\.auth_user_id/);
  assert.match(rpcSql, /NOT public\.can_use_price_list/);
});

test('profile identity integrity is enforced by migration 0005', () => {
  const sql = read('migrations/0005_profile_identity_integrity.sql');
  assert.match(sql, /FOREIGN KEY \(auth_user_id\) REFERENCES auth\.users\(id\)/);
  assert.match(sql, /UNIQUE \(auth_user_id\)/);
  assert.match(sql, /role IN \('admin', 'accounting', 'sale'\)/);
  assert.match(sql, /auth_user_id = auth\.uid\(\)/);
  assert.match(sql, /rpc_my_profile_link_status/);
  assert.doesNotMatch(sql, /email[^\n]{0,80}(?:admin|role)/i);
});

test('admin bootstrap requires explicit staging and elevation confirmations', () => {
  const sql = read('scripts/p0-bootstrap-admin-staging.sql');
  assert.match(sql, /environment_confirmation.*STAGING_ONLY/s);
  assert.match(sql, /I_UNDERSTAND_GRANT_ADMIN/);
  assert.match(sql, /Expected exactly one existing Auth user/);
  assert.match(sql, /Expected exactly one legacy profile/);
  assert.match(sql, /already linked to a different Auth user/);
  assert.match(sql, /Auth user is already linked to a different profile/);
  assert.match(sql, /GET DIAGNOSTICS changed_count = ROW_COUNT/);
  assert.match(sql, /INSERT INTO public\.audit_logs/);
  assert.doesNotMatch(sql, /@[a-z0-9.-]+\.[a-z]{2,}/i);
});

test('frontend contains no local or session authorization fallback', () => {
  const users = read('js/components/users.js');
  const main = read('js/main.js');
  const service = read('js/services/supabase.js');
  const combined = `${users}\n${main}\n${service}`;
  assert.doesNotMatch(combined, /password\s*:\s*['"][^'"]+['"]/);
  assert.doesNotMatch(combined, /sessionStorage\.getItem\('billing_system_auth'\)/);
  assert.doesNotMatch(combined, /localStorage\.getItem\('billing_system_users'\)/);
  assert.doesNotMatch(combined, /\.auth\.signUp\(/);
  assert.doesNotMatch(combined, /localStorage\.setItem\('billing_system_(?:pricelists|price_list_items)'/);
  assert.doesNotMatch(combined, /localStorage\.getItem\('billing_system_(?:pricelists|price_list_items)'/);
  assert.match(service, /tableUsersName = 'profiles'/);
});

test('frontend profile bootstrap uses the Auth session UUID and clears rejected sessions', () => {
  const users = read('js/components/users.js');
  const main = read('js/main.js');
  assert.match(users, /data\?\.session\?\.user/);
  assert.match(users, /\.eq\('auth_user_id', authUserId\)/);
  assert.match(users, /validateProfileRows/);
  assert.match(users, /rpc_my_profile_link_status/);
  assert.match(users, /await supabaseClient\.auth\.signOut\(\)/);
  assert.match(users, /clearAuthenticatedSessionState\(\)/);
  assert.doesNotMatch(users, /\.eq\('is_active', true\)\s*\.single\(\)/);
  assert.doesNotMatch(users, /from\(['"]users['"]\)/);
  assert.match(main, /loadAuthenticatedProfile\(session\.user\.id\)/);
});

test('SQL integration fixtures tolerate automatic auth profile triggers', () => {
  const suites = [
    'phase1_order_pricing_integration.sql',
    'phase2_financial_reversals_integration.sql',
    'phase3_sales_returns_integration.sql',
    'phase4_supplier_purchases_integration.sql'
  ];
  for (const suite of suites) {
    const sql = read(path.join('migrations', 'tests', suite));
    assert.doesNotMatch(sql, /ON CONFLICT \(id\) DO UPDATE SET auth_user_id/i);
    assert.match(sql, /ON CONFLICT DO NOTHING;[\s\S]*UPDATE public\.profiles/);
  }
});
