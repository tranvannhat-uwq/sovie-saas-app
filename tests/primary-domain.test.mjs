import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('current application surfaces use sovie.vn as the canonical domain', () => {
  const sources = [
    'CNAME',
    'index.html',
    'js/components/workspaces.js',
    'js/components/platform-admin.js',
    'supabase/functions/workspace-invite-member/index.ts',
    'supabase/functions/platform-create-customer/index.ts'
  ].map(read).join('\n');

  assert.match(sources, /sovie\.vn/);
  assert.doesNotMatch(sources, /sovie\.io\.vn/);
});

test('domain migration preserves rows and changes current and future workspace hostnames', () => {
  const migration = [
    read('migrations/0096_sovie_vn_primary_domain.sql'),
    read('migrations/0097_align_workspace_domains_to_sovie_vn.sql')
  ].join('\n');

  assert.match(migration, /UPDATE public\.organization_domains/);
  assert.match(migration, /lower\(organization\.slug\) \|\| '\.sovie\.vn'/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.provision_organization_capabilities/);
  assert.match(migration, /organization_domains_internal_suffix_guard/);
  assert.match(migration, /Target sovie\.vn hostname collision detected/);
  assert.match(migration, /VALUES \('0097'/);
  assert.doesNotMatch(migration, /DELETE FROM|TRUNCATE/i);
});
