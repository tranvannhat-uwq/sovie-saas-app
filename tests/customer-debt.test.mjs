import assert from 'node:assert/strict';
import {
  buildCustomerDebtDisplayHistory,
  chargeCustomerDebt,
  collectCustomerDebt,
  getCustomerDebtPostingDate,
  getNeutralizedOrderDebtEntryIds,
  getOrderDebtSnapshot,
  getOrderOutstandingAmount,
  mergeCustomerDebtHistory,
  projectEffectiveCustomerDebtHistory,
  reduceCustomerDebtForReturn,
  restoreCustomerDebtForCancelledReturn
} from '../js/domain/customer-debt.js';

const backdatedPostingSequence = [
  { id: 'import', type: 'adjust', debtChange: 1840000, date: '2026-08-05T15:38:00+07:00', postedAt: '2026-08-05T15:38:01+07:00', debtBefore: -51600, debtAfter: 1788400 },
  { id: 'payment', type: 'payment', debtChange: -1788000, date: '2026-08-05T15:41:00+07:00', postedAt: '2026-08-05T15:41:01+07:00', debtBefore: 1788400, debtAfter: 400 },
  { id: 'backdated-order', type: 'charge', debtChange: 1840000, date: '2026-08-05T07:12:00+07:00', postedAt: '2026-08-05T15:45:00+07:00', debtBefore: 400, debtAfter: 1840400 }
];
assert.equal(getCustomerDebtPostingDate(backdatedPostingSequence[2]), '2026-08-05T15:45:00+07:00');
const backdatedDisplay = buildCustomerDebtDisplayHistory(backdatedPostingSequence, 1840400).reverse();
assert.deepEqual(backdatedDisplay.map(item => item.id), ['backdated-order', 'payment', 'import']);
assert.equal(backdatedDisplay[0].debtAfter, 1840400, 'Newest posted snapshot equals authoritative current debt');
assert.equal(backdatedDisplay[0].debtBefore, backdatedDisplay[1].debtAfter, 'Posting order keeps adjacent balances continuous');
assert.equal(backdatedDisplay[1].debtBefore, backdatedDisplay[2].debtAfter, 'Earlier adjacent balances remain continuous');

const amendedDisplay = buildCustomerDebtDisplayHistory([
  { id: 'payment-original', type: 'payment', transactionType: 'payment', amount: 5000000, debtChange: -5000000, postedAt: '2026-08-01T08:00:00Z' },
  { id: 'order-between', type: 'charge', transactionType: 'order', amount: 3000000, debtChange: 3000000, postedAt: '2026-08-01T09:00:00Z' },
  { id: 'payment-amend', transactionType: 'payment_amend', amount: 1000000, debtChange: -1000000, amendsLedgerId: 'payment-original', postedAt: '2026-08-01T10:00:00Z' }
], 6000000).reverse();
assert.deepEqual(amendedDisplay.map(item => item.id), ['payment-original', 'order-between']);
assert.equal(amendedDisplay[0].debtAfter, 6000000);
assert.equal(amendedDisplay[0].debtBefore, amendedDisplay[1].debtAfter, 'Folded amendments keep the visible balance chain continuous');

assert.equal(getOrderOutstandingAmount({ totalPayable: 100000, shippingFeeAmount: 15000, paidAmount: 20000 }), 95000);
assert.equal(getOrderOutstandingAmount({ amountDue: 240000, totalPayable: 100000 }), 240000);

let debt = 100000;
debt = chargeCustomerDebt(debt, 250000);
assert.equal(debt, 350000, 'A finalized order increases receivable debt');
debt = collectCustomerDebt(debt, 125000);
assert.equal(debt, 225000, 'A receipt reduces receivable debt');
debt = reduceCustomerDebtForReturn(debt, 250000);
assert.equal(debt, -25000, 'A return can create a customer credit');
debt = restoreCustomerDebtForCancelledReturn(debt, 250000);
assert.equal(debt, 225000, 'Cancelling a return reverses exactly one return');

const mergedHistory = mergeCustomerDebtHistory([
  { id: 'HD-001', type: 'charge', amount: 1840000, debtAfter: 1840400 },
  { id: 'legacy-payment', type: 'payment', amount: 400 }
], [
  {
    id: 'dtx-ord-HD-001',
    orderId: 'HD-001',
    transactionType: 'order',
    type: 'charge',
    amount: 1840000,
    debtBefore: 400,
    debtAfter: 1840400
  }
]);
assert.deepEqual(mergedHistory.map(item => item.id), ['legacy-payment', 'dtx-ord-HD-001']);

