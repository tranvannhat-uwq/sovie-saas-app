export const PRICE_LIST_TYPES = Object.freeze({
  GENERAL: 'general',
  SALES: 'sales',
  DEALER_PRIVATE: 'dealer_private',
  STANDARD: 'standard',
  CUSTOMER_GROUP: 'customer_group',
  CUSTOMER_SPECIFIC: 'customer_specific'
});

export function normalizePriceListType(type, customerId = null) {
  if (type === PRICE_LIST_TYPES.GENERAL || type === PRICE_LIST_TYPES.STANDARD || type === 'standard') {
    return PRICE_LIST_TYPES.GENERAL;
  }
  if (type === PRICE_LIST_TYPES.SALES || type === 'sale') {
    return PRICE_LIST_TYPES.SALES;
  }
  if (type === PRICE_LIST_TYPES.CUSTOMER_GROUP || type === 'group') {
    return PRICE_LIST_TYPES.CUSTOMER_GROUP;
  }
  if (type === PRICE_LIST_TYPES.DEALER_PRIVATE || type === PRICE_LIST_TYPES.CUSTOMER_SPECIFIC || type === 'customer') {
    return PRICE_LIST_TYPES.DEALER_PRIVATE;
  }
  return customerId ? PRICE_LIST_TYPES.DEALER_PRIVATE : PRICE_LIST_TYPES.GENERAL;
}

export function isPrivilegedPricingRole(user) {
  return user?.role === 'admin' || user?.role === 'accounting';
}

export function isDealerPrivatePriceList(priceList) {
  return normalizePriceListType(priceList?.type, priceList?.customerId) === PRICE_LIST_TYPES.DEALER_PRIVATE;
}

export function canUserViewPriceList(user, priceList, now = new Date()) {
  if (!priceList || !isPriceListActive(priceList, now)) return false;
  if (isPrivilegedPricingRole(user)) return true;
  if (user?.role === 'sale') {
    return priceList.isAvailableForSales === true && !isDealerPrivatePriceList(priceList);
  }
  return !isDealerPrivatePriceList(priceList);
}

export function canUserUsePriceListForCustomer(user, priceList, customer, now = new Date()) {
  if (canUserViewPriceList(user, priceList, now)) return true;
  if (user?.role !== 'sale' || !customer || !isPriceListActive(priceList, now)) return false;
  const references = [customer.pricelistId, customer.defaultPriceListId]
    .filter(Boolean)
    .map(value => String(value).trim().toLowerCase());
  return [priceList.id, priceList.code, priceList.name]
    .filter(Boolean)
    .some(value => references.includes(String(value).trim().toLowerCase()));
}

export function filterPriceListsForUser(priceLists, user, now = new Date()) {
  return sortPriceLists((priceLists || []).filter(priceList => canUserViewPriceList(user, priceList, now)));
}

export function assertCanUsePriceList(user, priceList, now = new Date()) {
  if (canUserViewPriceList(user, priceList, now)) return true;
  const error = new Error('FORBIDDEN_PRICE_LIST');
  error.status = 403;
  throw error;
}

export function isPriceListActive(priceList, now = new Date()) {
  if (!priceList || priceList.isActive === false) return false;
  const current = now instanceof Date ? now : new Date(now);
  if (priceList.effectiveFrom && new Date(`${priceList.effectiveFrom}T00:00:00`) > current) return false;
  if (priceList.effectiveTo && new Date(`${priceList.effectiveTo}T23:59:59`) < current) return false;
  return true;
}

export function sortPriceLists(priceLists) {
  return [...priceLists].sort((a, b) => {
    const orderDiff = Number(a.displayOrder || 0) - Number(b.displayOrder || 0);
    if (orderDiff !== 0) return orderDiff;
    return String(a.name || '').localeCompare(String(b.name || ''), 'vi');
  });
}

