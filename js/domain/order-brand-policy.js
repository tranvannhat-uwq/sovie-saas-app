export function itemMatchesAssignedBrand(
  item,
  assignedBrandId,
  assignedBrandName,
  resolveBrandId = () => '',
  allowLegacyNameFallback = false
) {
  const product = item?.product || item?.catalogProduct || {};
  const itemType = String(
    item?.itemKind || item?.item_kind || item?.itemType || item?.item_type
    || product?.itemKind || product?.item_kind || product?.itemType || product?.item_type
    || item?.type || item?.kind || ''
  ).trim().toLocaleLowerCase();
  const isService = item?.isService === true
    || item?.is_service === true
    || ['service', 'dịch vụ', 'custom', 'custom line'].includes(itemType);
  if (isService) return true;

  const itemBrandName = String(
    item?.brand || item?.productBrand || item?.product?.brand || ''
  ).trim();
  const itemBrandId = String(
    item?.brandId || item?.brand_id || resolveBrandId(item, itemBrandName) || ''
  ).trim();

  if (assignedBrandId && itemBrandId) return itemBrandId === String(assignedBrandId).trim();
  const targetBrand = String(assignedBrandName || '').trim().toLocaleLowerCase();
  if (!targetBrand || ['tất cả', 'all'].includes(targetBrand)) return true;
  return allowLegacyNameFallback && itemBrandName.toLocaleLowerCase() === targetBrand;
}

export function partitionItemsByAssignedBrand(
  items,
  assignedBrandId,
  assignedBrandName,
  resolveBrandId,
  allowLegacyNameFallback = false
) {
  const matching = [];
  const excluded = [];
  for (const item of Array.isArray(items) ? items : []) {
    (itemMatchesAssignedBrand(item, assignedBrandId, assignedBrandName, resolveBrandId, allowLegacyNameFallback)
      ? matching
      : excluded).push(item);
  }
  return { matching, excluded };
}
