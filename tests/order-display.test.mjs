import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.localStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {}
};

const { getOrderDisplayCode } = await import('../js/domain/order-display.js');
const { getUserById, getUserDisplayName } = await import('../js/utils.js');

test('draft technical UUID is presented as a stable readable code', () => {
  const draft = {
    id: 'DRAFT-8be3526e-c8b9-4cee-9695-5592d39e66a5',
    date: '2026-08-03T02:43:00.000Z'
  };
  assert.equal(getOrderDisplayCode(draft), 'NH-20260803-8BE352');
  assert.equal(getOrderDisplayCode(draft), getOrderDisplayCode(draft));
  assert.equal(getOrderDisplayCode({ id: 'HD-20260803-000001' }), 'HD-20260803-000001');
});

test('creator auth UUID resolves to the employee display name', () => {
  const users = [{
    id: 'profile-sale-1',
    authUserId: '0b5faa42-d2a1-4461-8251-c4bd264df24e',
    username: 'sale.nhat',
    email: 'sale.nhat@example.com',
    displayName: 'Trần Văn Nhất'
  }];
  assert.equal(getUserById('0b5faa42-d2a1-4461-8251-c4bd264df24e', users), users[0]);
  assert.equal(getUserDisplayName('0b5faa42-d2a1-4461-8251-c4bd264df24e', '', users), 'Trần Văn Nhất');
});