export function getStandardPriceList(priceLists, now = new Date()) {
  const generalLists = sortPriceLists(
    (priceLists || []).filter(priceList =>
      normalizePriceListType(priceList.type, priceList.customerId) === PRICE_LIST_TYPES.GENERAL &&
      isPriceListActive(priceList, now)
    )
  );
  return generalLists.find(priceList => {
    const name = String(priceList.name || '').trim().toLocaleLowerCase('vi-VN');
    const code = String(priceList.code || '').trim().toUpperCase();
    return ['bảng giá chung', 'bang gia chung', 'giá chung', 'gia chung'].includes(name)
      || ['BANG_GIA_CHUNG', 'BG_CHUNG', 'GIA_CHUNG'].includes(code);
  }) || generalLists[0] || null;
}

export function shouldOverrideWithGlobalCustomerPriceList({
  priceList,
  customer,
  explicitlySelected = false
}) {
  if (!priceList) return false;
  const isGlobal = normalizePriceListType(priceList.type, priceList.customerId) === PRICE_LIST_TYPES.GENERAL
    && !priceList.customerId
    && !priceList.customerGroupId;
  if (!isGlobal) return false;
  if (explicitlySelected) return true;
  if (!customer) return false;

  const references = [customer.pricelistId, customer.defaultPriceListId]
    .filter(Boolean)
    .map(value => String(value).trim().toLowerCase());
  return [priceList.id, priceList.code, priceList.name]
    .filter(Boolean)
    .some(value => references.includes(String(value).trim().toLowerCase()));
}

// Khách hàng cũ có thể lưu mã BG03 hoặc tên bảng giá thay vì UUID.
// Luôn quy đổi theo cả ba định danh để không rơi về bảng giá chuẩn đầu tiên.
function matchesPriceListReference(priceList, reference) {
  if (!reference) return false;
  const value = String(reference).trim().toLowerCase();
  return [priceList.id, priceList.code, priceList.name]
    .filter(Boolean)
    .some(candidate => String(candidate).trim().toLowerCase() === value);
}

export function getApplicablePriceList(customer, priceLists, requestedPriceListId = '', now = new Date()) {
  const activeLists = sortPriceLists((priceLists || []).filter(priceList => isPriceListActive(priceList, now)));

  if (customer) {
    // Bảng giá được gán trực tiếp trên hồ sơ khách hàng là lựa chọn chính thức.
    // Không để một bảng giá riêng cũ theo customerId ghi đè lên lựa chọn này.
    // pricelistId is the field edited by the customer form. The duplicated
    // default field is retained only as a compatibility fallback.
    const references = [customer.pricelistId, customer.defaultPriceListId].filter(Boolean);
    // Iterate references first. Iterating activeLists first would accidentally
    // let display_order override the customer's explicit selection.
    const customerDefault = references
      .map(reference => activeLists.find(priceList => matchesPriceListReference(priceList, reference)))
      .find(Boolean);
    if (customerDefault) return { priceList: customerDefault, selectionSource: 'customer_default' };

    const specific = activeLists.find(priceList =>
      normalizePriceListType(priceList.type, priceList.customerId) === PRICE_LIST_TYPES.DEALER_PRIVATE &&
      priceList.customerId === customer.id
    );
    if (specific) return { priceList: specific, selectionSource: 'customer_specific' };

    const groupId = customer.customerGroupId || customer.customer_group_id;
    const groupList = activeLists.find(priceList =>
      normalizePriceListType(priceList.type, priceList.customerId) === PRICE_LIST_TYPES.CUSTOMER_GROUP &&
      priceList.customerGroupId === groupId
    );
    if (groupList) return { priceList: groupList, selectionSource: 'customer_group' };
  }

  if (requestedPriceListId) {
    const requested = activeLists.find(priceList => priceList.id === requestedPriceListId);
    if (requested) return { priceList: requested, selectionSource: 'manual_selection' };
  }

  const standard = getStandardPriceList(activeLists, now);
  return {
    priceList: standard,
    selectionSource: standard ? 'standard' : 'missing'
  };
}

