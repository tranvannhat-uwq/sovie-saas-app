import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(path.join(root, 'scripts/p0-link-employee-profiles-staging.sql'), 'utf8');

test('employee bootstrap links only explicit unique non-admin email matches', () => {
  assert.match(sql, /STAGING_ONLY/);
  assert.match(sql, /LINK_UNIQUE_NON_ADMIN_EMAIL_MATCHES/);
  assert.match(sql, /lower\(btrim\(profile\.username\)\)\s*=\s*lower\(btrim\(auth_user\.email\)\)/);
  assert.match(sql, /profile\.role IN \('accounting', 'sale'\)/);
  assert.doesNotMatch(sql, /SET[\s\S]{0,160}role\s*=/i);
  assert.doesNotMatch(sql, /SET[\s\S]{0,160}is_active\s*=/i);
});

test('employee bootstrap is transactional, audited, and row-count guarded', () => {
  assert.match(sql, /BEGIN;/);
  assert.match(sql, /COMMIT;/);
  assert.match(sql, /changed_count <> candidate_count/);
  assert.match(sql, /BOOTSTRAP_EMPLOYEE_AUTH_LINK/);
  assert.match(sql, /auth_user_id = candidate\.auth_user_id/);
  assert.match(sql, /profile\.auth_user_id IS NULL/);
});
