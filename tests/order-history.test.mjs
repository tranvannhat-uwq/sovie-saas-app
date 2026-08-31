import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isEffectiveOrderHistoryRow,
  isOrderInHistoryWindow,
  mapOrderHistoryRow,
  matchesOrderHistoryStatus
} from '../js/domain/order-history.js';

test('order history status aliases preserve settled and cancelled semantics', () => {
  assert.equal(matchesOrderHistoryStatus({ status: 'confirmed' }, 'settled'), true);
  assert.equal(matchesOrderHistoryStatus({ status: 'canceled' }, 'cancelled'), true);
  assert.equal(matchesOrderHistoryStatus({ status: 'draft' }, 'settled'), false);
  assert.equal(matchesOrderHistoryStatus({ status: 'returned' }, 'returned'), true);
});

test('unfiltered order history excludes drafts, cancellations, and deleted rows', () => {
  assert.equal(isEffectiveOrderHistoryRow({ status: 'settled' }), true);
  assert.equal(isEffectiveOrderHistoryRow({ status: 'draft' }), false);
  assert.equal(isEffectiveOrderHistoryRow({ status: 'cancelled' }), false);
  assert.equal(isEffectiveOrderHistoryRow({ status: 'settled', deletedAt: '2026-08-01' }), false);
  assert.equal(isEffectiveOrderHistoryRow({ status: 'cancelled' }, 'cancelled'), true);
});

test('order history date range is inclusive at start and exclusive at end', () => {
  const start = '2026-08-01T00:00:00.000Z';
  const end = '2026-09-01T00:00:00.000Z';
  assert.equal(isOrderInHistoryWindow({ date: start }, start, end), true);
  assert.equal(isOrderInHistoryWindow({ date: end }, start, end), false);
  assert.equal(isOrderInHistoryWindow({ date: 'invalid' }, start, end), false);
});

test('order history mapper normalizes database rows and keeps explicit zero values', () => {
  const mapped = mapOrderHistoryRow({
    id: 'order-1',
    customer_id: 'customer-1',
    items: '[{"quantity":2}]',
    total_payable: 100,
    paid_amount: 0,
    shipping_fee_amount: 5,
    debt_amount: 0,
    status: 'confirmed'
  });

  assert.equal(mapped.customerId, 'customer-1');
  assert.deepEqual(mapped.items, [{ quantity: 2 }]);
  assert.equal(mapped.paidAmount, 0);
  assert.equal(mapped.amountDue, 0);
  assert.equal(mapped.status, 'confirmed');
});
