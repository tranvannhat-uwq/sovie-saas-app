export const TENANT_BUSINESS_STORAGE_KEYS = Object.freeze([
  'billing_system_brands',
  'billing_system_cashbook_start_balances',
  'billing_system_cashbook_transactions',
  'billing_system_customers',
  'billing_system_dashboard_filter',
  'billing_system_finished_goods_stock',
  'billing_system_goods_receipts',
  'billing_system_goods_return_to_suppliers',
  'billing_system_orders',
  'billing_system_price_list_items',
  'billing_system_pricelists',
  'billing_system_production_logs',
  'billing_system_products',
  'billing_system_purchase_orders',
  'billing_system_purchase_receipts',
  'billing_system_purchase_returns',
  'billing_system_purchases',
  'billing_system_raw_materials',
  'billing_system_recipes',
  'billing_system_sales_returns',
  'billing_system_semi_finished',
  'billing_system_supplier_imports',
  'billing_system_supplier_returns',
  'billing_system_suppliers',
  'billing_system_users'
]);

const tenantBusinessKeys = new Set(TENANT_BUSINESS_STORAGE_KEYS);
let activeOrganizationId = '';

export function tenantStorageKey(key, organizationId = activeOrganizationId) {
  const normalizedOrganizationId = String(organizationId || '').trim();
  return normalizedOrganizationId && tenantBusinessKeys.has(key)
    ? `billing_tenant:${normalizedOrganizationId}:${key}`
    : key;
}

export function activateTenantStorage(organizationId, storage = globalThis.localStorage) {
  activeOrganizationId = String(organizationId || '').trim();
  if (!activeOrganizationId || !storage) {
    throw new Error('Không thể kích hoạt cache khi chưa xác định organization.');
  }

  // Unscoped legacy data may belong to another deployment or organization.
  // Cloud is authoritative, so discard it instead of guessing its owner.
  const marker = `billing_tenant_cache_initialized:${activeOrganizationId}`;
  try {
    if (storage.getItem(marker) !== '1') {
      for (const key of tenantBusinessKeys) storage.removeItem(key);
      storage.setItem(marker, '1');
    }
  } catch (error) {
    // Cache availability must never weaken tenant identity or block Cloud login.
    console.warn('Không thể dọn cache legacy của trình duyệt:', error?.message || error);
  }
  return activeOrganizationId;
}

export function clearTenantStorageContext() {
  activeOrganizationId = '';
}

export function getActiveTenantStorageContext() {
  return activeOrganizationId;
}

export const tenantStorage = Object.freeze({
  getItem(key) {
    if (tenantBusinessKeys.has(key) && !activeOrganizationId) return null;
    try {
      return globalThis.localStorage.getItem(tenantStorageKey(key));
    } catch (_) {
      return null;
    }
  },
  setItem(key, value) {
    if (tenantBusinessKeys.has(key) && !activeOrganizationId) return;
    try {
      globalThis.localStorage.setItem(tenantStorageKey(key), value);
    } catch (_) {
      // Cloud remains authoritative when browser storage is unavailable.
    }
  },
  removeItem(key) {
    try {
      if (tenantBusinessKeys.has(key) && !activeOrganizationId) {
        globalThis.localStorage.removeItem(key);
        return;
      }
      globalThis.localStorage.removeItem(tenantStorageKey(key));
    } catch (_) {
      // Removing a disposable cache must not block logout/disconnect.
    }
  }
});
