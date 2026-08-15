import assert from 'node:assert/strict';
import {
  PRICE_LIST_TYPES,
  getApplicablePriceList,
  resolvePriceForList,
  resolveCustomerProductPrice,
  filterPriceListsForUser,
  canUserViewPriceList,
  canUserUsePriceListForCustomer,
  isPrivilegedPricingRole,
  getStandardPriceList,
  isUsableResolvedPrice,
  parseVndInteger,
  shouldOverrideWithGlobalCustomerPriceList
} from '../js/domain/pricing.js';
import { isPrintOnlyPriceList, requiresOrderSaveApproval, supportsInvoiceLineDiscount } from '../js/domain/invoice-discount.js';

const priceLists = [
  { id: 'standard', name: 'Giá chung', type: PRICE_LIST_TYPES.GENERAL, isActive: true, isAvailableForSales: false, displayOrder: 0 },
  { id: 'sales-a', name: 'Bảng sale A', type: PRICE_LIST_TYPES.SALES, parentPriceListId: 'standard', isActive: true, isAvailableForSales: true, displayOrder: 5 },
  { id: 'bg03', name: 'BG03', type: PRICE_LIST_TYPES.CUSTOMER_GROUP, parentPriceListId: 'standard', isActive: true, isAvailableForSales: false, displayOrder: 10 },
  { id: 'tung-private', name: 'Giá Tùng Quảng Ninh', type: PRICE_LIST_TYPES.DEALER_PRIVATE, customerId: 'tung', parentPriceListId: 'bg03', isActive: true, isAvailableForSales: false, displayOrder: 20 }
];

const standardOnly = [
  { priceListId: 'standard', productId: 'ba46-lon', price: 2116000 }
];

assert.equal(supportsInvoiceLineDiscount(priceLists[0]), true);
assert.equal(supportsInvoiceLineDiscount({ name: 'Bảng giá thị trường 20/07/2026', type: PRICE_LIST_TYPES.SALES }), true);
assert.equal(supportsInvoiceLineDiscount({ name: 'TT 20/07/2026', type: PRICE_LIST_TYPES.SALES }), true);
assert.equal(supportsInvoiceLineDiscount(priceLists[1]), false);
assert.equal(supportsInvoiceLineDiscount(priceLists[2]), false);
assert.equal(isPrintOnlyPriceList({ name: 'Bảng giá thị trường 20/07/2026' }), true);
assert.equal(isPrintOnlyPriceList({ code: 'THI_TRUONG_2026', name: 'Bảng báo giá' }), true);
assert.equal(isPrintOnlyPriceList({ name: 'TT 20/07/2026' }), true);
assert.equal(isPrintOnlyPriceList({ name: 'TT 20/07/2026', isPrintOnly: false }), false);
assert.equal(isPrintOnlyPriceList({ name: 'Bảng giá chung', isPrintOnly: true }), true);
assert.equal(isPrintOnlyPriceList({ name: 'Bảng giá chung' }), false);
assert.equal(requiresOrderSaveApproval({ name: 'TT 20-07-2026' }), true);
assert.equal(requiresOrderSaveApproval({ name: 'Bảng giá chung' }), false);

assert.deepEqual(
  resolvePriceForList({
    productId: 'ba46-lon',
    priceListId: 'standard',
    priceLists,
    priceListItems: standardOnly
  }),
  {
    status: 'direct',
    price: 2116000,
    priceListId: 'standard',
    sourcePriceListId: 'standard',
    source: 'standard'
  }
);

const inherited = resolvePriceForList({
  productId: 'ba46-lon',
  priceListId: 'bg03',
  priceLists,
  priceListItems: standardOnly
});
assert.equal(inherited.status, 'inherited');
assert.equal(inherited.price, 2116000);
assert.equal(inherited.sourcePriceListId, 'standard');

const overriddenItems = [
  ...standardOnly,
  { priceListId: 'bg03', productId: 'ba46-lon', price: 1950000 }
];
const overridden = resolvePriceForList({
  productId: 'ba46-lon',
  priceListId: 'bg03',
  priceLists,
  priceListItems: overriddenItems
});
assert.equal(overridden.status, 'direct');
assert.equal(overridden.price, 1950000);
assert.equal(overridden.source, 'group');

const freeGift = resolvePriceForList({
  productId: 'gift-sku',
  priceListId: 'standard',
  priceLists,
  priceListItems: [{ priceListId: 'standard', productId: 'gift-sku', price: 0 }]
});
assert.equal(freeGift.status, 'direct');
assert.equal(freeGift.price, 0);
assert.equal(isUsableResolvedPrice(freeGift), true);
assert.equal(isUsableResolvedPrice({ status: 'missing', price: null }), false);
assert.equal(isUsableResolvedPrice({ status: 'direct', price: -1 }), false);

const variantPrices = [
  { priceListId: 'bg03', productId: 'ct-d1-lon', price: 390000 },
  { priceListId: 'bg03', productId: 'ct-d1-thung', price: 1180000 }
];
assert.equal(resolvePriceForList({
  productId: 'ct-d1-lon',
  priceListId: 'bg03',
  priceLists,
  priceListItems: variantPrices
}).price, 390000);
assert.equal(resolvePriceForList({
  productId: 'ct-d1-thung',
  priceListId: 'bg03',
  priceLists,
  priceListItems: variantPrices
}).price, 1180000);

