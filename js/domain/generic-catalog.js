function freezeRows(value) {
  return Object.freeze((Array.isArray(value) ? value : []).map(row => Object.freeze({ ...row })));
}

export function resolveCatalogContext(payload, expectedOrganizationId) {
  const organizationId = String(payload?.organizationId || payload?.organization_id || '').trim();
  if (!organizationId || organizationId !== String(expectedOrganizationId || '').trim()) {
    throw new Error('Danh mục không thuộc doanh nghiệp hiện tại.');
  }
  const extensions = Object.fromEntries(Object.entries(payload?.extensions || {}).map(([key, value]) => [
    key,
    Object.freeze({ enabled: value?.enabled === true, config: Object.freeze({ ...(value?.config || {}) }) })
  ]));
  return Object.freeze({
    organizationId,
    extensions: Object.freeze(extensions),
    units: freezeRows(payload?.units),
    categories: freezeRows(payload?.categories),
    attributeDefinitions: freezeRows(payload?.attributeDefinitions || payload?.attribute_definitions)
  });
}

export function isCatalogExtensionEnabled(catalog, extensionKey) {
  return catalog?.extensions?.[extensionKey]?.enabled === true;
}

export function catalogAdjustmentPercent(catalog, extensionKey, input = {}) {
  const extension = catalog?.extensions?.[extensionKey];
  if (!extension?.enabled) return 0;
  const config = extension.config || {};
  const inputValue = String(input?.[config.input_field] || '').trim().toUpperCase();
  for (const rule of Array.isArray(config.suffix_adjustments) ? config.suffix_adjustments : []) {
    const suffix = String(rule?.suffix || '').toUpperCase();
    if (suffix && inputValue.endsWith(suffix)) {
      const percent = Number(rule?.percent);
      return Number.isFinite(percent) && percent >= 0 ? percent : 0;
    }
  }
  return 0;
}