function findOverride(priceListItems, priceListId, productId) {
  return (priceListItems || []).find(item =>
    item.priceListId === priceListId &&
    item.productId === productId &&
    item.price !== null &&
    item.price !== undefined &&
    Number.isFinite(Number(item.price))
  ) || null;
}

function directSource(priceList) {
  const type = normalizePriceListType(priceList.type, priceList.customerId);
  if (type === PRICE_LIST_TYPES.DEALER_PRIVATE) return 'specific';
  if (type === PRICE_LIST_TYPES.CUSTOMER_GROUP) return 'group';
  return 'standard';
}

// Giá 0 là một mức giá được nhập chủ động (hàng tặng/cấp miễn phí).
// Chỉ trạng thái missing, giá âm hoặc giá không phải số mới là không hợp lệ.
export function isUsableResolvedPrice(resolvedPrice) {
  if (!resolvedPrice || resolvedPrice.status === 'missing') return false;
  const price = Number(resolvedPrice.price);
  return Number.isFinite(price) && price >= 0;
}

export function resolvePriceForList({
  productId,
  priceListId,
  priceLists,
  priceListItems,
  now = new Date()
}) {
  const activeLists = (priceLists || []).filter(priceList => isPriceListActive(priceList, now));
  const byId = new Map(activeLists.map(priceList => [priceList.id, priceList]));
  const requested = byId.get(priceListId);
  if (!requested) {
    return { status: 'missing', price: null, priceListId: priceListId || null, source: 'missing' };
  }

  const visited = new Set();
  let current = requested;
  while (current && !visited.has(current.id)) {
    visited.add(current.id);
    const override = findOverride(priceListItems, current.id, productId);
    if (override) {
      const inherited = current.id !== requested.id;
      return {
        status: inherited ? 'inherited' : 'direct',
        price: Number(override.price),
        priceListId: requested.id,
        sourcePriceListId: current.id,
        source: inherited ? 'inherited' : directSource(current)
      };
    }
    current = current.parentPriceListId ? byId.get(current.parentPriceListId) : null;
  }

  const requestedIsGlobalGeneral = normalizePriceListType(requested.type, requested.customerId) === PRICE_LIST_TYPES.GENERAL
    && !requested.customerId
    && !requested.customerGroupId;
  const standard = requestedIsGlobalGeneral ? null : getStandardPriceList(activeLists, now);
  if (standard && !visited.has(standard.id)) {
    const standardItem = findOverride(priceListItems, standard.id, productId);
    if (standardItem) {
      return {
        status: 'inherited',
        price: Number(standardItem.price),
        priceListId: requested.id,
        sourcePriceListId: standard.id,
        source: 'inherited'
      };
    }
  }

  return {
    status: 'missing',
    price: null,
    priceListId: requested.id,
    sourcePriceListId: null,
    source: 'missing'
  };
}

export function resolveCustomerProductPrice({
  productId,
  customer,
  requestedPriceListId,
  priceLists,
  priceListItems,
  now = new Date()
}) {
  const applicable = getApplicablePriceList(customer, priceLists, requestedPriceListId, now);
  if (!applicable.priceList) {
    return {
      status: 'missing',
      price: null,
      priceListId: null,
      priceListName: '',
      source: 'missing',
      selectionSource: applicable.selectionSource
    };
  }

  const resolved = resolvePriceForList({
    productId,
    priceListId: applicable.priceList.id,
    priceLists,
    priceListItems,
    now
  });
  return {
    ...resolved,
    priceListId: applicable.priceList.id,
    priceListName: applicable.priceList.name,
    selectionSource: applicable.selectionSource
  };
}

export function parseVndInteger(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw.startsWith('-')) return -parseVndInteger(raw.slice(1));
  const digits = raw.replace(/\D/g, '');
  return digits ? Number.parseInt(digits, 10) : null;
}