const afterDelete = resolvePriceForList({
  productId: 'ba46-lon',
  priceListId: 'bg03',
  priceLists,
  priceListItems: standardOnly
});
assert.equal(afterDelete.status, 'inherited');
assert.equal(afterDelete.price, 2116000);

const customer = { id: 'tung', pricelistId: 'bg03' };
const applicable = getApplicablePriceList(customer, priceLists);
assert.equal(applicable.priceList.id, 'bg03');
assert.equal(applicable.selectionSource, 'customer_default');

// pricelist_id is the customer-form selection. The duplicated default field
// can be stale on upgraded rows, so it is only a compatibility fallback.
const migratedCustomerWithConflictingPriceLists = {
  id: 'migrated-customer',
  defaultPriceListId: 'standard',
  pricelistId: 'bg03'
};
const canonicalApplicable = getApplicablePriceList(
  migratedCustomerWithConflictingPriceLists,
  priceLists
);
assert.equal(canonicalApplicable.priceList.id, 'bg03');
assert.equal(canonicalApplicable.selectionSource, 'customer_default');

const privatePrice = resolveCustomerProductPrice({
  productId: 'ba46-lon',
  customer,
  priceLists,
  priceListItems: [
    ...overriddenItems,
    { priceListId: 'tung-private', productId: 'ba46-lon', price: 1900000 }
  ]
});
assert.equal(privatePrice.price, 1950000);
assert.equal(privatePrice.source, 'group');
assert.equal(privatePrice.priceListId, 'bg03');

const saleUser = { username: 'sale1', role: 'sale' };
const saleVisible = filterPriceListsForUser(priceLists, saleUser).map(priceList => priceList.id);
assert.deepEqual(saleVisible, ['sales-a']);
assert.equal(isPrivilegedPricingRole(saleUser), false);
assert.equal(isPrivilegedPricingRole({ username: 'admin', role: 'admin' }), true);
assert.equal(isPrivilegedPricingRole({ username: 'accounting', role: 'accounting' }), true);
assert.equal(canUserViewPriceList(saleUser, priceLists.find(priceList => priceList.id === 'tung-private')), false);
assert.equal(canUserUsePriceListForCustomer(saleUser, priceLists.find(priceList => priceList.id === 'bg03'), customer), true);
assert.equal(canUserUsePriceListForCustomer(saleUser, priceLists.find(priceList => priceList.id === 'bg03'), { id: 'other', pricelistId: 'standard' }), false);
assert.equal(canUserViewPriceList({ username: 'admin', role: 'admin' }, priceLists.find(priceList => priceList.id === 'tung-private')), true);

const missing = resolvePriceForList({
  productId: 'new-sku',
  priceListId: 'bg03',
  priceLists,
  priceListItems: standardOnly
});
assert.equal(missing.status, 'missing');
assert.equal(missing.price, null);

const siblingGeneralLists = [
  { id: 'level-1', name: 'Bảng giá 01', type: PRICE_LIST_TYPES.GENERAL, isActive: true, displayOrder: 0 },
  { id: 'canonical', name: 'Bảng giá chung', type: PRICE_LIST_TYPES.GENERAL, isActive: true, displayOrder: 99 },
  { id: 'private', name: 'Giá riêng', type: PRICE_LIST_TYPES.DEALER_PRIVATE, customerId: 'dealer', isActive: true }
];
const canonicalOnlyPrice = [{ priceListId: 'canonical', productId: 'sku-x', price: 123000 }];
assert.equal(getStandardPriceList(siblingGeneralLists).id, 'canonical');
assert.equal(resolvePriceForList({
  productId: 'sku-x',
  priceListId: 'level-1',
  priceLists: siblingGeneralLists,
  priceListItems: canonicalOnlyPrice
}).status, 'missing');
assert.equal(resolvePriceForList({
  productId: 'sku-x',
  priceListId: 'private',
  priceLists: siblingGeneralLists,
  priceListItems: canonicalOnlyPrice
}).price, 123000);

assert.equal(parseVndInteger('1.950.000'), 1950000);
assert.equal(parseVndInteger('2,116,000 ₫'), 2116000);
assert.equal(parseVndInteger('-1.000'), -1000);
assert.equal(parseVndInteger(''), null);

assert.equal(shouldOverrideWithGlobalCustomerPriceList({
  priceList: { id: 'bg03', name: 'Bảng giá 03', type: PRICE_LIST_TYPES.GENERAL },
  customer: { pricelistId: 'bg03', defaultPriceListId: 'bg01' }
}), true);
assert.equal(shouldOverrideWithGlobalCustomerPriceList({
  priceList: { id: 'group03', name: 'Bảng giá nhóm', type: PRICE_LIST_TYPES.CUSTOMER_GROUP, customerGroupId: 'g1' },
  customer: { pricelistId: 'group03' }
}), false);
assert.equal(shouldOverrideWithGlobalCustomerPriceList({
  priceList: { id: 'private03', name: 'Giá riêng', type: PRICE_LIST_TYPES.DEALER_PRIVATE, customerId: 'tung' },
  customer: { pricelistId: 'private03' }
}), false);

console.log('pricing.test.mjs: all assertions passed');
