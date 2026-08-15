import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('maintenance mode is stored server-side and only admin can change it', () => {
  const migration = read('migrations/0039_admin_maintenance_mode.sql');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.system_maintenance/);
  assert.match(migration, /actor\.role <> 'admin'/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.system_maintenance FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /CREATE POLICY maintenance_admin_only[\s\S]*AS RESTRICTIVE/);
  assert.match(migration, /system maintenance in progress/);
});

test('frontend checks maintenance before loading data and exposes the control only in admin settings', () => {
  const users = read('js/components/users.js');
  const main = read('js/main.js');
  const service = read('js/services/supabase.js');
  const html = read('index.html');
  assert.ok(users.indexOf('await getMaintenanceStatus()') < users.indexOf('await fetchCloudData({'));
  assert.match(users, /state\.currentUser\.role === 'admin'/);
  assert.match(main, /state\.currentUser\?\.role !== 'admin'/);
  assert.match(service, /migrationMissing[\s\S]*available: false/);
  assert.match(html, /id="maintenance-mode-section"/);
  assert.match(html, /id="login-maintenance-notice"/);
});
