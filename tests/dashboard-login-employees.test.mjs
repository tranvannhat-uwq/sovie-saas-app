import assert from 'node:assert/strict';
import test from 'node:test';

import { filterLoginEmployeeRevenueRows } from '../js/domain/dashboard-employees.js';

const users = [
  { id: 'profile-1', authUserId: 'auth-1', username: 'ms.dung', displayName: 'Ms Dung', isExternal: false, isActive: true },
  { id: 'profile-2', authUserId: 'auth-2', username: 'mr.vui', displayName: 'Mr Vui', isExternal: false, isActive: true },
  { id: 'external-1', authUserId: null, username: 'abs-japan', displayName: 'ABS JAPAN (Công ty)', isExternal: true, isActive: true },
  { id: 'profile-disabled', authUserId: 'auth-disabled', username: 'disabled', displayName: 'Đã khóa', isExternal: false, isActive: false },
  { id: 'profile-unlinked', authUserId: null, username: 'unlinked', displayName: 'Chưa có đăng nhập', isExternal: false, isActive: true }
];

test('salesperson revenue includes only active profiles linked to login accounts', () => {
  const rows = filterLoginEmployeeRevenueRows([
    { key: 'auth-1', amount: 100 },
    { key: 'mr.vui', amount: 80 },
    { key: 'abs-japan', amount: 70 },
    { key: 'disabled', amount: 60 },
    { key: 'unlinked', amount: 50 },
    { key: 'unassigned', amount: 40 }
  ], users);

  assert.deepEqual(rows, [
    { key: 'ms.dung', amount: 100 },
    { key: 'mr.vui', amount: 80 }
  ]);
});

test('historical identifiers for one login employee are combined into one bar', () => {
  const rows = filterLoginEmployeeRevenueRows([
    { key: 'profile-1', amount: 25 },
    { key: 'AUTH-1', amount: 35 },
    { key: 'MS.DUNG', amount: 40 }
  ], users);

  assert.deepEqual(rows, [{ key: 'ms.dung', amount: 100 }]);
});
