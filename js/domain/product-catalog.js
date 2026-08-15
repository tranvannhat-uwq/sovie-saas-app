const LEGACY_PACKAGE_SUFFIX = /(?:[-_\s]+)(LON|THUNG|THÙNG|HOP|HỘP|BAO|TUI|TÚI|CHAI|GOI|GÓI|KG|LIT|LÍT|CAI|CÁI|BO|BỘ|MET|MÉT|LO|LỌ)$/iu;

export function normalizeCatalogText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function inferLegacyBaseCode(code) {
  const raw = String(code || '').trim();
  if (!raw) return '';
  const inferred = raw.replace(LEGACY_PACKAGE_SUFFIX, '').replace(/[-_\s]+$/, '').trim();
  return inferred || raw;
}

export function variantSpecification(variant) {
  if (variant?.displaySpecification) return variant.displaySpecification;
  const packageName = variant?.packagingName || variant?.packageType || '';
  const weight = variant?.weightOrVolume ?? variant?.packageWeight;
  const unit = variant?.unitName || variant?.packageWeightUnit || '';
  const formattedWeight = weight === null || weight === undefined || weight === ''
    ? ''
    : String(weight).replace('.', ',');
  return [packageName, formattedWeight, unit].filter(Boolean).join(' ').trim();
}

export function buildVariantSnapshot(variant) {
  if (!variant) return {};
  const packagingName = variant.packagingName || variant.packageType || '';
  const weightOrVolume = variant.weightOrVolume ?? variant.packageWeight ?? '';
  const unitName = variant.unitName || variant.packageWeightUnit || '';

  return {
    productGroupId: variant.productGroupId || variant.baseProductId || variant.parentProductId || null,
    variantId: variant.id || null,
    variantCode: variant.variantCode || variant.code || '',
    baseCode: variant.baseCode || inferLegacyBaseCode(variant.code),
    packagingName,
    weightOrVolume,
    unitName,
    specificationSnapshot: variantSpecification(variant)
  };
}

export function shouldAutoSelectVariant(family) {
  return Array.isArray(family?.variants) &&
    family.variants.filter(variant => variant.isActive !== false).length === 1;
}

export function getProductBaseCode(product, products = []) {
  if (!product) return '';
  if (product.baseCode) return String(product.baseCode).trim();

  const parentId = product.productGroupId || product.baseProductId || product.parentProductId;
  const parent = parentId
    ? products.find(candidate => candidate.id === parentId && candidate.id !== product.id)
    : null;
  if (parent?.baseCode) return String(parent.baseCode).trim();
  if (parent?.code) return String(parent.code).trim();

  if (typeof parentId === 'string' && parentId.startsWith('family-')) {
    const legacyFamilyCode = parentId.slice('family-'.length).trim();
    if (legacyFamilyCode && !legacyFamilyCode.includes(product.id)) return legacyFamilyCode;
  }

  return inferLegacyBaseCode(product.code);
}

function productBrand(product) {
  return String(product?.brandName || product?.brand || product?.brandId || '').trim();
}

function familyFingerprint(product, baseCode) {
  return [
    normalizeCatalogText(baseCode),
    normalizeCatalogText(product?.name),
    normalizeCatalogText(productBrand(product))
  ].join('::');
}

function compareVariants(a, b) {
  const packageDiff = String(a.packagingName || a.packageType || '').localeCompare(
    String(b.packagingName || b.packageType || ''),
    'vi'
  );
  if (packageDiff !== 0) return packageDiff;
  const weightDiff = Number(a.weightOrVolume ?? a.packageWeight ?? 0) - Number(b.weightOrVolume ?? b.packageWeight ?? 0);
  if (weightDiff !== 0) return weightDiff;
  return String(a.code || '').localeCompare(String(b.code || ''), 'vi');
}

export function buildProductFamilies(products, { includeInactive = false } = {}) {
  const source = Array.isArray(products) ? products : [];
  const variants = source.filter(product =>
    product?.id &&
    (product.packageType || product.packagingName) &&
    product.isLegacy !== true &&
    (includeInactive || product.isActive !== false)
  );
  const families = new Map();

  variants.forEach(variant => {
    const baseCode = getProductBaseCode(variant, source);
    const fingerprint = familyFingerprint(variant, baseCode);
    if (!families.has(fingerprint)) {
      families.set(fingerprint, {
        key: fingerprint,
        id: variant.productGroupId || variant.baseProductId || variant.parentProductId || `family:${fingerprint}`,
        baseCode,
        name: variant.name || '',
        brand: productBrand(variant),
        brandId: variant.brandId || null,
        categoryId: variant.categoryId || null,
        description: variant.description || '',
        group: variant.group || '',
        isActive: variant.isActive !== false,
        variants: []
      });
    }
    const family = families.get(fingerprint);
    family.variants.push(variant);
    family.isActive = family.isActive || variant.isActive !== false;
  });

  return [...families.values()]
    .map(family => ({ ...family, variants: [...family.variants].sort(compareVariants) }))
    .sort((a, b) => {
      const brandDiff = a.brand.localeCompare(b.brand, 'vi');
      if (brandDiff !== 0) return brandDiff;
      return a.baseCode.localeCompare(b.baseCode, 'vi');
    });
}

function searchableFamilyText(family) {
  return normalizeCatalogText([
    family.baseCode,
    family.name,
    family.brand,
    family.group,
    ...family.variants.flatMap(variant => [
      variant.code,
      variant.variantCode,
      variant.packageType,
      variant.packagingName,
      variant.packageWeight,
      variant.weightOrVolume,
      variant.packageWeightUnit,
      variant.unitName,
      variantSpecification(variant),
      variant.barcode
    ])
  ].join(' '));
}

export function searchProductFamilies(families, query) {
  const normalizedQuery = normalizeCatalogText(query);
  if (!normalizedQuery) return [];

  return (families || [])
    .map(family => {
      const matchingVariant = family.variants.find(variant => {
        const code = normalizeCatalogText(variant.code || variant.variantCode);
        return code === normalizedQuery;
      }) || family.variants.find(variant => {
        const variantText = normalizeCatalogText([
          variant.code,
          variant.variantCode,
          variant.packageType,
          variant.packagingName,
          variantSpecification(variant)
        ].join(' '));
        return variantText.includes(normalizedQuery);
      }) || null;

      const baseExact = normalizeCatalogText(family.baseCode) === normalizedQuery;
      const matches = baseExact || matchingVariant || searchableFamilyText(family).includes(normalizedQuery);
      if (!matches) return null;

      return {
        ...family,
        matchedVariantId: matchingVariant?.id || null,
        matchRank: matchingVariant && normalizeCatalogText(matchingVariant.code || matchingVariant.variantCode) === normalizedQuery
          ? 0
          : baseExact ? 1 : matchingVariant ? 2 : 3
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.matchRank - b.matchRank || a.baseCode.localeCompare(b.baseCode, 'vi'));
}

export function findFamilyForVariant(families, variantId) {
  return (families || []).find(family => family.variants.some(variant => variant.id === variantId)) || null;
}