assert.deepEqual(getOrderDebtSnapshot({ id: 'HD-001' }, { debtHistory: mergedHistory }), {
  debtBefore: 400,
  debtAfter: 1840400
}, 'Invoice debt uses the ledger orderId instead of mistaking the ledger id for an order id');

assert.deepEqual(getOrderDebtSnapshot({ id: 'HD-002' }, { debtHistory: [] }, {
  orderId: 'HD-002', debtBefore: -13898778, debtAfter: -407803
}), { debtBefore: -13898778, debtAfter: -407803 }, 'A targeted cloud snapshot is accepted without mutating customer state');

const compactedIds = getNeutralizedOrderDebtEntryIds([
  { id: 'charge-old', orderId: 'HD-OLD', transactionType: 'order', debtChange: 13490975 },
  { id: 'reverse-old', orderId: 'HD-OLD', transactionType: 'order_cancel', debtChange: -13490975, reversalOfId: 'charge-old' },
  { id: 'charge-new', orderId: 'HD-NEW', transactionType: 'order', debtChange: 13490975 },
  { id: 'unrelated-adjust', transactionType: 'adjust', debtChange: -1000 }
]);
assert.deepEqual([...compactedIds].sort(), ['charge-old', 'reverse-old']);

const effectiveHistory = projectEffectiveCustomerDebtHistory([
  { id: 'payment-edited', type: 'payment', transactionType: 'payment', cashbookTransactionId: 'PT-EDIT', amount: 5000000, debtChange: -5000000, debtBefore: 9000000, debtAfter: 4000000, date: '2026-08-01T00:00:00Z' },
  { id: 'payment-edit-delta', transactionType: 'payment_amend', cashbookTransactionId: 'PT-EDIT', amount: 1000000, debtChange: -1000000, debtAfter: 3000000, reversalOfId: 'payment-edited', date: '2026-08-02T00:00:00Z' },
  { id: 'payment-cancelled', type: 'payment', transactionType: 'payment', cashbookTransactionId: 'PT-CANCEL', amount: 2000000, debtChange: -2000000 },
  { id: 'payment-cancel-row', transactionType: 'payment_cancel', cashbookTransactionId: 'PT-CANCEL', debtChange: 2000000, reversalOfId: 'payment-cancelled' },
  { id: 'order-old', type: 'charge', transactionType: 'order', orderId: 'HD-OLD', amount: 4000000, debtChange: 4000000 },
  { id: 'order-old-cancel', transactionType: 'order_cancel', orderId: 'HD-OLD', debtChange: -4000000, reversalOfId: 'order-old' },
  { id: 'order-new', type: 'charge', transactionType: 'order', orderId: 'HD-NEW', amount: 4500000, debtChange: 4500000 },
  { id: 'return-edited', type: 'return', transactionType: 'return', salesReturnId: 'RET-1', amount: 1000000, debtChange: -1000000 },
  { id: 'return-edit-delta', transactionType: 'return_amend', salesReturnId: 'RET-1', amount: 250000, debtChange: 250000, reversalOfId: 'return-edited' },
  { id: 'order-sale', type: 'charge', transactionType: 'order', orderId: 'HD-SALE', amount: 3000000, debtChange: 3000000 },
  { id: 'sale-receipt-edit', transactionType: 'sale_payment_amend', orderId: 'HD-SALE', debtChange: -500000 },
  { id: 'payment-moved-old', type: 'payment', transactionType: 'payment', cashbookTransactionId: 'PT-MOVED-OLD', amount: 5000000, debtChange: -5000000 },
  { id: 'payment-move-old-delta', transactionType: 'payment_relink', cashbookTransactionId: 'PT-MOVED-OLD', debtChange: 5000000, reversalOfId: 'payment-moved-old' },
  { id: 'relinked-new-customer', transactionType: 'payment_relink', cashbookTransactionId: 'PT-MOVED', debtChange: -6000000, reversalOfId: 'payment-owned-by-old-customer' }
]);
assert.deepEqual(effectiveHistory.map(entry => entry.id), [
  'payment-edited', 'order-new', 'return-edited', 'order-sale', 'relinked-new-customer'
]);
assert.deepEqual(
  effectiveHistory.map(entry => [entry.id, entry.type, entry.debtChange, entry.amount]),
  [
    ['payment-edited', 'payment', -6000000, 6000000],
    ['order-new', 'charge', 4500000, 4500000],
    ['return-edited', 'return', -750000, 750000],
    ['order-sale', 'charge', 2500000, 2500000],
    ['relinked-new-customer', 'payment', -6000000, 6000000]
  ]
);

console.log('customer-debt.test.mjs: all assertions passed');
