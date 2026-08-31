import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'migrations', '0067_organization_people_directory.sql'), 'utf8');
const integration = fs.readFileSync(path.join(root, 'migrations', 'tests', 'saas_organization_people_integration.sql'), 'utf8');
const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
const users = fs.readFileSync(path.join(root, 'js', 'components', 'users.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('standalone personnel are tenant-scoped and do not consume login membership quota', () => {
  assert.match(migration, /CREATE TABLE public\.organization_people/);
  assert.match(migration, /PRIMARY KEY \(organization_id, id\)/);
  assert.match(migration, /organization_id = public\.current_organization_id\(\)/);
  assert.doesNotMatch(migration, /INSERT INTO public\.organization_memberships[\s\S]*rpc_upsert_organization_person/);
  assert.match(integration, /owner_creates_person_without_auth_or_user_quota/);
  assert.match(integration, /other_workspace_cannot_see_person/);
});

test('personnel directory is readable by members but mutable only by Owner or Admin', () => {
  assert.match(migration, /ARRAY\['owner','admin','accounting','sale'\]/);
  assert.match(migration, /ARRAY\['owner','admin'\]/);
  assert.match(migration, /REVOKE ALL ON public\.organization_people FROM PUBLIC, anon, authenticated/);
  assert.match(integration, /sale_cannot_mutate_directory/);
});

test('workspace UI persists non-login personnel through tenant RPCs', () => {
  assert.match(service, /rpc_my_organization_people/);
  assert.match(service, /rpc_upsert_organization_person/);
  assert.match(users, /isExternal/);
  assert.match(html, /Nhân sự không đăng nhập/);
  assert.doesNotMatch(html, /value="true" disabled/);
});
