import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('employee account creation stays behind an authenticated admin Edge Function', () => {
  const edge = read('supabase/functions/admin-create-user/index.ts');
  const users = read('js/components/users.js');
  const service = read('js/services/supabase.js');

  assert.match(edge, /auth\.getUser\(\)/);
  assert.match(edge, /callerProfile\?\.role !== 'admin'/);
  assert.match(edge, /auth\.admin\.createUser/);
  assert.match(edge, /email_confirm:\s*true/);
  assert.match(edge, /auth\.admin\.deleteUser/);
  assert.match(service, /functions\.invoke\('admin-create-user'/);
  assert.doesNotMatch(`${users}\n${service}`, /SUPABASE_SERVICE_ROLE_KEY|service_role/i);
  assert.doesNotMatch(users, /Tạo tài khoản đăng nhập trong Supabase Auth trước/);
});

test('new login accounts require an initial password without storing it in the profile', () => {
  const html = read('index.html');
  const users = read('js/components/users.js');
  const service = read('js/services/supabase.js');

  assert.match(html, /id="user-password"[^>]*type="password"|type="password"[^>]*id="user-password"/);
  assert.match(users, /initialPassword\.length < 8/);
  assert.doesNotMatch(service.match(/const dbRow = \{[\s\S]*?\n\s*\};/)?.[0] || '', /password/);
});
