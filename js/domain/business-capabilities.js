const BUSINESS_TYPES = new Set([
  'general_trade', 'retail', 'wholesale', 'distribution', 'services', 'manufacturing'
]);

function freezeRows(value) {
  return Object.freeze((Array.isArray(value) ? value : []).map(row => Object.freeze({ ...row })));
}

export function resolveBusinessCapabilities(payload, expectedOrganizationId) {
  const organizationId = String(payload?.organizationId || payload?.organization_id || '').trim();
  if (!organizationId || organizationId !== String(expectedOrganizationId || '').trim()) {
    throw new Error('Cấu hình năng lực không thuộc doanh nghiệp hiện tại.');
  }

  const settings = payload?.settings && typeof payload.settings === 'object'
    ? payload.settings
    : {};
  const businessType = String(settings.business_type || settings.businessType || 'general_trade');
  if (!BUSINESS_TYPES.has(businessType)) {
    throw new Error('Loại hình doanh nghiệp không hợp lệ.');
  }

  const modules = Object.fromEntries(Object.entries(payload?.modules || {}).map(([key, value]) => [
    key,
    Object.freeze({
      enabled: value?.enabled === true,
      config: Object.freeze({ ...(value?.config || {}) })
    })
  ]));

  return Object.freeze({
    organizationId,
    settings: Object.freeze({ ...settings, business_type: businessType }),
    modules: Object.freeze(modules),
    branches: freezeRows(payload?.branches),
    warehouses: freezeRows(payload?.warehouses),
    domains: freezeRows(payload?.domains),
    planLimits: Object.freeze({ ...(payload?.planLimits || payload?.plan_limits || {}) })
  });
}

export function isBusinessModuleEnabled(capabilities, moduleKey) {
  return capabilities?.modules?.[moduleKey]?.enabled === true;
}
