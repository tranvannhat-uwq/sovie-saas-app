import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const style = readFileSync(new URL('../style.css', import.meta.url), 'utf8');
const users = readFileSync(new URL('../js/components/users.js', import.meta.url), 'utf8');
const platform = readFileSync(new URL('../js/components/platform-admin.js', import.meta.url), 'utf8');
const migration = readFileSync(new URL('../migrations/0080_platform_customer_account_console.sql', import.meta.url), 'utf8');
const transfer = readFileSync(new URL('../scripts/transfer-platform-owner-staging.sql', import.meta.url), 'utf8');

test('public SoVie landing page opens a closable login overlay', () => {
  assert.match(html, /id="landing-page"/);
  assert.match(html, /class="landing-login-button js-open-login"/);
  assert.match(html, /id="btn-close-login"/);
  assert.match(main, /querySelectorAll\('\.js-open-login'\)/);
  assert.match(main, /event\.target\.closest\('\.js-open-login'\)/);
  assert.match(main, /document\.readyState === 'loading'/);
  assert.match(users, /landingPage\.style\.display = 'none'/);
});

test('login overlay stays centered when JavaScript opens it as flex', () => {
  assert.match(main, /loginScreen\.style\.display = 'flex'/);
  assert.match(style, /\.login-overlay\s*\{[\s\S]*?justify-content:\s*center;[\s\S]*?align-items:\s*center;[\s\S]*?box-sizing:\s*border-box;/);
  assert.match(style, /\.login-shell\s*\{[\s\S]*?margin-inline:\s*auto;/);
  assert.match(style, /@media \(max-width: 820px\)[\s\S]*?\.login-overlay\s*\{[^}]*align-items:\s*flex-start;/);
});

test('platform customer console is separate from tenant admin permissions', () => {
  assert.match(html, /id="platform-admin-panel"/);
  assert.match(users, /target === 'platform-admin-panel'/);
  assert.match(users, /state\.platformRole \? 'block' : 'none'/);
  assert.match(platform, /rpc_platform_customer_accounts|platformRole/);
});

test('platform owner can sign in without becoming a tenant member', () => {
  assert.match(users, /export function createPlatformOnlyUser/);
  assert.match(users, /role: 'platform'/);
  assert.match(users, /const platformOnly = Boolean\(state\.platformRole && !user\.organizationId\)/);
  assert.match(users, /target === 'platform-admin-panel' \? 'block' : 'none'/);
  assert.match(main, /if \(platformRole\) activeUser = createPlatformOnlyUser\(profile\)/);
  assert.match(main, /if \(activeUser\.organizationId\) \{\s*recoveredCloudLoad = await fetchCloudData/);
  assert.match(main, /state\.platformRole && !state\.currentUser\?\.organizationId && panelId !== 'platform-admin-panel'/);
});

test('platform access is an explicit allowlist and never inferred from tenant role or email', () => {
  assert.match(migration, /CREATE TABLE public\.platform_staff/);
  assert.match(migration, /staff\.auth_user_id = auth\.uid\(\)/);
  assert.match(migration, /RAISE EXCEPTION '403: platform staff required'/);
  assert.doesNotMatch(migration, /profile\.role\s*=\s*'admin'/i);
  assert.doesNotMatch(migration, /email\s+(?:like|ilike|=)/i);
  assert.match(migration, /REVOKE ALL ON public\.platform_staff FROM PUBLIC, anon, authenticated/);
});

test('staging platform ownership transfer keeps the new owner outside customer organizations', () => {
  assert.match(transfer, /lower\(email\) = 'tvnhat10083@gmail\.com'/);
  assert.match(transfer, /IF EXISTS \([\s\S]*public\.organization_memberships[\s\S]*new_owner_id/);
  assert.match(transfer, /DELETE FROM public\.platform_staff\s+WHERE auth_user_id = old_owner_id/);
  assert.match(transfer, /RAISE EXCEPTION 'Platform ownership verification failed; transaction rolled back'/);
});
