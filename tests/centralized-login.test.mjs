import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const canonicalHostScript = read('js/canonical-host.js');
const service = read('js/services/supabase.js');
const workspaceUi = read('js/components/workspaces.js');
const html = read('index.html');
const migration = read('migrations/0108_centralized_login_and_pause_custom_domains.sql');
const { canonicalAppUrl } = await import(pathToFileURL(path.join(root, 'js/domain/app-origin.js')));

function canonicalRedirect(href) {
  let redirectedTo = null;
  const url = new URL(href);
  const location = {
    href: url.href,
    hostname: url.hostname,
    origin: url.origin,
    replace: value => { redirectedTo = value; }
  };
  runInNewContext(canonicalHostScript, {
    document: { documentElement: { dataset: { canonicalHost: 'sovie.vn' } } },
    window: { location },
    URL,
    Set
  });
  return redirectedTo;
}

test('all non-local application hosts redirect to sovie.vn and preserve auth callbacks', () => {
  assert.match(html, /<script src="\/js\/canonical-host\.js"><\/script>/);
  assert.equal(canonicalRedirect('https://sovie.vn/'), null);
  assert.equal(canonicalRedirect('https://acme.sovie.vn/auth/callback?invite=1#type=invite'),
    'https://sovie.vn/auth/callback?invite=1#type=invite');
  assert.equal(canonicalRedirect('https://billing.example.vn/reset?code=abc#recovery'),
    'https://sovie.vn/reset?code=abc#recovery');
  assert.equal(canonicalRedirect('http://sovie.vn/?type=recovery'), 'https://sovie.vn/?type=recovery');
  assert.equal(canonicalRedirect('http://127.0.0.1:3000/'), null);
});

test('authenticated membership chooses the workspace and selector can switch it centrally', () => {
  assert.doesNotMatch(service, /rpc_bind_login_to_workspace_domain/);
  assert.match(service, /rpc\('rpc_my_saas_context'\)/);
  assert.match(workspaceUi, /state\.saasContext\?\.organizations/);
  assert.match(workspaceUi, /switchSaasOrganization\(organizationId\)/);
  assert.match(html, /id="workspace-select"/);
  assert.match(html, /đăng nhập tập trung tại sovie\.vn/i);
});

test('password recovery and invitations return to the canonical site', () => {
  assert.equal(canonicalAppUrl('/', { type: 'recovery' }), 'https://sovie.vn/?type=recovery');
  assert.match(read('js/components/users.js'), /redirectTo: canonicalAppUrl/);
  assert.match(read('supabase/functions/workspace-invite-member/index.ts'), /const appUrl = 'https:\/\/sovie\.vn'/);
  assert.match(read('supabase/functions/platform-create-customer/index.ts'), /const appUrl = 'https:\/\/sovie\.vn'/);
});

test('custom-domain controls are paused without deleting existing domain data', () => {
  assert.doesNotMatch(html, /custom-domain-section|custom-domain-form/);
  assert.doesNotMatch(service, /rpc_request_custom_domain|rpc_my_custom_domain_verification|rpc_set_primary_custom_domain|rpc_disable_custom_domain/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_request_custom_domain/);
  assert.match(migration, /rpc_begin_domain_dns_verification/);
  assert.match(migration, /rpc_begin_domain_ssl_provisioning/);
  assert.match(migration, /\{custom_domains\}'\s*,\s*'0'::jsonb/);
  assert.doesNotMatch(migration, /DELETE FROM public\.organization_domains|TRUNCATE public\.organization_domains/i);
});
