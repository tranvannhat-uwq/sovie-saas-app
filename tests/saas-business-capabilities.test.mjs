import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(
  path.join(root, 'migrations', '0061_business_capability_model.sql'), 'utf8'
);
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
const domain = await import(pathToFileURL(
  path.join(root, 'js', 'domain', 'business-capabilities.js')
));

test('capability model covers settings, modules, branches, warehouses and domains', () => {
  for (const table of ['organization_settings', 'organization_modules',
    'organization_branches', 'organization_warehouses', 'organization_domains']) {
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`));
  }
  assert.match(sql, /FOREIGN KEY \(organization_id, branch_id\)/);
  assert.match(sql, /organization_domains_hostname_uidx/);
});

test('existing and new organizations receive safe default capabilities', () => {
  assert.match(sql, /CREATE TRIGGER organizations_initialize_capabilities/);
  assert.match(sql, /FOR organization IN SELECT id, slug, name FROM public\.organizations/);
  assert.match(sql, /lower\(p_slug\) \|\| '\.sovie\.vn'/);
  assert.match(sql, /\('manufacturing', false\)/);
});

test('capability context is tenant-derived and hides domain verification secrets', () => {
  assert.match(sql, /active_organization_id uuid := public\.current_organization_id\(\)/);
  assert.match(sql, /to_jsonb\(domain\) - 'verification_token'/);
  assert.match(service, /rpc\('rpc_my_business_capabilities'\)/);
  assert.match(service, /resolveBusinessCapabilities\(capabilityData, context\.organizationId\)/);
});

test('browser capability parsing fails closed on tenant or business-type mismatch', () => {
  const valid = domain.resolveBusinessCapabilities({
    organizationId: 'org-a', settings: { business_type: 'retail' },
    modules: { sales: { enabled: true } }
  }, 'org-a');
  assert.equal(domain.isBusinessModuleEnabled(valid, 'sales'), true);
  assert.equal(domain.isBusinessModuleEnabled(valid, 'inventory'), false);
  assert.throws(() => domain.resolveBusinessCapabilities({ organizationId: 'org-b' }, 'org-a'));
  assert.throws(() => domain.resolveBusinessCapabilities({
    organizationId: 'org-a', settings: { business_type: 'paint_only' }
  }, 'org-a'));
});
