import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const main = readFileSync(new URL('../js/main.js', import.meta.url), 'utf8');
const users = readFileSync(new URL('../js/components/users.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

test('Supabase invite and recovery links both open the password setup modal', () => {
  assert.match(main, /type=\(invite\|recovery\)/);
  assert.match(main, /openInvitationPasswordSetup\(passwordSetupAuthFlow\)/);
});

test('password setup modal adapts its copy and success message for recovery', () => {
  assert.match(html, /id="invitation-password-intro"/);
  assert.match(users, /flowType === 'recovery'/);
  assert.match(users, /Đặt lại mật khẩu SoVie/);
  assert.match(users, /Đã đặt lại mật khẩu/);
});

test('login offers a privacy-safe Supabase password recovery request', () => {
  assert.match(html, /id="btn-forgot-password"/);
  assert.match(users, /auth\.resetPasswordForEmail\(email/);
  assert.match(users, /redirectTo: redirectUrl\.toString\(\)/);
  assert.match(users, /Nếu email tồn tại/);
  assert.match(main, /event === 'PASSWORD_RECOVERY'/);
  assert.match(main, /openInvitationPasswordSetup\('recovery'\)/);
});
