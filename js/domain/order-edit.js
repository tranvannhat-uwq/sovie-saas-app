function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function sameValue(left, right) {
  return left !== null && left !== undefined && left !== ''
    && right !== null && right !== undefined && right !== ''
    && String(left) === String(right);
}

export function resolveOrderCustomerForEditing(order = {}, customers = []) {
  const customerId = order.customerId ?? order.customer_id ?? null;
  const customer = customerId === null || customerId === undefined || customerId === ''
    ? null
    : (customers || []).find(item => sameValue(item.id, customerId)) || null;
  const snapshotName = String(order.customerName || order.customer_name || '').trim();

  return {
    customer,
    customerId: customer?.id || null,
    customerName: customer?.name || snapshotName || 'Khách lẻ',
    isGuest: !customer
  };
}

export function normalizeOrderItemForEditing(item = {}, products = [], index = 0) {
  const embeddedProduct = item.product && typeof item.product === 'object' ? item.product : {};
  const variantId = item.variantId || item.productId || embeddedProduct.id || null;
  const variantCode = item.variantCode || item.productCode || item.code
    || embeddedProduct.variantCode || embeddedProduct.code || '';
  const brand = item.brand || item.productBrand || embeddedProduct.brand || '';

  const catalogProduct = (products || []).find(product =>
    sameValue(product.id, variantId)
    || (variantCode && String(product.code || product.variantCode || '') === String(variantCode)
      && (!brand || !product.brand || String(product.brand) === String(brand)))
  );

  const sourceProduct = catalogProduct || embeddedProduct;
  const product = {
    ...sourceProduct,
    id: sourceProduct.id || variantId,
    code: sourceProduct.code || sourceProduct.variantCode || variantCode || `LEGACY-${index + 1}`,
    variantCode: sourceProduct.variantCode || sourceProduct.code || variantCode || `LEGACY-${index + 1}`,
    productGroupId: item.productGroupId || sourceProduct.productGroupId || null,
    baseCode: item.baseCode || sourceProduct.baseCode || '',
    name: sourceProduct.name || item.productName || item.name || `Sản phẩm ${index + 1}`,
    brand: sourceProduct.brand || brand,
    packagingName: item.packagingName || item.package || sourceProduct.packagingName || sourceProduct.packageType || '',
    packageType: item.packagingName || item.package || sourceProduct.packageType || sourceProduct.packagingName || '',
    packageWeight: item.weightOrVolume ?? item.packageWeight ?? sourceProduct.packageWeight ?? '',
    packageWeightUnit: item.unitName || item.packageWeightUnit || sourceProduct.packageWeightUnit || '',
    displaySpecification: item.specificationSnapshot || sourceProduct.displaySpecification || ''
  };

  return {
    product,
    productGroupId: item.productGroupId || product.productGroupId || null,
    variantId: variantId || product.id || null,
    variantCode: variantCode || product.code,
    baseCode: item.baseCode || product.baseCode || '',
    brand: brand || product.brand || '',
    package: item.packagingName || item.package || product.packageType || '',
    packagingName: item.packagingName || item.package || product.packagingName || product.packageType || '',
    packageWeight: item.weightOrVolume ?? item.packageWeight ?? product.packageWeight ?? '',
    unitName: item.unitName || item.packageWeightUnit || product.packageWeightUnit || '',
    colorCode: item.colorCode || '',
    colorPercent: finiteNumber(item.colorPercent, 0),
    quantity: finiteNumber(item.quantity, 1),
    discountPercent: finiteNumber(item.discountPercent, 0),
    price: finiteNumber(item.price ?? item.unitPrice, 0),
    unitPrice: finiteNumber(item.unitPrice ?? item.price, 0),
    listPrice: finiteNumber(item.listPrice ?? item.price ?? item.unitPrice, 0),
    priceListId: item.priceListId || '',
    priceListName: item.priceListNameSnapshot || item.priceListName || '',
    priceSource: item.priceSource || 'legacy_snapshot',
    notes: item.notes || ''
  };
}

export function normalizeOrderItemsForEditing(items, products = []) {
  if (!Array.isArray(items)) return [];
  return items.map((item, index) => normalizeOrderItemForEditing(item, products, index));
}

export function reorderOrderItems(items, fromIndex, toIndex) {
  if (!Array.isArray(items)) return [];
  const from = Number(fromIndex);
  const to = Number(toIndex);
  if (!Number.isInteger(from) || !Number.isInteger(to)
    || from < 0 || from >= items.length || to < 0 || to >= items.length
    || from === to) {
    return items;
  }

  const reordered = [...items];
  const [movedItem] = reordered.splice(from, 1);
  reordered.splice(to, 0, movedItem);
  return reordered;
}
