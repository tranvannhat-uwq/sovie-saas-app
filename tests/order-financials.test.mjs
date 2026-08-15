import assert from 'node:assert/strict';
import {
  getOrderFinancialBreakdown,
  isOrderIncludedInFinancialSummary
} from '../js/domain/order-financials.js';

function assertInvariant(result) {
  assert.equal(
    result.totalBeforeDiscount - result.totalDiscountAmount,
    result.totalAfterDiscount
  );
  assert.equal(result.totalAfterDiscount + result.otherFeeAmount, result.totalPayable);
  assert.equal(result.totalPayable + result.shippingFeeAmount, result.totalPayment);
}

const noDiscount = getOrderFinancialBreakdown({
  id: 'A',
  status: 'settled',
  items: [{ quantity: 2, price: 1249000, discountPercent: 0 }],
  paidAmount: 1
});
assert.deepEqual(
  [noDiscount.totalBeforeDiscount, noDiscount.totalDiscountAmount, noDiscount.totalAfterDiscount],
  [2498000, 0, 2498000]
);

const lineAndAmountDiscount = getOrderFinancialBreakdown({
  id: 'B',
  status: 'settled',
  items: [{ quantity: 2, price: 100000, discountPercent: 10 }],
  discountType: 'amount',
  discountValue: 20000
});
assert.deepEqual(
  [lineAndAmountDiscount.totalBeforeDiscount, lineAndAmountDiscount.totalDiscountAmount, lineAndAmountDiscount.totalAfterDiscount],
  [200000, 40000, 160000]
);

const percentDiscount = getOrderFinancialBreakdown({
  id: 'C',
  status: 'settled',
  items: [{ quantity: 2, unitPrice: 100000, finalUnitPrice: 90000 }],
  discountType: 'percent',
  discountValue: 10
});
assert.deepEqual(
  [percentDiscount.totalBeforeDiscount, percentDiscount.totalDiscountAmount, percentDiscount.totalAfterDiscount],
  [200000, 38000, 162000]
);

const authoritativeCombinedDiscount = getOrderFinancialBreakdown({
  id: 'P1',
  status: 'settled',
  pricingVersion: 'p1-v1',
  items: [{ quantity: 5, price: 2539000 }, { quantity: 2, price: 3772000 }],
  totalMarket: 20239000,
  totalDiscount: 12548180,
  subtotal: 20239000,
  discountType: 'amount',
  discountValue: 12548180,
  discountAmount: 12548180,
  totalPayable: 7690820
});
assert.deepEqual(
  [
    authoritativeCombinedDiscount.totalBeforeDiscount,
    authoritativeCombinedDiscount.totalDiscountAmount,
    authoritativeCombinedDiscount.totalAfterDiscount
  ],
  [20239000, 12548180, 7690820]
);

const oldOrder = getOrderFinancialBreakdown({
  id: 'D',
  status: 'settled',
  items: [{ quantity: 3, price: 50000, discountPercent: 20 }],
  totalMarket: 0,
  totalDiscount: 0,
  totalPayable: 0
});
assert.deepEqual(
  [oldOrder.totalBeforeDiscount, oldOrder.totalDiscountAmount, oldOrder.totalAfterDiscount],
  [150000, 30000, 120000]
);

const orderWithOtherCharge = getOrderFinancialBreakdown({
  id: 'OTHER-CHARGE',
  status: 'settled',
  items: [{ quantity: 1, price: 600000 }],
  discountAmount: 18000,
  shipping_fee_amount: 56000,
  totalPayable: 582000
});
assert.deepEqual(
  [
    orderWithOtherCharge.totalBeforeDiscount,
    orderWithOtherCharge.totalDiscountAmount,
    orderWithOtherCharge.totalAfterDiscount,
    orderWithOtherCharge.shippingFeeAmount,
    orderWithOtherCharge.totalPayment
  ],
  [600000, 18000, 582000, 56000, 638000]
);

const partialReturn = getOrderFinancialBreakdown({
  id: 'E',
  status: 'partially_returned',
  items: [{ quantity: 2, price: 100000, discountPercent: 10 }],
  discountAmount: 20000
}, [{
  saleId: 'E',
  status: 'completed',
  totalRefund: 80000
}]);
assert.deepEqual(
  [partialReturn.totalBeforeDiscount, partialReturn.totalDiscountAmount, partialReturn.totalAfterDiscount],
  [100000, 20000, 80000]
);

const fullReturn = getOrderFinancialBreakdown({
  id: 'F',
  status: 'returned',
  items: [{ quantity: 1, price: 100000 }]
}, [{
  saleId: 'F',
  status: 'completed',
  totalRefund: 100000
}]);
assert.deepEqual(
  [fullReturn.totalBeforeDiscount, fullReturn.totalDiscountAmount, fullReturn.totalAfterDiscount],
  [0, 0, 0]
);

[noDiscount, lineAndAmountDiscount, percentDiscount, authoritativeCombinedDiscount, oldOrder, orderWithOtherCharge, partialReturn, fullReturn].forEach(assertInvariant);
assert.equal(isOrderIncludedInFinancialSummary({ status: 'settled' }), true);
assert.equal(isOrderIncludedInFinancialSummary({ status: 'cancelled' }), false);
assert.equal(isOrderIncludedInFinancialSummary({ status: 'draft' }), false);

console.log('order-financials.test.mjs: all assertions passed');
