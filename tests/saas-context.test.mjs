import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { resolveActiveSaasContext } = await import(pathToFileURL(
  path.join(root, 'js', 'domain', 'saas-context.js')
));
const users = fs.readFileSync(path.join(root, 'js', 'components', 'users.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'js', 'main.js'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');

test('active membership is the authoritative tenant and role', () => {
  const context = resolveActiveSaasContext({
    activeOrganizationId: 'org-b',
    organizations: [
      { id: 'org-a', name: 'A', role: 'sale' },
      { id: 'org-b', name: 'B', slug: 'b', role: 'owner', status: 'active' }
    ]
  });
  assert.equal(context.organizationId, 'org-b');
  assert.equal(context.organizationRole, 'owner');
  assert.equal(context.applicationRole, 'admin');
});

test('missing membership and invalid roles fail closed', () => {
  assert.throws(() => resolveActiveSaasContext({ activeOrganizationId: 'missing', organizations: [] }));
  assert.throws(() => resolveActiveSaasContext({
    activeOrganizationId: 'org-a',
    organizations: [{ id: 'org-a', role: 'super-admin' }]
  }));
});

test('both login and recovered sessions load SaaS context before business data', () => {
  assert.match(service, /supabaseClient\.rpc\('rpc_my_saas_context'\)/);
  assert.ok(users.indexOf('await loadSaasContext({ allowMissingOrganization: true })') < users.indexOf('await fetchCloudData({'));
  assert.ok(main.indexOf('await loadSaasContext({ allowMissingOrganization: true })') < main.indexOf('await fetchCloudData({'));
  assert.match(users, /role: tenantContext\.applicationRole/);
  assert.match(main, /role: tenantContext\.applicationRole/);
});

test('logout clears tenant identity', () => {
  assert.match(users, /state\.saasContext = null/);
  assert.match(users, /state\.activeOrganizationId = ''/);
});
