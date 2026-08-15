import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LOGIN_ERROR,
  classifySupabaseError,
  loginErrorMessage,
  validateProfileRows
} from '../js/domain/auth-profile.js';

const validProfile = {
  id: 'profile-1',
  auth_user_id: '00000000-0000-0000-0000-000000000001',
  username: 'admin@test.invalid',
  role: 'admin',
  is_active: true
};

test('exactly one active profile with a valid database role is accepted', () => {
  const result = validateProfileRows([validProfile]);
  assert.equal(result.ok, true);
  assert.equal(result.profile.role, 'admin');
});

test('missing, duplicate, locked, and invalid-role profiles are distinct', () => {
  assert.equal(validateProfileRows([]).code, LOGIN_ERROR.PROFILE_NOT_LINKED);
  assert.equal(validateProfileRows([validProfile, { ...validProfile, id: 'profile-2' }]).code, LOGIN_ERROR.PROFILE_DUPLICATE);
  assert.equal(validateProfileRows([{ ...validProfile, is_active: false }]).code, LOGIN_ERROR.PROFILE_LOCKED);
  assert.equal(validateProfileRows([{ ...validProfile, role: 'owner' }]).code, LOGIN_ERROR.ROLE_INVALID);
});

test('database, RLS, and network failures produce separate safe messages', () => {
  assert.equal(classifySupabaseError({ code: '42P01', message: 'relation does not exist' }), LOGIN_ERROR.DATABASE_NOT_MIGRATED);
  assert.equal(classifySupabaseError({ code: 'PGRST205', message: 'schema cache' }), LOGIN_ERROR.DATABASE_NOT_MIGRATED);
  assert.equal(classifySupabaseError({ code: '42501', message: 'permission denied' }), LOGIN_ERROR.PROFILE_ACCESS_DENIED);
  assert.equal(classifySupabaseError({ name: 'TypeError', message: 'Failed to fetch' }), LOGIN_ERROR.NETWORK);
  assert.doesNotMatch(loginErrorMessage(LOGIN_ERROR.PROFILE_ACCESS_DENIED), /sql|select|stack|auth_user_id/i);
});

test('browser-provided role values are not inputs to profile validation', () => {
  globalThis.localStorage = { getItem: () => 'admin' };
  const result = validateProfileRows([{ ...validProfile, role: 'sale' }]);
  assert.equal(result.ok, true);
  assert.equal(result.profile.role, 'sale');
  delete globalThis.localStorage;
});
