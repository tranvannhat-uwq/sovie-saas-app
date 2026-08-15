import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatPhoneNumber, isSameUser, getProvinceNameByCode, getManagerDisplayName, PROVINCES, makeSelectSearchable, getCompanyIdByBrand, normalizeCompanyId, formatDateOnly } from '../utils.js';
import { dbSaveCustomer, dbDeleteCustomer, dbDeleteCustomersBulk, dbSaveCustomersBulk, dbImportCustomerFinancialBaselines, dbFetchCustomers, dbFetchCustomerById, dbRefreshCustomerFinancialState, dbRefreshOrderById, dbFetchCashbookTransactionById, dbRecordCustomerPayment, dbAdjustCustomerDebt, dbFetchCustomerOrderHistory, dbFetchCustomersOrderHistory } from '../services/supabase.js?v=20260814-invoice-discount-label-v19';
import { renderAll } from '../main.js?v=20260814-invoice-discount-label-v19';
import { applyActivePriceListToInvoice, resetInvoiceCustomer } from './invoice.js?v=20260814-invoice-discount-label-v19';
import { addCashbookTransaction } from './so_quy.js?v=20260814-invoice-discount-label-v19';
import { getOrderFinancialBreakdown } from '../domain/order-financials.js?v=20260814-invoice-discount-label-v19';
import { buildCustomerDebtDisplayHistory, collectCustomerDebt, getCustomerDebtPostingDate } from '../domain/customer-debt.js?v=20260814-invoice-discount-label-v19';
import { businessDateKey, parseExcelDate } from '../domain/import-date.js';
import { buildCustomerImportColumnMap, normalizeExcelHeader, normalizeExcelSheetName } from '../domain/customer-import-columns.js';
import { customerDateKey, customerDaysSince, finiteCustomerNumber, normalizeCustomerSearch, queryCustomerRows } from '../domain/customer-query.js';

let pendingCustomerPaymentKey = '';

const selectedCustomerIdsForExport = new Set();
let activeExportOrders = null;
let activeExportOrderIds = null;

const DEFAULT_CUSTOMER_QUERY = Object.freeze({
  q: '', sortKey: 'lastTransactionAt', sortDirection: 'desc', nulls: 'last', pageSize: 20,
  createdPreset: '', createdFrom: '', createdTo: '', lastPreset: '', lastFrom: '', lastTo: '',
  salesMetric: 'netSales', salesPreset: '', salesMin: '', salesMax: '',
  debtPreset: '', debtMin: '', debtMax: '', brands: [], pricelists: [], managers: [], provinces: [],
  status: '', phoneState: '', addressState: '', pricelistState: '', managerState: '', brandState: '', notesState: ''
});
let customerViewQuery = { ...DEFAULT_CUSTOMER_QUERY };
let customerCurrentPageRows = [];
let customerFilteredRows = [];
let customerSearchDebounce = null;
let customerFilterOptionSignature = null;

const CUSTOMER_QUERY_CONTROL_MAP = Object.freeze({
  nulls: 'customer-sort-nulls',
  createdPreset: 'customer-created-preset', createdFrom: 'customer-created-from', createdTo: 'customer-created-to',
  lastPreset: 'customer-last-preset', lastFrom: 'customer-last-from', lastTo: 'customer-last-to',
  salesMetric: 'customer-sales-metric', salesPreset: 'customer-sales-preset', salesMin: 'customer-sales-min', salesMax: 'customer-sales-max',
  debtPreset: 'customer-debt-preset', debtMin: 'customer-debt-min', debtMax: 'customer-debt-max',
  brands: 'customer-filter-brands', pricelists: 'customer-filter-pricelists', managers: 'customer-filter-managers', provinces: 'customer-filter-provinces',
  status: 'customer-status', phoneState: 'customer-phone-state', addressState: 'customer-address-state', pricelistState: 'customer-pricelist-state',
  managerState: 'customer-manager-state', brandState: 'customer-brand-state', notesState: 'customer-notes-state'
});

const CUSTOMER_EXPORT_COLUMNS = Object.freeze([
  { key: 'index', label: 'STT', default: true }, { key: 'code', label: 'Mã khách hàng', default: true, text: true },
  { key: 'name', label: 'Tên khách hàng', default: true }, { key: 'phone', label: 'Điện thoại', default: true, text: true },
  { key: 'address', label: 'Địa chỉ', default: true }, { key: 'provinceName', label: 'Tỉnh/Thành phố', default: true },
  { key: 'brand', label: 'Nhãn sơn', default: true }, { key: 'pricelistName', label: 'Bảng giá', default: true },
  { key: 'managerName', label: 'Người quản lý', default: true }, { key: 'grossSales', label: 'Tổng doanh số', default: true, money: true },
  { key: 'totalReturns', label: 'Tổng giá trị trả hàng', default: true, money: true }, { key: 'netSales', label: 'Doanh số sau trả hàng', default: true, money: true },
  { key: 'debt', label: 'Công nợ hiện tại', default: true, money: true }, { key: 'lastTransactionAt', label: 'Ngày giao dịch gần nhất', default: true, date: true },
  { key: 'daysInactive', label: 'Số ngày chưa giao dịch', default: true }, { key: 'createdAt', label: 'Ngày tạo', default: true, date: true },
  { key: 'debtDays', label: 'Số ngày nợ', default: true }, { key: 'dueDate', label: 'Hạn thanh toán', default: false, date: true },
  { key: 'debtStatus', label: 'Trạng thái công nợ', default: false }, { key: 'notes', label: 'Ghi chú', default: true }
]);

const CUSTOMER_COLUMN_STORAGE_KEY = 'billing_customer_visible_columns';
const CUSTOMER_COLUMN_DEFINITIONS = [
  { key: 'code', label: 'Mã khách hàng', width: 100 },
  { key: 'name', label: 'Tên khách hàng', width: 165 },
  { key: 'phone', label: 'Số điện thoại', width: 105 },
  { key: 'address', label: 'Địa chỉ', width: 280 },
  { key: 'notes', label: 'Ghi chú', width: 220 },
  { key: 'brand', label: 'Nhãn sơn', width: 90 },
  { key: 'manager', label: 'KD quản lý', width: 125 },
  { key: 'pricelist', label: 'Bảng giá', width: 125 },
  { key: 'debt', label: 'Công nợ', width: 115 },
  { key: 'grossSales', label: 'Tổng doanh số', width: 120 },
  { key: 'totalReturns', label: 'Tổng trả hàng', width: 120 },
  { key: 'netSales', label: 'Doanh số sau trả hàng', width: 140 },
  { key: 'createdAt', label: 'Ngày tạo', width: 110 },
  { key: 'debtDays', label: 'Số ngày nợ', width: 95 },
  { key: 'lastTransaction', label: 'Ngày giao dịch cuối', width: 125 }
];

function getVisibleCustomerColumns() {
  const allKeys = CUSTOMER_COLUMN_DEFINITIONS.map(column => column.key);
  try {
    const saved = JSON.parse(localStorage.getItem(CUSTOMER_COLUMN_STORAGE_KEY) || 'null');
    if (Array.isArray(saved)) {
      return new Set(saved.filter(key => allKeys.includes(key)));
    }
  } catch (error) {
    console.warn('Không thể đọc cấu hình cột khách hàng:', error);
  }
  return new Set(allKeys);
}

function saveVisibleCustomerColumns(visibleColumns) {
  localStorage.setItem(
    CUSTOMER_COLUMN_STORAGE_KEY,
    JSON.stringify(CUSTOMER_COLUMN_DEFINITIONS.map(column => column.key).filter(key => visibleColumns.has(key)))
  );
}

function applyCustomerColumnVisibility() {
  const visibleColumns = getVisibleCustomerColumns();
  document.querySelectorAll('[data-customer-column]').forEach(element => {
    element.style.display = visibleColumns.has(element.dataset.customerColumn) ? '' : 'none';
  });
  document.querySelectorAll('[data-customer-actions-column]').forEach(element => {
    element.style.display = state.currentUser?.role === 'sale' ? 'none' : '';
  });

  const table = document.querySelector('.customers-table');
  if (table) {
    const dataWidth = CUSTOMER_COLUMN_DEFINITIONS.reduce(
      (sum, column) => sum + (visibleColumns.has(column.key) ? column.width : 0),
      0
    );
    const actionWidth = state.currentUser?.role === 'sale' ? 45 : 155;
    table.style.minWidth = `${Math.max(420, dataWidth + actionWidth)}px`;
  }

  document.querySelectorAll('.customer-column-option').forEach(input => {
    input.checked = visibleColumns.has(input.value);
  });

  const selectAll = document.getElementById('customer-column-picker-select-all');
  if (selectAll) {
    selectAll.checked = visibleColumns.size === CUSTOMER_COLUMN_DEFINITIONS.length;
    selectAll.indeterminate = visibleColumns.size > 0 && visibleColumns.size < CUSTOMER_COLUMN_DEFINITIONS.length;
  }

  const count = document.getElementById('customer-column-picker-count');
  if (count) count.textContent = `${visibleColumns.size}/${CUSTOMER_COLUMN_DEFINITIONS.length} cột`;
}

function setupCustomerColumnPicker() {
  const picker = document.getElementById('customer-column-picker');
  const button = document.getElementById('btn-customer-column-picker');
  const popover = document.getElementById('customer-column-picker-popover');
  const closeButton = document.getElementById('btn-close-customer-column-picker');
  const options = document.getElementById('customer-column-picker-options');
  const selectAll = document.getElementById('customer-column-picker-select-all');
  const resetButton = document.getElementById('btn-reset-customer-columns');
  if (!picker || !button || !popover || !options) return;

  options.innerHTML = CUSTOMER_COLUMN_DEFINITIONS.map(column => `
    <label class="customer-column-option-label">
      <input class="customer-column-option" type="checkbox" value="${column.key}">
      <span>${column.label}</span>
    </label>
  `).join('');

  const setOpen = (isOpen) => {
    popover.hidden = !isOpen;
    button.setAttribute('aria-expanded', String(isOpen));
  };

  button.addEventListener('click', event => {
    event.stopPropagation();
    setOpen(popover.hidden);
  });
  closeButton?.addEventListener('click', () => setOpen(false));
  picker.addEventListener('click', event => event.stopPropagation());
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') setOpen(false);
  });

  options.addEventListener('change', () => {
    const visibleColumns = new Set(
      Array.from(options.querySelectorAll('.customer-column-option:checked')).map(input => input.value)
    );
    saveVisibleCustomerColumns(visibleColumns);
    applyCustomerColumnVisibility();
  });

  selectAll?.addEventListener('change', () => {
    const visibleColumns = selectAll.checked
      ? new Set(CUSTOMER_COLUMN_DEFINITIONS.map(column => column.key))
      : new Set();
    saveVisibleCustomerColumns(visibleColumns);
    applyCustomerColumnVisibility();
  });

  resetButton?.addEventListener('click', () => {
    localStorage.removeItem(CUSTOMER_COLUMN_STORAGE_KEY);
    applyCustomerColumnVisibility();
  });

  applyCustomerColumnVisibility();
}

function parseImportedNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (value === null || value === undefined) return 0;
  let normalized = String(value)
    .replace(/\s/g, '')
    .replace(/[^\d,.-]/g, '');
  const hasComma = normalized.includes(',');
  const hasDot = normalized.includes('.');
  if (hasComma && hasDot) {
    const decimalSeparator = normalized.lastIndexOf(',') > normalized.lastIndexOf('.') ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = normalized
      .replace(new RegExp(`\\${thousandsSeparator}`, 'g'), '')
      .replace(decimalSeparator, '.');
  } else if (hasComma) {
    const commaParts = normalized.split(',');
    normalized = commaParts.length > 2 || commaParts.at(-1).length === 3
      ? commaParts.join('')
      : commaParts.join('.');
  } else if (hasDot) {
    const dotParts = normalized.split('.');
    normalized = dotParts.length > 2 || dotParts.at(-1).length === 3
      ? dotParts.join('')
      : normalized;
  }
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getTimestamp(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function calculateCustomerTotals(customers) {
  return (customers || []).reduce((totals, customer) => {
    totals.count += 1;
    totals.debt += parseImportedNumber(customer.debt);
    totals.grossSales += parseImportedNumber(customer.totalTransaction ?? customer.total_transaction);
    totals.totalReturns += parseImportedNumber(customer.totalReturn ?? customer.total_return);
    totals.netSales += parseImportedNumber(customer.netRevenue ?? customer.net_revenue);
    return totals;
  }, { count: 0, debt: 0, grossSales: 0, totalReturns: 0, netSales: 0 });
}

function hasExcelValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function parseOptionalImportedNumber(value) {
  return hasExcelValue(value) ? parseImportedNumber(value) : null;
}

function readExcelText(value) {
  return hasExcelValue(value) ? String(value).trim().normalize('NFC') : '';
}

function calculateCustomerImportedBaselineTotals(customers) {
  return (customers || []).reduce((totals, customer) => {
    totals.count += 1;
    totals.debt += parseImportedNumber(customer.importedDebtBaseline ?? customer.debt);
    totals.grossSales += parseImportedNumber(customer.importedTotalTransactionBaseline ?? customer.totalTransaction ?? customer.total_transaction);
    totals.totalReturns += parseImportedNumber(customer.importedTotalReturnBaseline ?? customer.totalReturn ?? customer.total_return);
    totals.netSales += parseImportedNumber(customer.importedNetRevenueBaseline ?? customer.netRevenue ?? customer.net_revenue);
    return totals;
  }, { count: 0, debt: 0, grossSales: 0, totalReturns: 0, netSales: 0 });
}

function customerTotalsMatch(expected, actual) {
  return ['debt', 'grossSales', 'totalReturns', 'netSales']
    .every(key => Math.abs(expected[key] - actual[key]) < 1);
}

function customerImportDatesMatch(expectedCustomers, persistedCustomers) {
  const persistedById = new Map((persistedCustomers || []).map(customer => [String(customer.id), customer]));
  return (expectedCustomers || []).every(expected => {
    const persisted = persistedById.get(String(expected.id));
    if (!persisted) return false;
    const presence = expected.importFieldPresence || {};
    const lastOrderMatches = presence.lastOrderAt === false
      || businessDateKey(expected.lastOrderAt) === businessDateKey(persisted.importedLastOrderAtBaseline);
    const createdMatches = presence.createdAt === false
      || businessDateKey(expected.createdAt) === businessDateKey(persisted.importedCreatedAtBaseline);
    return lastOrderMatches && createdMatches;
  });
}

function makeImportCustomerCodesUnique(customers) {
  const normalizeCode = code => String(code || '').trim().toUpperCase().normalize('NFC');
  const reservedCodes = new Set(customers.map(customer => normalizeCode(customer.code)));
  const usedCodes = new Set();
  const occurrences = new Map();
  let adjustedCount = 0;

  customers.forEach(customer => {
    const baseCode = String(customer.code || '').trim();
    const normalizedBase = normalizeCode(baseCode);
    const occurrence = (occurrences.get(normalizedBase) || 0) + 1;
    occurrences.set(normalizedBase, occurrence);

    if (!usedCodes.has(normalizedBase)) {
      usedCodes.add(normalizedBase);
      return;
    }

    let suffix = occurrence;
    let candidate = `${baseCode}-DUP${suffix}`;
    while (reservedCodes.has(normalizeCode(candidate)) || usedCodes.has(normalizeCode(candidate))) {
      suffix += 1;
      candidate = `${baseCode}-DUP${suffix}`;
    }

    customer.code = candidate;
    usedCodes.add(normalizeCode(candidate));
    adjustedCount += 1;
  });

  return adjustedCount;
}

export function getCustomerMetrics(c) {
  if (!c) return { grossSales: 0, totalReturns: 0, netSales: 0, returnRate: '0', currentDebt: 0, totalPayments: 0 };
  const storedGrossSales = parseImportedNumber(c.totalTransaction ?? c.total_transaction ?? 0);
  const storedReturns = parseImportedNumber(c.totalReturn ?? c.total_return ?? 0);
  const storedNetSalesRaw = parseImportedNumber(c.netRevenue ?? c.net_revenue ?? 0);
  const hasStoredNetSales = c.netRevenue !== undefined && c.netRevenue !== null
    || c.net_revenue !== undefined && c.net_revenue !== null;
  const storedNetSales = hasStoredNetSales
    ? storedNetSalesRaw
    : storedGrossSales - storedReturns;
  const baselineImportedAt = getTimestamp(
    c.salesBaselineImportedAt ||
    c.sales_baseline_imported_at ||
    c.brandDiscounts?.salesBaselineImportedAt ||
    c.brand_discounts?.salesBaselineImportedAt
  );
  if (baselineImportedAt || storedGrossSales || storedReturns || storedNetSalesRaw) {
    const grossSales = storedGrossSales;
    const totalReturns = storedReturns;
    const netSales = storedNetSales;
    const returnRate = grossSales > 0 ? ((totalReturns / grossSales) * 100).toFixed(1) : '0';
    const currentDebt = parseImportedNumber(c.debt || 0);
    const debtHistory = Array.isArray(c.debtHistory) ? c.debtHistory : [];
    const collectedPayments = debtHistory
      .filter(entry => entry.type === 'payment')
      .reduce((sum, entry) => sum + Math.abs(parseImportedNumber(entry.amount)), 0);
    const cancelledPayments = debtHistory
      .filter(entry => entry.type === 'payment_cancel' || (
        entry.type === 'adjust' &&
        String(entry.notes || entry.note || '').toLowerCase().includes('hủy phiếu thu')
      ))
      .reduce((sum, entry) => sum + Math.abs(parseImportedNumber(entry.amount)), 0);
    const totalPayments = Math.max(0, collectedPayments - cancelledPayments);
    return { grossSales, totalReturns, netSales, returnRate, currentDebt, totalPayments };
  }

  const customerOrders = state.savedOrders.filter(o => 
    (o.customerId === c.id || (o.customerName && o.customerName.toLowerCase() === c.name.toLowerCase())) &&
    (o.status === 'settled' || o.status === 'partially_returned' || o.status === 'returned')
  );
  const orderGrossSales = customerOrders.reduce((sum, o) => sum + parseImportedNumber(o.totalPayable), 0);
  
  const customerReturns = (state.salesReturns || []).filter(r => 
    (r.customerId === c.id || (r.customerName && r.customerName.toLowerCase() === c.name.toLowerCase())) &&
    r.status !== 'cancelled'
  );
  const liveReturns = customerReturns.reduce((sum, r) => sum + parseImportedNumber(r.totalRefund), 0);
  
  const grossSales = orderGrossSales;
  const totalReturns = liveReturns;
  const netSales = Math.max(0, grossSales - totalReturns);
  const returnRate = grossSales > 0 ? ((totalReturns / grossSales) * 100).toFixed(1) : '0';
  const currentDebt = parseFloat(c.debt || 0);
  const debtHistory = Array.isArray(c.debtHistory) ? c.debtHistory : [];
  const collectedPayments = debtHistory
    .filter(entry => entry.type === 'payment')
    .reduce((sum, entry) => sum + Math.abs(parseFloat(entry.amount) || 0), 0);
  const cancelledPayments = debtHistory
    .filter(entry => entry.type === 'payment_cancel' || (
      entry.type === 'adjust' &&
      String(entry.notes || entry.note || '').toLowerCase().includes('hủy phiếu thu')
    ))
    .reduce((sum, entry) => sum + Math.abs(parseFloat(entry.amount) || 0), 0);
  const totalPayments = Math.max(0, collectedPayments - cancelledPayments);
  
  return { grossSales, totalReturns, netSales, returnRate, currentDebt, totalPayments };
}

function getCustomerLastTransactionDate(c) {
  if (!c) return '';

  // Imported customers already have one authoritative server field. The RPC
  // sets last_order_at to the later of the Excel baseline and a real finalized
  // order. Do not mix payment, return or debt-ledger timestamps into this
  // Excel column, otherwise its displayed value changes after a receipt or an
  // import adjustment even though "Ngày giao dịch cuối" was stored correctly.
  const hasImportedBaseline = Boolean(
    c.financialBaselineImportedAt
    || c.financial_baseline_imported_at
    || c.salesBaselineImportedAt
    || c.sales_baseline_imported_at
    || c.brandDiscounts?.salesBaselineImportedAt
    || c.brand_discounts?.salesBaselineImportedAt
  );
  if (hasImportedBaseline) return c.lastOrderAt || c.last_order_at || '';

  const timestamps = [];
  const addDate = (value) => {
    if (!value) return;
    const time = new Date(value).getTime();
    if (Number.isFinite(time)) timestamps.push(time);
  };

  addDate(c.lastOrderAt || c.last_order_at);
  addDate(c.lastPaymentAt || c.last_payment_at);

  (state.savedOrders || []).forEach(o => {
    const belongsToCustomer = o.customerId === c.id || (o.customerName && c.name && o.customerName.toLowerCase() === c.name.toLowerCase());
    if (!belongsToCustomer) return;
    addDate(o.createdAt || o.date || o.orderDate || o.updatedAt);
  });

  (state.salesReturns || []).forEach(r => {
    const belongsToCustomer = r.customerId === c.id || (r.customerName && c.name && r.customerName.toLowerCase() === c.name.toLowerCase());
    if (!belongsToCustomer || r.status === 'cancelled') return;
    addDate(r.createdAt || r.returnDate || r.date || r.updatedAt);
  });

  const debtHistory = Array.isArray(c.debtHistory) ? c.debtHistory : [];
  debtHistory
    .filter(entry => entry.type !== 'adjust' || !String(entry.notes || entry.note || '').toLowerCase().includes('kiotviet'))
    .forEach(entry => addDate(entry.date || entry.createdAt || entry.transactionDate));

  if (timestamps.length === 0) return '';
  return new Date(Math.max(...timestamps)).toISOString();
}

function escapeCustomerHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function getCustomerPriceListName(customer) {
  const id = customer.pricelistId || customer.defaultPriceListId || '';
  if (!id) return '';
  if (id === 'custom') return 'Chiết khấu riêng';
  if (id === 'retail') return 'Khách lẻ';
  return [...(state.allPricelists || []), ...(state.pricelists || [])]
    .find(item => String(item.id) === String(id))?.name || id;
}

function addBusinessDaysKey(value, days) {
  const key = customerDateKey(value);
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match || !Number.isFinite(days) || days <= 0) return '';
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12);
  date.setDate(date.getDate() + days);
  return customerDateKey(date);
}

function getCustomerDebtExportStatus(row) {
  const debt = finiteCustomerNumber(row.debt) ?? 0;
  if (debt < 0) return 'Công nợ âm';
  if (debt === 0) return 'Không công nợ';
  const due = customerDateKey(row.dueDate);
  if (!due) return 'Chưa thiết lập hạn';
  const today = customerDateKey(new Date());
  return due < today ? 'Quá hạn' : (due === today ? 'Đến hạn hôm nay' : 'Chưa đến hạn');
}

function buildCustomerViewRows() {
  const customers = (state.customers || []).filter(customer => {
    if (!customer) return false;
    return state.currentUser?.role !== 'sale' || isSameUser(customer.managedBy, state.currentUser.username);
  });
  return customers.map(customer => {
    const metrics = getCustomerMetrics(customer);
    const lastTransactionAt = getCustomerLastTransactionDate(customer);
    const debtDays = Math.trunc(finiteCustomerNumber(customer.debtDays ?? customer.brandDiscounts?.debtDays) ?? 0);
    const provinceCode = customer.brandDiscounts?.province || customer.province || '';
    const row = {
      ...customer,
      id: String(customer.id || ''), code: customer.code || '', name: customer.name || '', phone: customer.phone || '',
      address: customer.address || '', brand: customer.assignedBrand || '', pricelistId: customer.pricelistId || '',
      pricelistName: getCustomerPriceListName(customer), managerId: customer.managedBy || '',
      managerName: customer.managedBy ? getManagerDisplayName(customer.managedBy, state.users) : '',
      provinceCode, provinceName: getProvinceNameByCode(provinceCode) || '', notes: customer.notes || '',
      status: customer.status || 'active', grossSales: metrics.grossSales, totalReturns: metrics.totalReturns,
      netSales: metrics.netSales, debt: finiteCustomerNumber(customer.debt) ?? 0, debtDays,
      lastTransactionAt, createdAt: customer.createdAt || customer.created_at || ''
    };
    row.daysInactive = customerDaysSince(lastTransactionAt);
    row.dueDate = addBusinessDaysKey(lastTransactionAt, debtDays);
    row.debtStatus = getCustomerDebtExportStatus(row);
    return row;
  });
}

function selectedValues(select) {
  return select ? [...select.selectedOptions].map(option => option.value).filter(Boolean) : [];
}

const CUSTOMER_MULTI_SELECT_CONFIG = Object.freeze({
  'customer-filter-brands': 'Chọn nhãn sơn',
  'customer-filter-pricelists': 'Chọn bảng giá',
  'customer-filter-managers': 'Chọn người quản lý',
  'customer-filter-provinces': 'Chọn Tỉnh/Thành'
});

function syncCustomerMultiSelectVisual(select) {
  const root = select?.nextElementSibling?.classList.contains('customer-multi-select') ? select.nextElementSibling : null;
  if (!root) return;
  const selected = [...select.selectedOptions];
  const label = root.querySelector('.customer-multi-select-value');
  if (label) label.textContent = selected.length === 0
    ? root.dataset.placeholder
    : (selected.length === 1 ? selected[0].textContent : `${selected.length} mục đã chọn`);
  root.classList.toggle('has-value', selected.length > 0);
  root.querySelectorAll('.customer-multi-select-option input').forEach(input => {
    const option = select.options[Number(input.dataset.optionIndex)];
    input.checked = Boolean(option?.selected);
  });
}

function syncCustomerMultiSelectVisuals() {
  Object.keys(CUSTOMER_MULTI_SELECT_CONFIG).forEach(id => syncCustomerMultiSelectVisual(document.getElementById(id)));
}

function renderCustomerMultiSelect(selectId, placeholder, shellOnly = false) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.hidden = true;
  select.setAttribute('aria-hidden', 'true');
  let root = select.nextElementSibling?.classList.contains('customer-multi-select') ? select.nextElementSibling : null;
  if (!root) {
    root = document.createElement('div');
    root.className = 'customer-multi-select';
    root.dataset.placeholder = placeholder;
    root.innerHTML = `
      <button class="customer-multi-select-trigger" type="button" aria-expanded="false">
        <span class="customer-multi-select-value"></span><span class="customer-multi-select-chevron">▾</span>
      </button>
      <div class="customer-multi-select-dropdown" hidden>
        <div class="customer-multi-select-tools">
          <input type="search" class="customer-multi-select-search" placeholder="Tìm nhanh...">
          <button type="button" class="customer-multi-select-clear">Bỏ chọn</button>
        </div>
        <div class="customer-multi-select-options"></div>
        <div class="customer-multi-select-empty" hidden>Không tìm thấy kết quả</div>
      </div>`;
    select.after(root);
    root.querySelector('.customer-multi-select-value').textContent = placeholder;
    const trigger = root.querySelector('.customer-multi-select-trigger');
    const dropdown = root.querySelector('.customer-multi-select-dropdown');
    trigger.addEventListener('click', event => {
      event.stopPropagation();
      const open = !root.classList.contains('open');
      document.querySelectorAll('.customer-multi-select.open').forEach(item => {
        item.classList.remove('open');
        item.querySelector('.customer-multi-select-dropdown').hidden = true;
        item.querySelector('.customer-multi-select-trigger').setAttribute('aria-expanded', 'false');
      });
      root.classList.toggle('open', open);
      dropdown.hidden = !open;
      trigger.setAttribute('aria-expanded', String(open));
      if (open) root.querySelector('.customer-multi-select-search').focus();
    });
    root.addEventListener('click', event => event.stopPropagation());
    document.addEventListener('click', () => {
      root.classList.remove('open');
      dropdown.hidden = true;
      trigger.setAttribute('aria-expanded', 'false');
    });
    root.querySelector('.customer-multi-select-search').addEventListener('input', event => {
      const query = normalizeCustomerSearch(event.target.value);
      let visible = 0;
      root.querySelectorAll('.customer-multi-select-option').forEach(item => {
        const show = !query || item.dataset.search.includes(query);
        item.hidden = !show;
        if (show) visible += 1;
      });
      root.querySelector('.customer-multi-select-empty').hidden = visible > 0;
    });
    root.querySelector('.customer-multi-select-clear').addEventListener('click', () => {
      [...select.options].forEach(option => { option.selected = false; });
      syncCustomerMultiSelectVisual(select);
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  // Build all four visible shells first. Option data is populated in a second
  // independent pass so one malformed option can never hide the other fields.
  if (shellOnly) {
    syncCustomerMultiSelectVisual(select);
    return;
  }

  const options = root.querySelector('.customer-multi-select-options');
  options.innerHTML = [...select.options].map((option, index) => `
    <label class="customer-multi-select-option" data-search="${escapeCustomerHtml(normalizeCustomerSearch(option.textContent))}">
      <input type="checkbox" data-option-index="${index}" ${option.selected ? 'checked' : ''}>
      <span title="${escapeCustomerHtml(option.textContent)}">${escapeCustomerHtml(option.textContent)}</span>
    </label>`).join('');
  options.querySelectorAll('input').forEach(input => input.addEventListener('change', () => {
    const option = select.options[Number(input.dataset.optionIndex)];
    if (option) option.selected = input.checked;
    syncCustomerMultiSelectVisual(select);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  }));
  const empty = root.querySelector('.customer-multi-select-empty');
  if (empty) {
    empty.textContent = 'Chưa có dữ liệu phù hợp';
    empty.hidden = select.options.length > 0;
  }
  syncCustomerMultiSelectVisual(select);
}

function syncCustomerQueryFromControls() {
  customerViewQuery.q = document.getElementById('customer-search-input')?.value.trim() || '';
  customerViewQuery.sortKey = document.getElementById('customer-sort-key')?.value || DEFAULT_CUSTOMER_QUERY.sortKey;
  customerViewQuery.pageSize = Number(document.getElementById('customer-page-size')?.value || 20);
  Object.entries(CUSTOMER_QUERY_CONTROL_MAP).forEach(([key, id]) => {
    const control = document.getElementById(id);
    customerViewQuery[key] = control?.multiple ? selectedValues(control) : (control?.value || '');
  });
}

function writeCustomerQueryToUrl() {
  const params = new URLSearchParams(window.location.search);
  [...params.keys()].filter(key => key.startsWith('cust_')).forEach(key => params.delete(key));
  Object.entries(customerViewQuery).forEach(([key, value]) => {
    const defaultValue = DEFAULT_CUSTOMER_QUERY[key];
    if (Array.isArray(value)) {
      if (value.length) params.set(`cust_${key}`, value.join(','));
    } else if (String(value ?? '') !== String(defaultValue ?? '')) {
      params.set(`cust_${key}`, String(value));
    }
  });
  if (state.customersPage > 1) params.set('cust_page', String(state.customersPage));
  else params.delete('cust_page');
  history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`);
}

function restoreCustomerQueryFromUrl() {
  const params = new URLSearchParams(window.location.search);
  customerViewQuery = { ...DEFAULT_CUSTOMER_QUERY };
  Object.keys(DEFAULT_CUSTOMER_QUERY).forEach(key => {
    const value = params.get(`cust_${key}`);
    if (value === null) return;
    if (Array.isArray(DEFAULT_CUSTOMER_QUERY[key])) customerViewQuery[key] = value.split(',').filter(Boolean);
    else if (typeof DEFAULT_CUSTOMER_QUERY[key] === 'number') customerViewQuery[key] = Number(value) || DEFAULT_CUSTOMER_QUERY[key];
    else customerViewQuery[key] = value;
  });
  state.customersPage = Math.max(1, Number(params.get('cust_page')) || 1);
}

function syncCustomerQueryControls() {
  const search = document.getElementById('customer-search-input');
  const sort = document.getElementById('customer-sort-key');
  const pageSize = document.getElementById('customer-page-size');
  if (search) search.value = customerViewQuery.q;
  if (sort) sort.value = customerViewQuery.sortKey;
  if (pageSize) pageSize.value = String(customerViewQuery.pageSize);
  const employeeFilter = document.getElementById('customer-managed-filter');
  if (employeeFilter) employeeFilter.value = customerViewQuery.managerState === 'missing'
    ? 'unassigned'
    : (customerViewQuery.pricelistState === 'missing'
      ? 'unassigned_pricelist'
      : (customerViewQuery.managers.length === 1 ? customerViewQuery.managers[0] : ''));
  Object.entries(CUSTOMER_QUERY_CONTROL_MAP).forEach(([key, id]) => {
    const control = document.getElementById(id);
    if (!control) return;
    if (control.multiple) [...control.options].forEach(option => { option.selected = customerViewQuery[key].includes(option.value); });
    else control.value = customerViewQuery[key] || '';
  });
  const direction = document.getElementById('btn-customer-sort-direction');
  if (direction) {
    direction.innerHTML = `<i data-lucide="arrow-${customerViewQuery.sortDirection === 'asc' ? 'up' : 'down'}"></i>`;
    direction.title = customerViewQuery.sortDirection === 'asc' ? 'Đang tăng dần' : 'Đang giảm dần';
  }
  syncCustomerMultiSelectVisuals();
}

function populateCustomerQueryOptions() {
  const setOptions = (id, entries) => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = entries.map(([value, label]) => `<option value="${escapeCustomerHtml(value)}">${escapeCustomerHtml(label)}</option>`).join('');
  };
  const rows = buildCustomerViewRows();
  const rowEntries = (valueKey, labelKey = valueKey) => rows
    .filter(row => row[valueKey])
    .map(row => [String(row[valueKey]), String(row[labelKey] || row[valueKey])]);
  const mergeEntries = (...groups) => [...new Map(groups.flat()
    .filter(entry => entry?.[0])
    .map(([value, label]) => [String(value), String(label || value)])).entries()]
    .sort((a, b) => a[1].localeCompare(b[1], 'vi', { sensitivity: 'base', numeric: true }));
  const priceLists = [...(state.allPricelists || []), ...(state.pricelists || [])];
  setOptions('customer-filter-brands', mergeEntries(
    rowEntries('brand'),
    (state.brands || []).map(brand => [brand.name || brand.id, brand.name || brand.id])));
  setOptions('customer-filter-pricelists', mergeEntries(
    rowEntries('pricelistId', 'pricelistName'),
    priceLists.map(list => [list.id, list.name || list.id])));
  setOptions('customer-filter-managers', mergeEntries(
    rowEntries('managerId', 'managerName'),
    (state.users || []).map(user => [user.username, user.displayName || user.username])));
  setOptions('customer-filter-provinces', mergeEntries(
    rowEntries('provinceCode', 'provinceName'),
    Object.entries(PROVINCES)));
  syncCustomerQueryControls();
  const multiSelects = Object.entries(CUSTOMER_MULTI_SELECT_CONFIG);
  multiSelects.forEach(([id, placeholder]) => {
    try {
      renderCustomerMultiSelect(id, placeholder, true);
    } catch (error) {
      console.error(`Không thể khởi tạo ô phân loại ${id}:`, error);
    }
  });
  multiSelects.forEach(([id, placeholder]) => {
    try {
      renderCustomerMultiSelect(id, placeholder);
    } catch (error) {
      console.error(`Không thể nạp lựa chọn cho ${id}:`, error);
    }
  });
}

function refreshCustomerQueryOptionsIfNeeded() {
  const signature = [
    (state.customers || []).map(customer => [customer.id, customer.assignedBrand, customer.pricelistId,
      customer.managedBy, customer.brandDiscounts?.province || customer.province].join(':')).join('|'),
    (state.brands || []).map(item => `${item.id}:${item.name}`).join('|'),
    [...(state.allPricelists || []), ...(state.pricelists || [])]
      .map(item => `${item.id}:${item.name}`).join('|'),
    (state.users || []).map(item => `${item.username}:${item.displayName}`).join('|')
  ].join('||');
  if (signature === customerFilterOptionSignature) return;
  customerFilterOptionSignature = signature;
  populateCustomerQueryOptions();
}

function getActiveCustomerFilterCount() {
  return Object.entries(customerViewQuery).reduce((count, [key, value]) => {
    if (['q', 'sortKey', 'sortDirection', 'nulls', 'pageSize', 'salesMetric'].includes(key)) return count;
    return count + (Array.isArray(value) ? (value.length ? 1 : 0) : (value ? 1 : 0));
  }, 0);
}

function updateCustomerSelectionStatus() {
  const selection = document.getElementById('customer-selection-count');
  const clear = document.getElementById('btn-clear-customer-selection');
  if (selection) {
    selection.hidden = selectedCustomerIdsForExport.size === 0;
    selection.textContent = `Đã chọn ${selectedCustomerIdsForExport.size} khách hàng`;
  }
  if (clear) clear.hidden = selectedCustomerIdsForExport.size === 0;
}

function applyCustomerQueryChange({ clearSelection = true } = {}) {
  syncCustomerQueryFromControls();
  state.customersPage = 1;
  if (clearSelection) selectedCustomerIdsForExport.clear();
  writeCustomerQueryToUrl();
  renderCustomersTable();
}

function getFilteredCustomersForCurrentView() {
  return queryCustomerRows(buildCustomerViewRows(), customerViewQuery);
}

export function renderCustomersTable() {

  const tableBody = document.getElementById('customers-table-body');
  if (!tableBody) return;
  refreshCustomerQueryOptionsIfNeeded();
  const filtered = getFilteredCustomersForCurrentView();
  customerFilteredRows = filtered;
  
  // Tính toán tổng nợ và doanh thu đại lý lọc được
  const totalDebt = filtered.reduce((sum, c) => sum + (parseFloat(c.debt) || 0), 0);
  let totalNetSales = 0;
  const totalSales = filtered.reduce((sum, c) => {
    const metrics = getCustomerMetrics(c);
    totalNetSales += metrics.netSales;
    return sum + metrics.grossSales;
  }, 0);
  
  const debtEl = document.getElementById('cust-summary-total-debt');
  const salesEl = document.getElementById('cust-summary-total-sales');
  const netSalesEl = document.getElementById('cust-summary-net-sales');
  if (debtEl) debtEl.innerText = formatCurrency(totalDebt);
  if (salesEl) salesEl.innerText = formatCurrency(totalSales);
  if (netSalesEl) netSalesEl.innerText = formatCurrency(totalNetSales);
  
  const ITEMS_PER_PAGE = Number(customerViewQuery.pageSize) || 20;
  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
  
  if (state.customersPage > totalPages) state.customersPage = totalPages;
  if (state.customersPage < 1) state.customersPage = 1;
  
  const startIndex = (state.customersPage - 1) * ITEMS_PER_PAGE;
  const paginatedCustomers = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  customerCurrentPageRows = paginatedCustomers;
  const resultCount = document.getElementById('customer-result-count');
  if (resultCount) resultCount.textContent = `Đang hiển thị ${totalItems}/${buildCustomerViewRows().length} khách hàng`;
  const modalResultButton = document.getElementById('btn-apply-customer-filter-modal');
  if (modalResultButton) modalResultButton.innerHTML = `<i data-lucide="check"></i> Xem ${totalItems.toLocaleString('vi-VN')} kết quả`;
  const filterCount = document.getElementById('customer-active-filter-count');
  const activeFilterCount = getActiveCustomerFilterCount();
  if (filterCount) {
    filterCount.hidden = activeFilterCount === 0;
    filterCount.textContent = String(activeFilterCount);
  }
  updateCustomerSelectionStatus();
  
  // Vẽ các nút phân trang
  const paginationContainer = document.getElementById('customers-pagination');
  if (paginationContainer) {
    paginationContainer.innerHTML = `
      <div class="pagination-controls" style="display: flex; justify-content: center; align-items: center; gap: 1rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border-color); width: 100%;">
        <button class="btn btn-secondary btn-sm" id="customers-prev-page" ${state.customersPage === 1 ? 'disabled' : ''}>
          <i data-lucide="chevron-left" style="width: 16px; height: 16px;"></i> Trước
        </button>
        <span style="font-size: 0.9rem; color: var(--text-secondary); font-weight: 500;">
          Trang <strong>${state.customersPage}</strong> / ${totalPages} (${totalItems} đại lý)
        </span>
        <button class="btn btn-secondary btn-sm" id="customers-next-page" ${state.customersPage === totalPages ? 'disabled' : ''}>
          Sau <i data-lucide="chevron-right" style="width: 16px; height: 16px;"></i>
        </button>
      </div>
    `;

    const prevPageBtn = document.getElementById('customers-prev-page');
    if (prevPageBtn) {
      prevPageBtn.addEventListener('click', () => {
        state.customersPage--;
        writeCustomerQueryToUrl();
        renderCustomersTable();
        document.getElementById('customers-panel').scrollIntoView({ behavior: 'smooth' });
      });
    }

    const nextPageBtn = document.getElementById('customers-next-page');
    if (nextPageBtn) {
      nextPageBtn.addEventListener('click', () => {
        state.customersPage++;
        writeCustomerQueryToUrl();
        renderCustomersTable();
        document.getElementById('customers-panel').scrollIntoView({ behavior: 'smooth' });
      });
    }
  }

  if (filtered.length === 0) {
    const extraColumnCount = state.currentUser?.role === 'sale' ? 1 : 2;
    tableBody.innerHTML = `
      <tr>
        <td colspan="${getVisibleCustomerColumns().size + extraColumnCount}" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không tìm thấy khách hàng nào.
        </td>
      </tr>
    `;
    applyCustomerColumnVisibility();
    return;
  }
  
  tableBody.innerHTML = paginatedCustomers.map((c) => {
    const actualIndex = state.customers.findIndex(cust => cust.id === c.id);
    
    let pricelistName = '';
    let tooltipTitle = '';
    const plId = c.pricelistId || '';
    if (plId === '') {
      pricelistName = '<span style="color: #ef4444; font-weight: 500;">Chưa xác định</span>';
      tooltipTitle = 'Chưa áp dụng bảng giá';
    } else if (plId === 'custom') {
      const discSummary = [];
      if (c.brandDiscounts) {
        for (const [brand, pct] of Object.entries(c.brandDiscounts)) {
          if (!['province', 'salesBaselineImportedAt', 'debtDays'].includes(brand) && pct > 0) {
            discSummary.push(`${brand}: ${pct}%`);
          }
        }
      }
      pricelistName = discSummary.length > 0 
        ? `CK riêng (${discSummary.join(', ')})` 
        : 'Chiết khấu riêng';
      tooltipTitle = discSummary.length > 0 ? discSummary.join('\n') : 'Chiết khấu riêng (Chưa cấu hình)';
    } else if (plId === 'retail') {
      pricelistName = 'Khách lẻ (Nhập tay)';
      tooltipTitle = 'Khách lẻ (Tự nhập chiết khấu khi tạo đơn)';
    } else {
      const pl = state.pricelists.find(p => p.id === plId);
      if (pl) {
        pricelistName = pl.name;
        const plDiscs = [];
        if (pl.brandDiscounts) {
          for (const [brand, pct] of Object.entries(pl.brandDiscounts)) {
            if (pct > 0) {
              plDiscs.push(`${brand}: ${pct}%`);
            }
          }
        }
        tooltipTitle = `${pl.name}:\n${plDiscs.length > 0 ? plDiscs.join('\n') : 'Không chiết khấu hãng'}`;
      } else {
        pricelistName = plId;
        tooltipTitle = plId;
      }
    }
    

    
    const provinceName = getProvinceNameByCode(c.brandDiscounts && c.brandDiscounts.province);
    const displayAddr = provinceName ? `[${provinceName}] ${c.address || ''}` : (c.address || '<span style="color: var(--text-muted);">N/A</span>');
    const addrTitle = provinceName ? `[${provinceName}] ${c.address || ''}` : (c.address || '');
    const notes = String(c.notes || '').trim();
    const notesHtml = notes
      ? escapeCustomerHtml(notes)
      : '<span style="color: var(--text-muted);">Không có</span>';
    
    const metrics = getCustomerMetrics(c);
    const lastTransactionDate = getCustomerLastTransactionDate(c);
    const lastTransactionLabel = lastTransactionDate ? formatDateOnly(lastTransactionDate) : '<span style="color: var(--text-muted);">Chưa có</span>';
    const createdAt = c.createdAt || c.created_at;
    const createdAtLabel = createdAt ? formatDateOnly(createdAt) : '<span style="color: var(--text-muted);">Chưa có</span>';
    const debtDays = Math.trunc(parseImportedNumber(c.debtDays ?? c.brandDiscounts?.debtDays ?? 0));
    
    return `
      <tr>
        <td style="text-align: center;">
          <input type="checkbox" class="customer-export-checkbox" data-id="${c.id}" ${selectedCustomerIdsForExport.has(String(c.id)) ? 'checked' : ''} title="Chọn khách hàng để xuất lịch sử">
        </td>
        <td data-customer-column="code" style="font-weight: 600; color: #fff;">${c.code}</td>
        <td data-customer-column="name" style="font-weight: 500;">
          <span class="view-cust-detail-link" data-index="${actualIndex}" style="cursor: pointer; color: #22c55e; text-decoration: underline; font-weight: 600;" title="Xem chi tiết & Lịch sử công nợ">
            ${c.name}
          </span>
        </td>
        <td data-customer-column="phone">${c.phone || '<span style="color: var(--text-muted);">N/A</span>'}</td>
        <td data-customer-column="address" style="font-size: 0.8rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${addrTitle}">${displayAddr}</td>
        <td data-customer-column="notes" title="${escapeCustomerHtml(notes)}"><div class="customer-notes-cell">${notesHtml}</div></td>
        <td data-customer-column="brand">
          <span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(34, 197, 94, 0.15)'}; color: ${c.assignedBrand === 'Tất cả' ? '#10b981' : '#22c55e'}; border: 1px solid ${c.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(34, 197, 94, 0.3)'};">${c.assignedBrand}</span>
        </td>
        <td data-customer-column="manager" style="font-size: 0.85rem; max-width: 140px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
          ${c.managedBy ? getManagerDisplayName(c.managedBy, state.users) : '<span style="color: #ef4444; font-weight: 500;">Chưa bàn giao</span>'}
        </td>
        <td data-customer-column="pricelist" style="font-size: 0.75rem; color: var(--text-secondary); max-width: 130px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${tooltipTitle}">${pricelistName}</td>
        <td data-customer-column="debt" class="customer-money-cell" style="color: ${c.debt > 0 ? 'var(--color-danger)' : (c.debt < 0 ? 'var(--color-success)' : 'var(--text-muted)')};">${formatCurrency(c.debt)}</td>
        <td data-customer-column="grossSales" class="customer-money-cell" style="color: var(--color-primary);">${formatCurrency(metrics.grossSales)}</td>
        <td data-customer-column="totalReturns" class="customer-money-cell" style="color: var(--color-warning);">${formatCurrency(metrics.totalReturns)}</td>
        <td data-customer-column="netSales" class="customer-money-cell" style="color: #10b981;">${formatCurrency(metrics.netSales)}</td>
        <td data-customer-column="createdAt" style="text-align: center; font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap;">${createdAtLabel}</td>
        <td data-customer-column="debtDays" style="text-align: center; font-size: 0.8rem; color: ${debtDays > 0 ? 'var(--color-warning)' : 'var(--text-muted)'}; white-space: nowrap;">${debtDays}</td>
        <td data-customer-column="lastTransaction" style="text-align: center; font-size: 0.8rem; color: var(--text-secondary); white-space: nowrap;">${lastTransactionLabel}</td>
        <td data-customer-actions-column style="text-align: center;">
          <div class="actions-cell" style="justify-content: center; gap: 0.35rem;">
            <button class="btn btn-secondary btn-sm btn-circle edit-cust-btn" data-index="${actualIndex}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-primary btn-sm btn-circle pay-debt-btn" data-index="${actualIndex}" title="Thu nợ" style="background-color: var(--color-primary); color: #fff;">
              <i data-lucide="banknote" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-cust-btn" data-index="${actualIndex}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  applyCustomerColumnVisibility();
  
  // Gán sự kiện click cho các nút hành động
  if (state.currentUser?.role === 'sale') {
    document.querySelectorAll('.edit-cust-btn, .pay-debt-btn, .delete-cust-btn').forEach(button => button.remove());
  }

  document.querySelectorAll('.customer-export-checkbox').forEach(box => {
    box.addEventListener('change', () => {
      const id = String(box.getAttribute('data-id'));
      if (box.checked) selectedCustomerIdsForExport.add(id);
      else selectedCustomerIdsForExport.delete(id);
      updateCustomerSelectionStatus();
      const selectAll = document.getElementById('customer-select-all-export');
      if (selectAll) {
        const visibleIds = paginatedCustomers.map(c => String(c.id));
        selectAll.checked = visibleIds.length > 0 && visibleIds.every(id => selectedCustomerIdsForExport.has(id));
      }
    });
  });

  const selectAllExport = document.getElementById('customer-select-all-export');
  if (selectAllExport) {
    const visibleIds = paginatedCustomers.map(c => String(c.id));
    selectAllExport.checked = visibleIds.length > 0 && visibleIds.every(id => selectedCustomerIdsForExport.has(id));
    selectAllExport.onchange = () => {
      visibleIds.forEach(id => {
        if (selectAllExport.checked) selectedCustomerIdsForExport.add(id);
        else selectedCustomerIdsForExport.delete(id);
      });
      renderCustomersTable();
    };
  }

  document.querySelectorAll('.view-cust-detail-link').forEach(link => {
    link.addEventListener('click', () => {
      const idx = parseInt(link.getAttribute('data-index'));
      openCustomerDetailModal(idx);
    });
  });

  document.querySelectorAll('.edit-cust-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      openCustomerModal(idx);
    });
  });
  
  document.querySelectorAll('.pay-debt-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      openPayDebtModal(idx);
    });
  });
  
  document.querySelectorAll('.delete-cust-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      deleteCustomer(idx);
    });
  });
  
  safeCreateIcons();
}

export function generateRandomCustomerCode(provinceCode) {
  const randNum = Math.floor(1000 + Math.random() * 9000); // 4 digits
  const pCode = provinceCode || 'DL';
  return `KH-${pCode}-${randNum}`;
}

export function generateUniqueCustomerCode(provinceCode) {
  let code = '';
  let exists = true;
  let attempts = 0;
  
  while (exists && attempts < 100) {
    code = generateRandomCustomerCode(provinceCode);
    exists = state.customers.some(c => c.code === code);
    attempts++;
  }
  return code;
}

export function openCustomerModal(index = -1) {
  if (state.currentUser?.role === 'sale' && index !== -1) {
    openCustomerDetailModal(index);
    showToast('Kinh doanh chỉ được xem thông tin khách hàng đã tạo.', 'warning');
    return;
  }

  const modal = document.getElementById('customer-modal');
  const title = document.getElementById('customer-modal-title');
  const form = document.getElementById('customer-form');
  
  if (!modal) return;

  // Dynamic rendering of brand discount inputs in customer modal
  const container = document.getElementById('customer-brand-discounts-container');
  if (container) {
    const brands = state.brands && state.brands.length > 0
      ? state.brands
      : [
          { name: 'Nano10*' },
          { name: 'Hatacco nano' },
          { name: 'mutsutec' },
          { name: 'tdkaw' },
          { name: 'cova' },
          { name: 'festivanano' }
        ];
        
    container.innerHTML = brands.map(b => `
      <div class="form-group" style="margin-bottom: 0;">
        <label class="form-label">Chiết khấu ${b.name} (%)</label>
        <input type="number" class="form-control cust-brand-disc" data-brand="${b.name}" value="0" min="0" max="100" step="any">
      </div>
    `).join('');
  }

  // Dynamic population of cust-assigned-brand
  const assignedBrandSelect = document.getElementById('cust-assigned-brand');
  if (assignedBrandSelect) {
    const brands = state.brands && state.brands.length > 0
      ? state.brands.map(b => b.name)
      : ['Nano10*', 'Hatacco nano', 'mutsutec', 'tdkaw', 'cova', 'festivanano'];
      
    assignedBrandSelect.innerHTML = `
      <option value="Tất cả">Chọn nhãn sơn</option>
      ${brands.map(b => `<option value="${b}">${b}</option>`).join('')}
    `;
  }

  modal.classList.add('active');
  form.reset();
  
  // Số dư luôn chỉ đọc. Người có quyền điều chỉnh qua RPC để lưu ledger/audit.
  const debtInput = document.getElementById('cust-debt');
  if (debtInput) debtInput.readOnly = true;
  const adjustDebtBtn = document.getElementById('btn-open-customer-debt-adjust');
  const canAdjustDebt = ['admin', 'accounting'].includes(state.currentUser?.role) && index !== -1;
  if (adjustDebtBtn) adjustDebtBtn.style.display = canAdjustDebt ? 'inline-flex' : 'none';
  
  const isSale = state.currentUser && state.currentUser.role === 'sale';
  const plSelect = document.getElementById('cust-pricelist');
  if (plSelect) {
    plSelect.innerHTML = `
      <option value="custom" ${isSale ? 'disabled' : ''}>Chiết khấu riêng (Tự thiết lập bên dưới)</option>
      ${state.pricelists.map(pl => `<option value="${pl.id}">${pl.name}</option>`).join('')}
    `;
  }
  
  document.querySelectorAll('.cust-brand-disc').forEach(input => {
    input.value = 0;
    if (isSale) {
      input.setAttribute('disabled', 'true');
    } else {
      input.removeAttribute('disabled');
    }
  });
  
  const provinceSelect = document.getElementById('cust-province');
  if (provinceSelect) {
    provinceSelect.value = '';
  }

  if (index === -1) {
    title.innerText = 'Thêm khách hàng mới';
    document.getElementById('customer-edit-index').value = '-1';
    document.getElementById('customer-edit-id').value = '';
    

    document.getElementById('cust-code').value = generateUniqueCustomerCode('');
    
    if (plSelect) {
      if (isSale && state.pricelists.length > 0) {
        plSelect.value = state.pricelists[0].id;
      } else {
        plSelect.value = 'custom';
      }
    }
    const discSection = document.getElementById('cust-brand-discounts-section');
    if (discSection) {
      discSection.style.display = (plSelect && plSelect.value === 'custom') ? 'block' : 'none';
    }
    const mBySelect = document.getElementById('cust-managed-by');
    if (mBySelect) {
      mBySelect.value = state.currentUser ? state.currentUser.username : 'nhat';
    }
    
    document.getElementById('cust-assigned-brand').value = 'Tất cả';
    makeSelectSearchable('cust-assigned-brand', 'Chọn nhãn sơn', false);
  } else {
    title.innerText = 'Chỉnh sửa khách hàng';
    const customer = state.customers[index];
    document.getElementById('customer-edit-index').value = index;
    document.getElementById('customer-edit-id').value = customer.id;
    
    document.getElementById('cust-code').value = customer.code;
    document.getElementById('cust-name').value = customer.name;
    document.getElementById('cust-phone').value = customer.phone || '';
    document.getElementById('cust-address').value = customer.address || '';
    document.getElementById('cust-assigned-brand').value = customer.assignedBrand || 'Tất cả';
    makeSelectSearchable('cust-assigned-brand', 'Chọn nhãn sơn', false);
    document.getElementById('cust-debt').value = customer.debt || 0;
    document.getElementById('cust-notes').value = customer.notes || '';
    
    const cPlId = customer.pricelistId || 'custom';
    if (plSelect) plSelect.value = cPlId;
    
    const discSection = document.getElementById('cust-brand-discounts-section');
    if (discSection) {
      discSection.style.display = cPlId === 'custom' ? 'block' : 'none';
    }
    
    document.querySelectorAll('.cust-brand-disc').forEach(input => {
      const brand = input.getAttribute('data-brand');
      input.value = (customer.brandDiscounts && customer.brandDiscounts[brand] !== undefined) ? customer.brandDiscounts[brand] : 0;
    });

    if (provinceSelect) {
      provinceSelect.value = (customer.brandDiscounts && customer.brandDiscounts.province) ? customer.brandDiscounts.province : '';
    }

    const mBySelect = document.getElementById('cust-managed-by');
    if (mBySelect) {
      const mByVal = customer.managedBy || 'nhat';
      const matchingUser = state.users.find(u => isSameUser(u.username, mByVal));
      mBySelect.value = matchingUser ? matchingUser.username : mByVal;
    }
  }
}

export function closeCustomerModal() {
  const modal = document.getElementById('customer-modal');
  if (modal) modal.classList.remove('active');
}

function clearCustomerFieldError(field) {
  if (!field) return;
  field.classList.remove('customer-field-invalid');
  field.closest('.searchable-select-wrapper')
    ?.querySelector('.searchable-select-trigger')
    ?.classList.remove('customer-field-invalid');
}

function validateCustomerForm() {
  const requiredFields = [
    ['cust-code', 'Vui lòng nhập mã khách hàng.'],
    ['cust-name', 'Vui lòng nhập tên khách hàng.'],
    ['cust-phone', 'Vui lòng nhập số điện thoại.'],
    ['cust-province', 'Vui lòng chọn Tỉnh/Thành phố.'],
    ['cust-pricelist', 'Vui lòng chọn bảng giá mặc định áp dụng.']
  ];
  requiredFields.forEach(([id]) => clearCustomerFieldError(document.getElementById(id)));
  const invalidEntry = requiredFields.find(([id]) => {
    const field = document.getElementById(id);
    return !field || !String(field.value || '').trim();
  });
  if (!invalidEntry) return true;

  const [invalidId, message] = invalidEntry;
  const field = document.getElementById(invalidId);
  const visibleControl = field?.closest('.searchable-select-wrapper')
    ?.querySelector('.searchable-select-trigger') || field;
  visibleControl?.classList.add('customer-field-invalid');
  visibleControl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  if (visibleControl && !visibleControl.hasAttribute('tabindex')) visibleControl.setAttribute('tabindex', '-1');
  visibleControl?.focus({ preventScroll: true });
  showToast(message, 'warning');
  return false;
}

export async function saveCustomer() {
  const index = parseInt(document.getElementById('customer-edit-index').value);
  const editId = document.getElementById('customer-edit-id').value;
  const isEditing = index !== -1 && Boolean(editId);
  // Realtime refreshes can reorder state.customers while this modal is open.
  // Resolve the edited record by its stable id instead of trusting the old array index.
  const editedCustomer = isEditing
    ? state.customers.find(customer => String(customer.id) === String(editId)) || null
    : null;

  if (state.currentUser?.role === 'sale' && isEditing) {
    showToast('Kinh doanh không được sửa thông tin khách hàng đã thêm. Vui lòng liên hệ quản trị/kế toán để cập nhật.', 'warning');
    closeCustomerModal();
    return;
  }
  if (!validateCustomerForm()) return;
  
  const code = document.getElementById('cust-code').value.trim().toUpperCase();
  const name = document.getElementById('cust-name').value.trim();
  const phone = document.getElementById('cust-phone').value.trim();
  const address = document.getElementById('cust-address').value.trim();
  const assignedBrand = document.getElementById('cust-assigned-brand').value;
  
  // Công nợ chỉ hiển thị trong form hồ sơ; không bao giờ lấy làm payload lưu.
  let debt = isEditing ? Number(editedCustomer?.debt || 0) : 0;
  
  const notes = document.getElementById('cust-notes').value.trim();
  const pricelistId = document.getElementById('cust-pricelist').value;
  
  if (!assignedBrand) {
    showToast('Vui lòng chọn nhãn đại lý độc quyền!', 'warning');
    return;
  }
  if (!pricelistId) {
    showToast('Vui lòng chọn bảng giá mặc định áp dụng!', 'warning');
    return;
  }
  
  let managedBy = 'nhat';
  if (state.currentUser) {
    if (state.currentUser.role === 'sale') {
      if (!isEditing) {
        managedBy = state.currentUser.username;
      } else {
        managedBy = editedCustomer?.managedBy || state.currentUser.username;
      }
    } else {
      managedBy = document.getElementById('cust-managed-by').value;
    }
  }
  // Lưu trữ đầy đủ email/username để đảm bảo tính đồng nhất
  
  const duplicateCode = state.customers.some(c => (
    c.code === code && (!isEditing || String(c.id) !== String(editId))
  ));
  if (duplicateCode) {
    showToast('Mã khách hàng đã tồn tại trên hệ thống!', 'danger');
    return;
  }
  
  const cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone) {
    const duplicatePhone = state.customers.some(c => {
      if (isEditing && String(c.id) === String(editId)) return false;
      const cPhone = (c.phone || '').replace(/\D/g, '');
      return cPhone === cleanPhone;
    });
    if (duplicatePhone) {
      showToast('Số điện thoại đã được đăng ký cho khách hàng khác!', 'danger');
      return;
    }
  }
  
  const brandDiscounts = {};
  document.querySelectorAll('.cust-brand-disc').forEach(input => {
    const brand = input.getAttribute('data-brand');
    brandDiscounts[brand] = parseFloat(input.value) || 0;
  });
  
  const provinceSelect = document.getElementById('cust-province');
  if (provinceSelect) {
    brandDiscounts.province = provinceSelect.value;
  }
  if (editedCustomer?.brandDiscounts?.salesBaselineImportedAt) {
    brandDiscounts.salesBaselineImportedAt = editedCustomer.brandDiscounts.salesBaselineImportedAt;
  }
  if (editedCustomer?.brandDiscounts?.debtDays !== undefined) {
    brandDiscounts.debtDays = editedCustomer.brandDiscounts.debtDays;
  }
  
  const customerId = isEditing ? editId : `cust-${Date.now()}`;
  
  // Ghi nhận biến động công nợ nếu Admin/Kế toán trực tiếp điều chỉnh công nợ khách hàng
  const oldCust = editedCustomer;
  const oldDebt = oldCust ? oldCust.debt || 0 : 0;
  const debtHistory = oldCust ? [...(oldCust.debtHistory || [])] : [];
  
  const matchedCustBrand = (state.brands || []).find(b => b.name.toLowerCase() === (assignedBrand || '').toLowerCase() || b.id === assignedBrand);
  const assignedBrandId = matchedCustBrand ? matchedCustBrand.id : (assignedBrand === 'Tất cả' ? 'Tất cả' : ('brand_' + String(assignedBrand).toLowerCase().replace(/[^a-z0-9]/g, '')));

  const customerData = {
    id: customerId,
    code,
    name,
    phone,
    address,
    assignedBrand,
    assignedBrandId,
    brandDiscounts,
    // Không upsert trực tiếp số dư mới. RPC công nợ sẽ ghi ledger sau khi hồ sơ tồn tại.
    debt: oldDebt,
    totalTransaction: isEditing ? editedCustomer?.totalTransaction || 0 : 0,
    totalReturn: isEditing ? editedCustomer?.totalReturn || 0 : 0,
    netRevenue: isEditing ? editedCustomer?.netRevenue || 0 : 0,
    debtDays: isEditing ? editedCustomer?.debtDays ?? editedCustomer?.brandDiscounts?.debtDays ?? 0 : 0,
    lastOrderAt: isEditing ? editedCustomer?.lastOrderAt || editedCustomer?.last_order_at || null : null,
    lastPaymentAt: isEditing ? editedCustomer?.lastPaymentAt || editedCustomer?.last_payment_at || null : null,
    createdAt: isEditing ? editedCustomer?.createdAt || editedCustomer?.created_at || new Date().toISOString() : new Date().toISOString(),
    salesBaselineImportedAt: isEditing ? editedCustomer?.salesBaselineImportedAt || '' : '',
    notes,
    pricelistId,
    managedBy,
    debtHistory
  };
  
  const saved = await dbSaveCustomer(customerData);
  if (saved) {
    const refreshedCustomer = await dbFetchCustomerById(customerId);
    if (refreshedCustomer) {
      debt = Number(refreshedCustomer.debt || 0);
      Object.assign(customerData, refreshedCustomer);
    }
    if (!isEditing) showToast('Thêm khách hàng thành công!');
    else showToast('Cập nhật khách hàng thành công!');
    
    // Nếu cập nhật đúng khách hàng đang chọn lên đơn, cập nhật lại giao diện lên đơn
    if (state.activeCustomerId === customerId) {
      state.activeCustomerBrand = assignedBrand;
      document.getElementById('selected-customer-name-lbl').innerText = name;
      document.getElementById('selected-customer-phone-lbl').innerText = phone || 'N/A';
      document.getElementById('selected-customer-address-lbl').innerText = address || 'N/A';
      document.getElementById('selected-customer-brand-lbl').innerText = assignedBrand;
      
      const pl = state.pricelists.find(p => p.id === pricelistId);
      const plName = pl ? pl.name : (pricelistId === 'custom' ? 'Chiết khấu riêng' : (pricelistId === 'retail' ? 'Nhập tay' : 'Chiết khấu riêng'));
      const plLbl = document.getElementById('selected-customer-pricelist-lbl');
      if (plLbl) plLbl.innerText = plName;
      
      document.getElementById('selected-customer-debt-lbl').innerText = formatCurrency(debt);
      

      
      const invoicePlSelect = document.getElementById('invoice-pricelist-select');
      if (invoicePlSelect) {
        invoicePlSelect.value = pricelistId;
        invoicePlSelect.dataset.explicitOverride = 'false';
      }
      
      applyActivePriceListToInvoice();
    }
    
    // Cập nhật State local
    const idx = state.customers.findIndex(c => c.id === customerId);
    if (idx === -1) state.customers.push(customerData);
    localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
    
    closeCustomerModal();
    renderAll();
  }
}

export async function deleteCustomer(index) {
  if (state.currentUser?.role === 'sale') {
    showToast('Kinh doanh không được xóa khách hàng.', 'warning');
    return;
  }

  const cust = state.customers[index];
  if (confirm(`Bạn có chắc chắn muốn xóa khách hàng "${cust.name}" (${cust.code})?`)) {
    const deleted = await dbDeleteCustomer(cust.id);
    if (deleted) {
      if (state.activeCustomerId === cust.id) {
        resetInvoiceCustomer();
      }
      state.customers = state.customers.filter(c => c.id !== cust.id);
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      renderAll();
      showToast('Xóa khách hàng thành công!', 'warning');
    }
  }
}

// --- Logic Thu Nợ khách hàng ---
export function openPayDebtModal(customerIndex) {
  if (state.currentUser?.role === 'sale') {
    showToast('Kinh doanh chỉ được xem công nợ, không được ghi nhận thu nợ.', 'warning');
    return;
  }

  const modal = document.getElementById('pay-debt-modal');
  const form = document.getElementById('pay-debt-form');
  const cust = state.customers[customerIndex];
  if (!modal || !cust) return;
  
  modal.classList.add('active');
  form.reset();
  pendingCustomerPaymentKey = globalThis.crypto.randomUUID();
  
  document.getElementById('pay-debt-customer-id').value = cust.id;
  document.getElementById('pay-debt-cust-name').innerText = `${cust.name} (${cust.code})`;
  document.getElementById('pay-debt-cust-current-debt').innerText = formatCurrency(cust.debt);
}

export function closePayDebtModal() {
  const modal = document.getElementById('pay-debt-modal');
  if (modal) modal.classList.remove('active');
  pendingCustomerPaymentKey = '';
}

export async function handlePayDebtSubmit(e) {
  e.preventDefault();
  const customerId = document.getElementById('pay-debt-customer-id').value;
  const amountPaid = parseFloat(document.getElementById('pay-debt-amount').value);
  const notes = document.getElementById('pay-debt-notes').value.trim() || 'Thu tiền khách hàng';
  
  if (!customerId || isNaN(amountPaid) || amountPaid <= 0) {
    showToast('Số tiền trả không hợp lệ!', 'danger');
    return;
  }
  
  const cust = state.customers.find(c => c.id === customerId);
  if (!cust) return;

  const debtBefore = Number(cust.debt) || 0;
  
  if (!pendingCustomerPaymentKey) pendingCustomerPaymentKey = globalThis.crypto.randomUUID();
  const currentUserDisp = state.currentUser ? (state.currentUser.displayName || state.currentUser.username) : 'Administrator';
  const paymentResult = await dbRecordCustomerPayment(cust.id, amountPaid, notes, 'cash', pendingCustomerPaymentKey);
  if (!paymentResult) return;
  if (!paymentResult.cashbook_id) {
    showToast('Database không trả về mã phiếu thu. Giao diện chưa cập nhật để tránh ghi trùng.', 'danger');
    return;
  }

  const rpcDebt = Number(paymentResult.new_debt);
  const fallbackDebt = Number.isFinite(rpcDebt)
    ? rpcDebt
    : collectCustomerDebt(debtBefore, amountPaid);
  // The customer UPDATE and ledger INSERT can reach Realtime before this await
  // resumes. Refresh by id so the UI never writes the receipt result into an
  // object that Realtime has already replaced in state.customers.
  const refreshedCustomer = await dbRefreshCustomerFinancialState(cust.id, { includeHistory: false });
  const currentCustomer = refreshedCustomer
    || state.customers.find(customer => String(customer.id) === String(cust.id))
    || cust;
  if (!refreshedCustomer) {
    currentCustomer.debt = fallbackDebt;
    currentCustomer.lastPaymentAt = new Date().toISOString();
  }
  
  // Idempotent retry must not duplicate the local display cache.
  if (!refreshedCustomer && !paymentResult.already_recorded) {
    if (!currentCustomer.debtHistory) currentCustomer.debtHistory = [];
    currentCustomer.debtHistory.push({
      id: paymentResult.ledger_id || `pay-${pendingCustomerPaymentKey}`,
      date: new Date().toISOString(),
      type: 'payment',
      amount: amountPaid,
      notes: notes,
      debtAfter: currentCustomer.debt
    });
  }
  
  localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
  addCashbookTransaction({
      type: 'thu',
      category: 'Thu tiền khách hàng / Trả trước',
      partner: currentCustomer.name,
      value: amountPaid,
      method: 'cash',
      accounting: true,
      note: notes,
      creator: currentUserDisp,
      id: paymentResult.cashbook_id || '',
      cloudId: paymentResult.cashbook_id || null,
      customerId: currentCustomer.id,
      debtImpact: true,
      syncToCloud: false
    });
    closePayDebtModal();
    renderAll();
    const balanceMessage = currentCustomer.debt < 0
      ? ` Khách đang có ${formatCurrency(Math.abs(currentCustomer.debt))} tiền trả trước.`
      : ` Công nợ còn lại ${formatCurrency(currentCustomer.debt)}.`;
    showToast(`Đã nhận ${formatCurrency(amountPaid)} từ khách hàng ${currentCustomer.name}.${balanceMessage}`, 'success');
}

export function openCustomerDebtAdjustModal() {
  if (!['admin', 'accounting'].includes(state.currentUser?.role)) {
    showToast('Chỉ Admin hoặc Kế toán được điều chỉnh công nợ.', 'warning');
    return;
  }

  const editId = document.getElementById('customer-edit-id')?.value;
  const customer = state.customers.find(item => String(item.id) === String(editId));
  const modal = document.getElementById('customer-debt-adjust-modal');
  const form = document.getElementById('customer-debt-adjust-form');
  if (!customer || !modal || !form) return;

  form.reset();
  document.getElementById('customer-debt-adjust-id').value = customer.id;
  document.getElementById('customer-debt-adjust-name').innerText = `${customer.name} (${customer.code})`;
  document.getElementById('customer-debt-adjust-current').innerText = formatCurrency(customer.debt || 0);
  document.getElementById('customer-debt-adjust-value').value = Number(customer.debt || 0);
  modal.classList.add('active');
  document.getElementById('customer-debt-adjust-value').focus();
}

export function closeCustomerDebtAdjustModal() {
  document.getElementById('customer-debt-adjust-modal')?.classList.remove('active');
}

export async function handleCustomerDebtAdjustSubmit(event) {
  event.preventDefault();
  if (!['admin', 'accounting'].includes(state.currentUser?.role)) {
    showToast('Bạn không có quyền điều chỉnh công nợ.', 'danger');
    return;
  }

  const customerId = document.getElementById('customer-debt-adjust-id').value;
  const newDebt = Number(document.getElementById('customer-debt-adjust-value').value);
  const reason = document.getElementById('customer-debt-adjust-reason').value.trim();
  if (!customerId || !Number.isFinite(newDebt)) {
    showToast('Số dư công nợ không hợp lệ.', 'danger');
    return;
  }
  if (reason.length < 3) {
    showToast('Vui lòng nhập lý do điều chỉnh (ít nhất 3 ký tự).', 'warning');
    return;
  }

  const result = await dbAdjustCustomerDebt(customerId, newDebt, reason);
  if (!result?.success) {
    showToast('Không thể điều chỉnh công nợ. Dữ liệu chưa thay đổi.', 'danger');
    return;
  }

  const refreshedFromCloud = Boolean(await dbRefreshCustomerFinancialState(customerId, { includeHistory: false }));
  if (!refreshedFromCloud) {
    const localCustomer = state.customers.find(item => String(item.id) === String(customerId));
    if (localCustomer) localCustomer.debt = Number(result.new_debt);
  }
  const refreshed = state.customers.find(item => String(item.id) === String(customerId));
  if (refreshed) {
    const debtInput = document.getElementById('cust-debt');
    if (debtInput) debtInput.value = Number(refreshed.debt || 0);
  }
  localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
  closeCustomerDebtAdjustModal();
  renderAll();
  const refreshNote = refreshedFromCloud ? '' : ' Hãy tải lại trang để đồng bộ đầy đủ lịch sử.';
  showToast((result.already_at_balance
    ? 'Công nợ đã ở đúng số dư này.'
    : `Đã điều chỉnh công nợ thành ${formatCurrency(newDebt)} và lưu lịch sử.`) + refreshNote, refreshedFromCloud ? 'success' : 'warning');
}

function getAllowedCustomerExportColumns() {
  return CUSTOMER_EXPORT_COLUMNS;
}

function renderCustomerExportColumns() {
  const grid = document.getElementById('customer-export-column-grid');
  if (!grid) return;
  grid.innerHTML = getAllowedCustomerExportColumns().map(column => `
    <label><input type="checkbox" class="customer-list-export-column" value="${column.key}" ${column.default ? 'checked' : ''}> ${escapeCustomerHtml(column.label)}</label>
  `).join('');
}

function getCustomerExportScopeRows(scope) {
  if (scope === 'page') return [...customerCurrentPageRows];
  if (scope === 'selected') return customerFilteredRows.filter(row => selectedCustomerIdsForExport.has(String(row.id)));
  if (scope === 'all') {
    return queryCustomerRows(buildCustomerViewRows(), {
      ...DEFAULT_CUSTOMER_QUERY,
      sortKey: customerViewQuery.sortKey,
      sortDirection: customerViewQuery.sortDirection,
      nulls: customerViewQuery.nulls
    });
  }
  return [...customerFilteredRows];
}

function updateCustomerExportEstimate() {
  const scope = document.getElementById('customer-list-export-scope')?.value || 'filtered';
  const estimate = document.getElementById('customer-export-estimate');
  if (estimate) estimate.textContent = `${getCustomerExportScopeRows(scope).length.toLocaleString('vi-VN')} khách hàng sẽ được xuất theo đúng thứ tự hiện tại.`;
}

function openCustomerListExportModal() {
  const modal = document.getElementById('customer-list-export-modal');
  if (!modal) return;
  renderCustomerExportColumns();
  const scope = document.getElementById('customer-list-export-scope');
  if (scope) scope.value = selectedCustomerIdsForExport.size > 0 ? 'selected' : 'filtered';
  updateCustomerExportEstimate();
  modal.classList.add('active');
  safeCreateIcons();
}

function closeCustomerListExportModal() {
  document.getElementById('customer-list-export-modal')?.classList.remove('active');
}

function customerExportCell(row, key, index) {
  if (key === 'index') return index + 1;
  if (key === 'daysInactive') return row.daysInactive ?? '';
  if (key === 'dueDate') return row.dueDate || '';
  if (key === 'debtStatus') return row.debtStatus || '';
  if (['grossSales', 'totalReturns', 'netSales', 'debt'].includes(key)) return finiteCustomerNumber(row[key]) ?? 0;
  if (key === 'debtDays') return finiteCustomerNumber(row.debtDays) ?? '';
  return row[key] ?? '';
}

function customerExportDate(value) {
  const key = customerDateKey(value);
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) : '';
}

function exportCustomerListExcel() {
  const submit = document.getElementById('btn-submit-customer-list-export');
  if (!globalThis.XLSX) return showToast('Thư viện Excel chưa tải xong. Vui lòng thử lại.', 'danger');
  const scope = document.getElementById('customer-list-export-scope')?.value || 'filtered';
  const keys = [...document.querySelectorAll('.customer-list-export-column:checked')].map(input => input.value);
  const columns = getAllowedCustomerExportColumns().filter(column => keys.includes(column.key));
  const rows = getCustomerExportScopeRows(scope);
  if (columns.length === 0) return showToast('Hãy chọn ít nhất một cột để xuất.', 'warning');
  if (rows.length === 0) return showToast('Không có khách hàng trong phạm vi xuất.', 'warning');

  try {
    if (submit) { submit.disabled = true; submit.textContent = 'Đang chuẩn bị file...'; }
    const matrix = [columns.map(column => column.label)];
    rows.forEach((row, index) => matrix.push(columns.map(column => {
      const value = customerExportCell(row, column.key, index);
      return column.date && value ? customerExportDate(value) : value;
    })));
    const totalRowIndex = matrix.length;
    matrix.push(columns.map((column, index) => index === 0
      ? 'TỔNG CỘNG'
      : (column.money ? rows.reduce((sum, row) => sum + (finiteCustomerNumber(row[column.key]) ?? 0), 0) : '')));

    const sheet = XLSX.utils.aoa_to_sheet(matrix, { cellDates: true });
    const lastColumn = XLSX.utils.encode_col(columns.length - 1);
    sheet['!autofilter'] = { ref: `A1:${lastColumn}${rows.length + 1}` };
    sheet['!freeze'] = { xSplit: 0, ySplit: 1, topLeftCell: 'A2', activePane: 'bottomLeft', state: 'frozen' };
    sheet['!cols'] = columns.map(column => ({ wch: column.key === 'address' || column.key === 'notes' ? 34 : (column.date ? 14 : 18) }));
    columns.forEach((column, columnIndex) => {
      for (let rowIndex = 1; rowIndex <= rows.length; rowIndex++) {
        const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
        if (!cell) continue;
        if (column.text) { cell.t = 's'; cell.z = '@'; cell.v = String(cell.v ?? ''); }
        if (column.date && cell.v) cell.z = 'dd/mm/yyyy';
        if (column.money) cell.z = '#,##0;[Red]-#,##0';
      }
      const totalCell = sheet[XLSX.utils.encode_cell({ r: totalRowIndex, c: columnIndex })];
      if (totalCell && column.money) totalCell.z = '#,##0;[Red]-#,##0';
      const header = sheet[XLSX.utils.encode_cell({ r: 0, c: columnIndex })];
      if (header) header.s = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { fgColor: { rgb: '166534' } }, alignment: { horizontal: 'center' } };
      if (totalCell) totalCell.s = { font: { bold: true }, fill: { fgColor: { rgb: 'DCFCE7' } } };
    });

    const appliedFilters = Object.fromEntries(Object.entries(customerViewQuery)
      .filter(([key, value]) => !['q', 'sortKey', 'sortDirection', 'pageSize'].includes(key) && (Array.isArray(value) ? value.length : value)));
    const queryInfo = [
      ['Thông tin', 'Giá trị'], ['Thời gian xuất', new Date()], ['Người xuất', state.currentUser?.displayName || state.currentUser?.username || ''],
      ['Phạm vi', scope], ['Từ khóa', customerViewQuery.q || ''], ['Sắp xếp', `${customerViewQuery.sortKey} (${customerViewQuery.sortDirection})`],
      ['Bộ lọc', JSON.stringify(appliedFilters)], ['Số khách hàng', rows.length]
    ];
    const infoSheet = XLSX.utils.aoa_to_sheet(queryInfo, { cellDates: true });
    if (infoSheet.B2) infoSheet.B2.z = 'dd/mm/yyyy hh:mm:ss';
    infoSheet['!cols'] = [{ wch: 22 }, { wch: 70 }];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'DanhSachKhachHang');
    XLSX.utils.book_append_sheet(workbook, infoSheet, 'ThongTinBoLoc');
    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
    XLSX.writeFile(workbook, `DanhSachKhachHang_${stamp}.xlsx`, { cellStyles: true });
    closeCustomerListExportModal();
    showToast(`Đã xuất ${rows.length.toLocaleString('vi-VN')} khách hàng.`, 'success');
  } catch (error) {
    console.error('Customer list export failed:', error);
    showToast(`Không thể xuất danh sách khách hàng: ${error.message}`, 'danger');
  } finally {
    if (submit) { submit.disabled = false; submit.innerHTML = '<i data-lucide="file-spreadsheet"></i> Xuất Excel'; }
    safeCreateIcons();
  }
}

export function setupCustomerManagement() {
  restoreCustomerQueryFromUrl();
  syncCustomerQueryControls();
  const searchInput = document.getElementById('customer-search-input');
  if (searchInput) searchInput.addEventListener('input', () => {
    clearTimeout(customerSearchDebounce);
    customerSearchDebounce = setTimeout(() => applyCustomerQueryChange(), 350);
  });

  const sortKey = document.getElementById('customer-sort-key');
  if (sortKey) sortKey.addEventListener('change', () => applyCustomerQueryChange());
  const sortDirection = document.getElementById('btn-customer-sort-direction');
  if (sortDirection) sortDirection.addEventListener('click', () => {
    customerViewQuery.sortDirection = customerViewQuery.sortDirection === 'asc' ? 'desc' : 'asc';
    syncCustomerQueryControls();
    applyCustomerQueryChange();
  });
  const pageSize = document.getElementById('customer-page-size');
  if (pageSize) pageSize.addEventListener('change', () => applyCustomerQueryChange({ clearSelection: false }));
  const employeeFilter = document.getElementById('customer-managed-filter');
  if (employeeFilter) employeeFilter.addEventListener('change', () => {
    const managerFilter = document.getElementById('customer-filter-managers');
    const managerState = document.getElementById('customer-manager-state');
    const pricelistState = document.getElementById('customer-pricelist-state');
    const isNamedManager = employeeFilter.value && !['unassigned', 'unassigned_pricelist'].includes(employeeFilter.value);
    if (managerFilter) [...managerFilter.options].forEach(option => { option.selected = isNamedManager && option.value === employeeFilter.value; });
    if (managerState) managerState.value = employeeFilter.value === 'unassigned' ? 'missing' : '';
    if (pricelistState) pricelistState.value = employeeFilter.value === 'unassigned_pricelist' ? 'missing' : '';
    applyCustomerQueryChange();
  });
  const filterButton = document.getElementById('btn-customer-advanced-filter');
  const filterPanel = document.getElementById('customer-advanced-filter-panel');
  const filterBackdrop = document.getElementById('customer-filter-drawer-backdrop');
  // A fixed element inside .glass-panel is positioned against that panel
  // because backdrop-filter creates a containing block. Portal both elements
  // to <body> so the popup is centered and clipped against the viewport only.
  if (filterBackdrop?.parentElement !== document.body) document.body.appendChild(filterBackdrop);
  if (filterPanel?.parentElement !== document.body) document.body.appendChild(filterPanel);
  const closeFilterButton = document.getElementById('btn-close-customer-filter');
  const setFilterDrawerOpen = (open) => {
    if (!filterPanel || !filterButton) return;
    filterPanel.classList.toggle('active', open);
    filterBackdrop?.classList.toggle('active', open);
    filterPanel.setAttribute('aria-hidden', String(!open));
    filterBackdrop?.setAttribute('aria-hidden', String(!open));
    filterButton.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('customer-filter-drawer-open', open);
    if (open) closeFilterButton?.focus();
    else filterButton.focus();
  };
  if (filterButton && filterPanel) filterButton.addEventListener('click', () => setFilterDrawerOpen(!filterPanel.classList.contains('active')));
  closeFilterButton?.addEventListener('click', () => setFilterDrawerOpen(false));
  filterBackdrop?.addEventListener('click', () => setFilterDrawerOpen(false));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && filterPanel?.classList.contains('active')) setFilterDrawerOpen(false);
  });
  Object.values(CUSTOMER_QUERY_CONTROL_MAP).forEach(id => {
    const control = document.getElementById(id);
    if (control) control.addEventListener('change', () => applyCustomerQueryChange());
  });
  const resetQuery = document.getElementById('btn-reset-customer-query');
  if (resetQuery) resetQuery.addEventListener('click', () => {
    customerViewQuery = { ...DEFAULT_CUSTOMER_QUERY };
    state.customersPage = 1;
    selectedCustomerIdsForExport.clear();
    syncCustomerQueryControls();
    writeCustomerQueryToUrl();
    renderCustomersTable();
  });
  document.getElementById('btn-reset-customer-filter-modal')?.addEventListener('click', () => resetQuery?.click());
  document.getElementById('btn-apply-customer-filter-modal')?.addEventListener('click', () => setFilterDrawerOpen(false));
  const clearSelection = document.getElementById('btn-clear-customer-selection');
  if (clearSelection) clearSelection.addEventListener('click', () => {
    selectedCustomerIdsForExport.clear();
    renderCustomersTable();
  });
  const openListExport = document.getElementById('btn-export-customers-excel');
  const closeListExport = document.getElementById('btn-close-customer-list-export');
  const cancelListExport = document.getElementById('btn-cancel-customer-list-export');
  const submitListExport = document.getElementById('btn-submit-customer-list-export');
  const exportScope = document.getElementById('customer-list-export-scope');
  if (openListExport) openListExport.addEventListener('click', openCustomerListExportModal);
  if (closeListExport) closeListExport.addEventListener('click', closeCustomerListExportModal);
  if (cancelListExport) cancelListExport.addEventListener('click', closeCustomerListExportModal);
  if (submitListExport) submitListExport.addEventListener('click', exportCustomerListExcel);
  if (exportScope) exportScope.addEventListener('change', updateCustomerExportEstimate);
  const selectAllExportColumns = document.getElementById('btn-customer-export-all-columns');
  const clearExportColumns = document.getElementById('btn-customer-export-no-columns');
  const defaultExportColumns = document.getElementById('btn-customer-export-default-columns');
  if (selectAllExportColumns) selectAllExportColumns.addEventListener('click', () => document.querySelectorAll('.customer-list-export-column').forEach(input => { input.checked = true; }));
  if (clearExportColumns) clearExportColumns.addEventListener('click', () => document.querySelectorAll('.customer-list-export-column').forEach(input => { input.checked = false; }));
  if (defaultExportColumns) defaultExportColumns.addEventListener('click', renderCustomerExportColumns);

  setupCustomerColumnPicker();

  const addBtn = document.getElementById('btn-open-add-customer-modal');
  if (addBtn) addBtn.addEventListener('click', () => openCustomerModal());

  const closeBtn = document.getElementById('btn-close-customer-modal');
  if (closeBtn) closeBtn.addEventListener('click', closeCustomerModal);

  const cancelBtn = document.getElementById('btn-cancel-customer');
  if (cancelBtn) cancelBtn.addEventListener('click', closeCustomerModal);

  const customerForm = document.getElementById('customer-form');
  if (customerForm) {
    customerForm.addEventListener('submit', (e) => {
      e.preventDefault();
      saveCustomer();
    });
    ['cust-code', 'cust-name', 'cust-phone', 'cust-province', 'cust-pricelist'].forEach(id => {
      const field = document.getElementById(id);
      field?.addEventListener(field.tagName === 'SELECT' ? 'change' : 'input', () => clearCustomerFieldError(field));
    });
  }

  const provinceSelect = document.getElementById('cust-province');
  if (provinceSelect) {
    // Populate dynamically with all 63 provinces
    provinceSelect.innerHTML = `
      <option value="">-- Chọn Tỉnh/Thành --</option>
      ${Object.entries(PROVINCES).map(([code, name]) => {
        if (code === 'OTHER') return '';
        return `<option value="${code}">${name}</option>`;
      }).join('')}
      <option value="OTHER">Khác</option>
    `;

    provinceSelect.addEventListener('change', () => {
      const editIndex = document.getElementById('customer-edit-index').value;
      if (editIndex === '-1') {
        const pCode = provinceSelect.value;
        const codeInput = document.getElementById('cust-code');
        if (codeInput) {
          codeInput.value = generateUniqueCustomerCode(pCode);
        }
      }
    });

    makeSelectSearchable('cust-province', '-- Chọn Tỉnh/Thành --');
  }
  
  makeSelectSearchable('cust-assigned-brand', 'Chọn nhãn sơn', false);

  const closePayDebtBtn = document.getElementById('btn-close-pay-debt-modal');
  const cancelPayDebtBtn = document.getElementById('btn-cancel-pay-debt');
  const payDebtForm = document.getElementById('pay-debt-form');

  if (closePayDebtBtn) closePayDebtBtn.addEventListener('click', closePayDebtModal);
  if (cancelPayDebtBtn) cancelPayDebtBtn.addEventListener('click', closePayDebtModal);
  if (payDebtForm) {
    payDebtForm.addEventListener('submit', handlePayDebtSubmit);
  }

  const openDebtAdjustBtn = document.getElementById('btn-open-customer-debt-adjust');
  const closeDebtAdjustBtn = document.getElementById('btn-close-customer-debt-adjust');
  const cancelDebtAdjustBtn = document.getElementById('btn-cancel-customer-debt-adjust');
  const debtAdjustForm = document.getElementById('customer-debt-adjust-form');
  if (openDebtAdjustBtn) openDebtAdjustBtn.addEventListener('click', openCustomerDebtAdjustModal);
  if (closeDebtAdjustBtn) closeDebtAdjustBtn.addEventListener('click', closeCustomerDebtAdjustModal);
  if (cancelDebtAdjustBtn) cancelDebtAdjustBtn.addEventListener('click', closeCustomerDebtAdjustModal);
  if (debtAdjustForm) debtAdjustForm.addEventListener('submit', handleCustomerDebtAdjustSubmit);

  // Thay đổi hiển thị phần trăm chiết khấu hãng sơn theo bảng giá
  const custPricelistSelect = document.getElementById('cust-pricelist');
  if (custPricelistSelect) {
    custPricelistSelect.addEventListener('change', () => {
      const discSection = document.getElementById('cust-brand-discounts-section');
      if (discSection) {
        discSection.style.display = custPricelistSelect.value === 'custom' ? 'block' : 'none';
      }
    });
  }

  // Sự kiện đóng modal chi tiết công nợ
  const closeDetailBtn = document.getElementById('btn-close-customer-detail-modal');
  const closeDetailFooterBtn = document.getElementById('btn-close-customer-detail-modal-footer');
  if (closeDetailBtn) closeDetailBtn.addEventListener('click', closeCustomerDetailModal);
  if (closeDetailFooterBtn) closeDetailFooterBtn.addEventListener('click', closeCustomerDetailModal);

  const closeDebtSourceModal = () => {
    document.getElementById('customer-debt-source-modal')?.classList.remove('active');
  };
  document.getElementById('btn-close-customer-debt-source')?.addEventListener('click', closeDebtSourceModal);
  document.getElementById('btn-close-customer-debt-source-footer')?.addEventListener('click', closeDebtSourceModal);

  const openOrderExportBtn = document.getElementById('btn-open-customer-order-export');
  const closeOrderExportBtn = document.getElementById('btn-close-customer-order-export-modal');
  const cancelOrderExportBtn = document.getElementById('btn-cancel-customer-order-export');
  const submitOrderExportBtn = document.getElementById('btn-submit-customer-order-export');
  const openBulkOrderExportBtn = document.getElementById('btn-open-customer-history-export-modal');
  const rangeModeSelect = document.getElementById('customer-order-export-range-mode');
  const selectAllColumnsBtn = document.getElementById('btn-customer-order-export-select-all-columns');
  const clearColumnsBtn = document.getElementById('btn-customer-order-export-clear-columns');
  if (openBulkOrderExportBtn) {
    openBulkOrderExportBtn.addEventListener('click', () => openCustomerOrderExportModal(null));
  }
  if (openOrderExportBtn) {
    openOrderExportBtn.addEventListener('click', () => {
      openCustomerOrderExportModal(openOrderExportBtn.getAttribute('data-customer-id'));
    });
  }
  if (closeOrderExportBtn) closeOrderExportBtn.addEventListener('click', closeCustomerOrderExportModal);
  if (cancelOrderExportBtn) cancelOrderExportBtn.addEventListener('click', closeCustomerOrderExportModal);
  if (submitOrderExportBtn) submitOrderExportBtn.addEventListener('click', exportCustomerOrderHistoryExcel);
  if (rangeModeSelect) {
    rangeModeSelect.addEventListener('change', () => {
      const customBox = document.getElementById('customer-order-export-custom-range');
      if (customBox) customBox.style.display = rangeModeSelect.value === 'custom' ? 'grid' : 'none';
      const range = getCustomerOrderExportDateRange();
      const fromInput = document.getElementById('customer-order-export-from');
      const toInput = document.getElementById('customer-order-export-to');
      if (fromInput && range.fromDate) fromInput.value = range.fromDate;
      if (toInput && range.toDate) toInput.value = range.toDate;
    });
  }
  if (selectAllColumnsBtn) {
    selectAllColumnsBtn.addEventListener('click', () => {
      document.querySelectorAll('.customer-order-export-column').forEach(input => { input.checked = true; });
    });
  }
  if (clearColumnsBtn) {
    clearColumnsBtn.addEventListener('click', () => {
      document.querySelectorAll('.customer-order-export-column').forEach(input => { input.checked = false; });
    });
  }

  // Customer Excel Import Listeners
  const openImportBtn = document.getElementById('btn-open-cust-excel-modal');
  if (openImportBtn) openImportBtn.onclick = openCustExcelModal;
  
  const closeImportBtn = document.getElementById('btn-close-cust-excel-modal');
  if (closeImportBtn) closeImportBtn.onclick = closeCustExcelModal;
  
  const cancelImportBtn = document.getElementById('btn-cancel-cust-excel');
  if (cancelImportBtn) cancelImportBtn.onclick = closeCustExcelModal;
  
  const fileInput = document.getElementById('cust-excel-file-input');
  const browseBtn = document.getElementById('btn-browse-cust-excel');
  const dropzone = document.getElementById('cust-excel-dropzone');
  
  if (browseBtn && fileInput) {
    browseBtn.onclick = (e) => {
      e.stopPropagation();
      if (isSelectingFile) return;
      isSelectingFile = true;
      fileInput.click();
    };
  }
  if (dropzone && fileInput) {
    dropzone.onclick = (e) => {
      // Tránh kích hoạt click 2 lần khi nhấp trúng nút browseBtn hoặc bản thân fileInput
      if (e.target === browseBtn || browseBtn.contains(e.target) || e.target === fileInput) {
        return;
      }
      e.stopPropagation();
      if (isSelectingFile) return;
      isSelectingFile = true;
      fileInput.click();
    };
  }
  if (fileInput) {
    fileInput.onclick = (e) => {
      e.stopPropagation();
    };
    
    const resetLock = () => {
      isSelectingFile = false;
    };
    
    fileInput.onchange = (e) => {
      resetLock();
      if (e.target.files.length > 0) {
        handleCustExcelFile(e.target.files[0]);
      }
    };
    fileInput.oncancel = resetLock;
  }
  
  if (dropzone) {
    dropzone.ondragover = (e) => {
      e.preventDefault();
      dropzone.classList.add('dragover');
    };
    dropzone.ondragleave = () => {
      dropzone.classList.remove('dragover');
    };
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        handleCustExcelFile(e.dataTransfer.files[0]);
      }
    };
  }
  
  const downloadTemplateBtn = document.getElementById('btn-download-cust-excel-template');
  if (downloadTemplateBtn) {
    downloadTemplateBtn.onclick = (e) => {
      e.stopPropagation();
      downloadCustomerExcelTemplate();
    };
  }

  const submitImportBtn = document.getElementById('btn-save-cust-excel-submit');
  if (submitImportBtn) {
    submitImportBtn.onclick = processCustomerExcelImport;
  }
}

export function downloadCustomerExcelTemplate() {
  const sampleData = [
    {
      "Mã khách hàng": "BG01-HN-001",
      "Tên khách hàng": "Đại lý Sơn Tuấn Anh",
      "Điện thoại": "0987654321",
      "Địa chỉ": "Số 12 Phố Vọng, Phường Phương Mai, Quận Đống Đa, Hà Nội",
      "Nhãn sơn": "Nano10*",
      "Bảng giá": "Bảng giá BG01",
      "Người quản lý": "Nguyễn Thanh Thụy",
      "Tổng doanh số": 85000000,
      "Tổng giá trị trả hàng": 5000000,
      "Doanh số sau trả": 80000000,
      "Công nợ hiện tại": 15000000,
      "Ngày giao dịch cuối": new Date(2026, 6, 25),
      "Ngày tạo": new Date(2024, 2, 15),
      "Số ngày nợ": 5
    },
    {
      "Mã khách hàng": "BG02-HP-002",
      "Tên khách hàng": "Cửa hàng Vật Tư Minh Đức",
      "Điện thoại": "0912345678",
      "Địa chỉ": "45 Đường Lạch Tray, Quận Ngô Quyền, Hải Phòng",
      "Nhãn sơn": "Hatacco nano",
      "Bảng giá": "Bảng giá đại lý cấp 1",
      "Người quản lý": "Dương Như Hoàn",
      "Tổng doanh số": 42000000,
      "Tổng giá trị trả hàng": 0,
      "Doanh số sau trả": 42000000,
      "Công nợ hiện tại": 0,
      "Ngày giao dịch cuối": new Date(2026, 6, 20),
      "Ngày tạo": new Date(2024, 4, 10),
      "Số ngày nợ": 0
    },
    {
      "Mã khách hàng": "BG03-DN-003",
      "Tên khách hàng": "Đại lý Sơn & Hóa Chất Hoàng Long",
      "Điện thoại": "0905123456",
      "Địa chỉ": "78 Đường Nguyễn Văn Linh, Quận Thanh Khê, Đà Nẵng",
      "Nhãn sơn": "mutsutec",
      "Bảng giá": "Chiết khấu riêng",
      "Người quản lý": "ctyabs@lendon.com",
      "Tổng doanh số": 120000000,
      "Tổng giá trị trả hàng": 10000000,
      "Doanh số sau trả": 110000000,
      "Công nợ hiện tại": 5500000,
      "Ngày giao dịch cuối": new Date(2026, 6, 12),
      "Ngày tạo": new Date(2023, 10, 2),
      "Số ngày nợ": 18
    },
    {
      "Mã khách hàng": "BG04-TH-004",
      "Tên khách hàng": "NPP Anh Chung Thanh Hóa",
      "Điện thoại": "0943218765",
      "Địa chỉ": "156 Đường Lê Lai, Phường Đông Sơn, TP Thanh Hóa, Thanh Hóa",
      "Nhãn sơn": "Tất cả",
      "Bảng giá": "Bảng giá 04",
      "Người quản lý": "Trần Văn Nhất",
      "Tổng doanh số": 65000000,
      "Tổng giá trị trả hàng": 2000000,
      "Doanh số sau trả": 63000000,
      "Công nợ hiện tại": 2550000,
      "Ngày giao dịch cuối": new Date(2026, 6, 8),
      "Ngày tạo": new Date(2024, 7, 21),
      "Số ngày nợ": 22
    },
    {
      "Mã khách hàng": "BG05-BD-005",
      "Tên khách hàng": "Công Ty TNHH XD Sơn Nam Dương",
      "Điện thoại": "0978112233",
      "Địa chỉ": "89 Đại Lộ Bình Dương, Phường Phú Hòa, TP Thủ Dầu Một, Bình Dương",
      "Nhãn sơn": "tdkaw",
      "Bảng giá": "Chiết khấu riêng",
      "Người quản lý": "Dương Như Hoàn",
      "Tổng doanh số": 195000000,
      "Tổng giá trị trả hàng": 0,
      "Doanh số sau trả": 195000000,
      "Công nợ hiện tại": 0,
      "Ngày giao dịch cuối": new Date(2026, 6, 1),
      "Ngày tạo": new Date(2025, 0, 8),
      "Số ngày nợ": 0
    }
  ];

  const worksheet = XLSX.utils.json_to_sheet(sampleData);
  worksheet['!cols'] = [
    { wch: 18 }, // Mã khách hàng
    { wch: 38 }, // Tên khách hàng
    { wch: 16 }, // Điện thoại
    { wch: 55 }, // Địa chỉ
    { wch: 18 }, // Nhãn sơn
    { wch: 25 }, // Bảng giá
    { wch: 25 }, // Người quản lý
    { wch: 18 }, // Tổng doanh số
    { wch: 22 }, // Tổng giá trị trả hàng
    { wch: 20 }, // Doanh số sau trả
    { wch: 20 }, // Công nợ hiện tại
    { wch: 20 }, // Ngày giao dịch cuối
    { wch: 16 }, // Ngày tạo
    { wch: 14 }  // Số ngày nợ
  ];

  for (let row = 2; row <= sampleData.length + 1; row++) {
    if (worksheet[`L${row}`]) worksheet[`L${row}`].z = 'yyyy-mm-dd';
    if (worksheet[`M${row}`]) worksheet[`M${row}`].z = 'yyyy-mm-dd';
    if (worksheet[`N${row}`]) worksheet[`N${row}`].z = '0';
  }

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, "DanhSachKhachHang");
  XLSX.writeFile(workbook, "Mau_Nhap_Danh_Sach_Khach_Hang.xlsx");
}




// --- Logic hiển thị chi tiết đại lý và lịch sử công nợ ---
const CUSTOMER_ORDER_EXPORT_COLUMNS = [
  'Mã hóa đơn', 'Thời gian', 'Ngày cập nhật', 'Mã trả hàng',
  'Mã khách hàng', 'Tên khách hàng', 'Điện thoại', 'Địa chỉ (Khách hàng)',
  'Khu vực (Khách hàng)', 'Bảng giá', 'Kinh doanh quản lý',
  'Người bán', 'Người tạo', 'Ghi chú', 'Tổng tiền hàng', 'Tổng giảm giá',
  'Tổng sau giảm giá', 'Phí vận chuyển', 'Khách cọc', 'Còn phải thu',
  'Trạng thái', 'Mã hàng', 'Tên hàng', 'Thương hiệu', 'Quy cách', 'ĐVT',
  'Ghi chú hàng hóa', 'Số lượng', 'Đơn giá',
  'Giảm giá %', 'Giảm giá', 'Giá bán', 'Thành tiền'
];

const CUSTOMER_ORDER_EXPORT_COLUMN_GROUPS = [
  { title: 'Thông tin hóa đơn', columns: ['Mã hóa đơn', 'Thời gian', 'Ngày cập nhật', 'Mã trả hàng', 'Trạng thái', 'Người bán', 'Người tạo', 'Ghi chú'] },
  { title: 'Thông tin khách hàng', columns: ['Mã khách hàng', 'Tên khách hàng', 'Điện thoại', 'Địa chỉ', 'Khu vực', 'Bảng giá', 'Kinh doanh quản lý'] },
  { title: 'Thông tin thanh toán', columns: ['Tổng tiền hàng', 'Tổng giảm giá', 'Tổng sau giảm giá', 'Phí vận chuyển', 'Khách cọc', 'Còn phải thu'] },
  { title: 'Thông tin sản phẩm', columns: ['Mã hàng', 'Tên hàng', 'Thương hiệu/Nhãn sơn', 'Quy cách', 'Đơn vị tính', 'Ghi chú hàng hóa', 'Số lượng', 'Đơn giá', 'Giảm giá %', 'Giảm giá', 'Giá bán', 'Thành tiền'] }
];

const DEFAULT_CUSTOMER_ORDER_EXPORT_COLUMNS = CUSTOMER_ORDER_EXPORT_COLUMN_GROUPS.flatMap(g => g.columns);
const CUSTOMER_ORDER_EXPORT_COLUMNS_STORAGE_KEY = 'billing_system_customer_order_export_columns';

let activeExportCustomerId = null;
let activeExportScopeMode = 'filtered';

function toExportNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : value;
  const num = Number(normalized);
  return Number.isFinite(num) ? num : fallback;
}

function formatExportDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(date).replace(',', '');
}

function getVnDateInputValue(offsetDays = 0) {
  const now = new Date();
  now.setDate(now.getDate() + offsetDays);
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function getVnRangeIso(startDate, endDate) {
  const start = new Date(`${startDate}T00:00:00+07:00`);
  const endExclusive = new Date(`${endDate}T00:00:00+07:00`);
  endExclusive.setDate(endExclusive.getDate() + 1);
  return { startIso: start.toISOString(), endExclusiveIso: endExclusive.toISOString() };
}

function sanitizeFilePart(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 80) || 'KhachHang';
}

function getDisplayUserName(username) {
  if (!username) return '';
  const found = (state.users || []).find(u => isSameUser(u.username, username));
  return found ? (found.displayName || found.name || found.username) : username;
}

function getPricelistName(id) {
  if (!id) return '';
  if (id === 'retail') return 'Khách lẻ';
  if (id === 'custom') return 'Chiết khấu riêng';
  const found = (state.pricelists || []).find(p => String(p.id) === String(id));
  return found ? found.name : id;
}

function getOrderReturnCodes(orderId) {
  return (state.salesReturns || [])
    .filter(r => String(r.saleId || r.orderId || '') === String(orderId))
    .filter(r => !['cancelled', 'canceled', 'draft'].includes(String(r.status || 'completed').toLowerCase()))
    .map(r => r.id)
    .filter(Boolean)
    .join(', ');
}

function getLineAmount(item) {
  const qty = toExportNumber(item.quantity);
  const unitPrice = toExportNumber(item.price ?? item.unitPrice ?? item.listPrice);
  const discountPercent = toExportNumber(item.discountPercent ?? item.discount);
  if (item.subtotal !== undefined && item.subtotal !== null && item.subtotal !== '') return toExportNumber(item.subtotal);
  if (item.total !== undefined && item.total !== null && item.total !== '') return toExportNumber(item.total);
  if (item.lineTotal !== undefined && item.lineTotal !== null && item.lineTotal !== '') return toExportNumber(item.lineTotal);
  return Math.round(qty * unitPrice * (1 - discountPercent / 100));
}

function buildCustomerOrderExportRows(orders, customer) {
  const provinceName = getProvinceNameByCode(customer.brandDiscounts && customer.brandDiscounts.province);
  return orders.flatMap(order => {
    // Keep the order visible in Excel even when an old/guest order has no
    // hydrated item rows. Product columns remain blank for that one row.
    const items = Array.isArray(order.items) && order.items.length > 0 ? order.items : [{}];
    const financials = getOrderFinancialBreakdown(order, state.salesReturns || []);
    return items.map(item => {
      const qty = toExportNumber(item.quantity);
      const unitPrice = toExportNumber(item.price ?? item.unitPrice ?? item.listPrice);
      const discountPercent = toExportNumber(item.discountPercent ?? item.discount);
      const lineAmount = getLineAmount(item);
      const lineDiscount = toExportNumber(item.discountAmount, Math.max(0, Math.round(qty * unitPrice - lineAmount)));
      const salePrice = qty > 0 ? Math.round(lineAmount / qty) : unitPrice;
      return {
        'Mã hóa đơn': order.id || '',
        'Thời gian': formatExportDateTime(order.date || order.orderDate || order.createdAt),
        'Ngày cập nhật': formatExportDateTime(order.updatedAt || order.createdAt || order.date),
        'Mã trả hàng': getOrderReturnCodes(order.id),
        'Mã khách hàng': customer.code || customer.id || '',
        'Tên khách hàng': customer.name || order.customerName || '',
        'Điện thoại': customer.phone || order.customerPhone || '',
        'Địa chỉ (Khách hàng)': customer.address || order.customerAddress || '',
        'Địa chỉ': customer.address || order.customerAddress || '',
        'Khu vực (Khách hàng)': provinceName || '',
        'Khu vực': provinceName || '',
        'Bảng giá': getPricelistName(order.pricelistId || customer.pricelistId),
        'Kinh doanh quản lý': getDisplayUserName(customer.managedBy || customer.managed_by),
        'Người bán': getDisplayUserName(order.salespersonId || order.createdBy),
        'Người tạo': getDisplayUserName(order.createdBy),
        'Ghi chú': order.notes || '',
        'Tổng tiền hàng': financials.totalBeforeDiscount,
        'Tổng giảm giá': financials.totalDiscountAmount,
        'Tổng sau giảm giá': financials.totalAfterDiscount,
        'Phí vận chuyển': toExportNumber(order.shippingFeeAmount ?? order.shipping_fee_amount),
        'Khách cọc': toExportNumber(order.paidAmount ?? order.paid_amount ?? order.otherFeeAmount ?? order.other_fee_amount),
        'Còn phải thu': toExportNumber(order.amountDue ?? order.debtAmount ?? order.debt_amount, Math.max(
          0,
          financials.totalAfterDiscount +
          toExportNumber(order.shippingFeeAmount ?? order.shipping_fee_amount) -
          toExportNumber(order.paidAmount ?? order.paid_amount ?? order.otherFeeAmount ?? order.other_fee_amount)
        )),
        'Trạng thái': getOrderStatusLabel(order.status || 'settled'),
        'Mã hàng': item.variantCode || item.productCode || item.code || item.variantId || item.productId || '',
        'Tên hàng': item.productName || item.name || item.product?.name || '',
        'Thương hiệu': item.productBrand || item.brand || '',
        'Thương hiệu/Nhãn sơn': item.productBrand || item.brand || '',
        'Quy cách': item.specificationSnapshot || item.weightOrVolumeSnapshot || item.displaySpecification || [
          item.packagingName || item.packageType || item.package,
          item.weightOrVolume || item.packageWeight,
          item.unitName || item.packageWeightUnit
        ].filter(value => value !== null && value !== undefined && value !== '').join(' '),
        'ĐVT': item.unitName || item.unit || item.packagingName || item.packageType || item.package || '',
        'Đơn vị tính': item.unitName || item.unit || item.packagingName || item.packageType || item.package || '',
        'Ghi chú hàng hóa': item.note || item.notes || '',
        'Số lượng': qty,
        'Đơn giá': unitPrice,
        'Giảm giá %': discountPercent,
        'Giảm giá': lineDiscount,
        'Giá bán': salePrice,
        'Thành tiền': lineAmount
      };
    });
  });
}

const HISTORY_ORDER_ITEM_EXPORT_COLUMNS = [
  'Mã hàng', 'Tên hàng', 'Thương hiệu', 'Thương hiệu/Nhãn sơn',
  'Quy cách', 'ĐVT', 'Đơn vị tính', 'Ghi chú hàng hóa', 'Số lượng',
  'Đơn giá', 'Giảm giá %', 'Giảm giá', 'Giá bán', 'Thành tiền'
];

function buildHistoryOrderExportRow(order, customer) {
  const detailRows = buildCustomerOrderExportRows([order], customer);
  if (detailRows.length === 0) return null;
  if (detailRows.length === 1) return detailRows[0];

  // The history screen promises an order list, so keep exactly one Excel row
  // per order and combine its product values inside the corresponding cells.
  const orderRow = { ...detailRows[0] };
  HISTORY_ORDER_ITEM_EXPORT_COLUMNS.forEach(column => {
    orderRow[column] = detailRows
      .map(row => row[column] ?? '')
      .join('\n');
  });
  return orderRow;
}

function getSavedCustomerOrderExportColumns() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOMER_ORDER_EXPORT_COLUMNS_STORAGE_KEY) || '[]');
    const allowed = new Set(DEFAULT_CUSTOMER_ORDER_EXPORT_COLUMNS);
    const valid = parsed.filter(col => allowed.has(col));
    return valid.length > 0 ? valid : DEFAULT_CUSTOMER_ORDER_EXPORT_COLUMNS;
  } catch (e) {
    return DEFAULT_CUSTOMER_ORDER_EXPORT_COLUMNS;
  }
}

function renderCustomerOrderExportColumnOptions() {
  const container = document.getElementById('customer-order-export-columns');
  if (!container) return;
  const selected = new Set(getSavedCustomerOrderExportColumns());
  container.innerHTML = CUSTOMER_ORDER_EXPORT_COLUMN_GROUPS.map(group => `
    <div style="border: 1px solid var(--border-color); border-radius: 8px; padding: 0.75rem;">
      <div style="font-weight: 600; color: #fff; margin-bottom: 0.5rem;">${group.title}</div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.45rem;">
        ${group.columns.map(col => `
          <label style="display: flex; gap: 0.4rem; align-items: center; font-size: 0.82rem; color: var(--text-secondary);">
            <input type="checkbox" class="customer-order-export-column" value="${col}" ${selected.has(col) ? 'checked' : ''}>
            <span>${col}</span>
          </label>
        `).join('')}
      </div>
    </div>
  `).join('');
}

function getSelectedCustomerOrderExportColumns() {
  return Array.from(document.querySelectorAll('.customer-order-export-column:checked')).map(input => input.value);
}

function getCustomerOrderExportDateRange() {
  const mode = document.getElementById('customer-order-export-range-mode')?.value || 'last_month';
  const today = getVnDateInputValue(0);
  const todayParts = today.split('-').map(Number);
  if (mode === 'current_filter') {
    const fromDate = document.getElementById('customer-order-export-from')?.value;
    const toDate = document.getElementById('customer-order-export-to')?.value;
    return { fromDate, toDate, label: 'BoLocLichSuDon' };
  }
  if (mode === 'today') return { fromDate: today, toDate: today, label: 'HomNay' };
  if (mode === 'this_month') {
    const fromDate = `${todayParts[0]}-${String(todayParts[1]).padStart(2, '0')}-01`;
    return { fromDate, toDate: today, label: 'ThangNay' };
  }
  if (mode === 'custom') {
    const fromDate = document.getElementById('customer-order-export-from')?.value;
    const toDate = document.getElementById('customer-order-export-to')?.value;
    return { fromDate, toDate, label: `${fromDate}-${toDate}` };
  }
  const firstThisMonth = new Date(`${todayParts[0]}-${String(todayParts[1]).padStart(2, '0')}-01T00:00:00+07:00`);
  const lastPrevMonth = new Date(firstThisMonth);
  lastPrevMonth.setDate(0);
  const prevParts = getVnDateInputValueFromDate(lastPrevMonth).split('-').map(Number);
  return {
    fromDate: `${prevParts[0]}-${String(prevParts[1]).padStart(2, '0')}-01`,
    toDate: getVnDateInputValueFromDate(lastPrevMonth),
    label: 'ThangTruoc'
  };
}

function getVnDateInputValueFromDate(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function getExportCustomersByScope() {
  if (activeExportCustomerId) {
    return (state.customers || []).filter(c => String(c.id) === String(activeExportCustomerId));
  }
  const filtered = getFilteredCustomersForCurrentView();
  if (selectedCustomerIdsForExport.size > 0) {
    return filtered.filter(c => selectedCustomerIdsForExport.has(String(c.id)));
  }
  return filtered;
}

function resetSearchableSelect(selectId) {
  const select = document.getElementById(selectId);
  if (!select) return null;
  const wrapper = select.parentNode;
  if (wrapper && wrapper.classList && wrapper.classList.contains('searchable-select-wrapper')) {
    const parent = wrapper.parentNode;
    parent.insertBefore(select, wrapper);
    wrapper.remove();
    select.style.display = '';
  }
  return select;
}

function getUserOptionValue(user) {
  return user.username || user.id || user.email || '';
}

function getManagedByOptions() {
  const options = new Map();
  (state.users || []).forEach(user => {
    const value = getUserOptionValue(user);
    if (value) options.set(String(value), user.displayName || user.name || user.username || user.id);
  });
  (state.customers || []).forEach(customer => {
    const value = customer.managedBy || customer.managed_by;
    if (!value) return;
    const matched = (state.users || []).find(user =>
      isSameUser(user.username, value) ||
      isSameUser(user.id, value) ||
      isSameUser(user.email, value)
    );
    options.set(String(value), matched ? (matched.displayName || matched.name || matched.username || matched.id) : String(value));
  });
  return Array.from(options.entries()).sort((a, b) => a[1].localeCompare(b[1], 'vi'));
}

function populateCustomerOrderExportManagerFilter() {
  const select = resetSearchableSelect('customer-order-export-manager');
  if (!select) return;
  const managerOptions = getManagedByOptions();
  select.innerHTML = `<option value="all">T&#7845;t c&#7843;</option>${managerOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}`;
  const currentCustomerFilter = document.getElementById('customer-managed-filter')?.value || '';
  const hasCurrent = Array.from(select.options).some(opt => opt.value === currentCustomerFilter);
  select.value = currentCustomerFilter && hasCurrent && !['unassigned', 'unassigned_pricelist'].includes(currentCustomerFilter) ? currentCustomerFilter : 'all';
  makeSelectSearchable('customer-order-export-manager', 'Tất cả');
}

function getSelectedExportManagerId() {
  return document.getElementById('customer-order-export-manager')?.value || 'all';
}

function populateCustomerOrderExportCustomerFilter() {
  const select = resetSearchableSelect('customer-order-export-customer');
  if (!select) return;
  select.innerHTML = `<option value="all">T&#7845;t c&#7843;</option>${(state.customers || []).map(c => {
    const phone = c.phone ? `SĐT: ${formatPhoneNumber(c.phone)}` : 'Chưa có SĐT';
    const provinceName = getProvinceNameByCode(c.brandDiscounts && c.brandDiscounts.province);
    const addressParts = [c.address, c.ward, provinceName].filter(Boolean);
    const address = addressParts.length > 0 ? addressParts.join(', ') : 'Chưa có địa chỉ';
    return `<option value="${c.id}">${c.name || c.code || c.id} • ${phone} • ${address}</option>`;
  }).join('')}`;
  select.value = activeExportCustomerId || 'all';
  makeSelectSearchable('customer-order-export-customer', 'Tất cả');
}
function getSelectedExportCustomerId() {
  return document.getElementById('customer-order-export-customer')?.value || 'all';
}

function populateCustomerOrderExportCompanyFilter() {
  const select = resetSearchableSelect('customer-order-export-company');
  if (!select) return;
  const companies = state.companies || [];
  select.innerHTML = `<option value="all">T&#7845;t c&#7843;</option>${companies.map(c => `<option value="${c.id}">${c.name || c.id}</option>`).join('')}`;
  select.value = 'all';
  makeSelectSearchable('customer-order-export-company', 'Tất cả');
}

function populateCustomerOrderExportBrandFilter() {
  const select = resetSearchableSelect('customer-order-export-brand');
  if (!select) return;
  const brandNames = Array.from(new Set((state.brands || [])
    .map(b => b.name)
    .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b, 'vi'));
  select.innerHTML = `<option value="all">T&#7845;t c&#7843;</option>${brandNames.map(name => `<option value="${name}">${name}</option>`).join('')}`;
  select.value = 'all';
  makeSelectSearchable('customer-order-export-brand', 'Tất cả');
}

function getSelectedExportCompanyId() {
  return document.getElementById('customer-order-export-company')?.value || 'all';
}

function getSelectedExportBrand() {
  return document.getElementById('customer-order-export-brand')?.value || 'all';
}

function customerMatchesExportCompany(customer, companyId) {
  if (!companyId || companyId === 'all') return true;
  const selectedCompanyId = normalizeCompanyId(companyId);
  const customerCompanyId = customer.companyId || customer.company_id || getCompanyIdByBrand(customer.assignedBrand, state.brands);
  return normalizeCompanyId(customerCompanyId) === selectedCompanyId;
}

function customerMatchesExportBrand(customer, brandName) {
  if (!brandName || brandName === 'all') return true;
  const customerBrand = customer.assignedBrand || customer.assigned_brand || '';
  return customerBrand.toLowerCase() === brandName.toLowerCase();
}

function orderMatchesExportCompany(order, companyId) {
  if (!companyId || companyId === 'all') return true;
  const selectedCompanyId = normalizeCompanyId(companyId);
  if (normalizeCompanyId(order.companyId || order.company_id) === selectedCompanyId) return true;
  return (order.items || []).some(item => {
    const itemCompany = item.revenueCompany || item.companyId || item.company_id || getCompanyIdByBrand(item.revenueBrand || item.agencyBrand || item.productBrand || item.brand, state.brands);
    return normalizeCompanyId(itemCompany) === selectedCompanyId;
  });
}

function orderMatchesExportBrand(order, brandName) {
  if (!brandName || brandName === 'all') return true;
  const selected = brandName.toLowerCase();
  return (order.items || []).some(item =>
    [item.revenueBrand, item.agencyBrand, item.productBrand, item.brand]
      .filter(Boolean)
      .some(b => String(b).toLowerCase() === selected)
  );
}

function getOrderStatusLabel(status) {
  const labels = {
    all: 'Đơn hợp lệ',
    settled: 'Đã chốt',
    completed: 'Đã chốt',
    complete: 'Đã chốt',
    confirmed: 'Đã chốt',
    partially_returned: 'Trả một phần',
    returned: 'Đã trả toàn bộ',
    draft: 'Đơn nháp',
    cancelled: 'Đã hủy',
    canceled: 'Đã hủy'
  };
  return labels[status] || status;
}

function normalizeExportOrderStatus(status) {
  const normalized = String(status || 'settled').toLowerCase();
  if (['settled', 'completed', 'complete', 'confirmed'].includes(normalized)) return 'settled';
  if (['cancelled', 'canceled'].includes(normalized)) return 'cancelled';
  return normalized;
}

function orderMatchesExportStatus(order, selectedStatus) {
  if (!selectedStatus || selectedStatus === 'all') {
    return !['draft', 'cancelled'].includes(normalizeExportOrderStatus(order.status));
  }
  return normalizeExportOrderStatus(order.status) === selectedStatus;
}

function populateCustomerOrderExportStatusFilter(orders) {
  const select = document.getElementById('customer-order-export-status');
  if (!select) return;
  const allowedOrderStatuses = ['settled', 'partially_returned', 'returned', 'draft', 'cancelled'];
  const presentStatuses = new Set((orders || []).map(order => normalizeExportOrderStatus(order.status)));
  const statuses = allowedOrderStatuses.filter(status => presentStatuses.has(status));
  select.innerHTML = `
    <option value="all">${getOrderStatusLabel('all')}</option>
    ${statuses.map(status => `<option value="${status}">${getOrderStatusLabel(status)}</option>`).join('')}
  `;
}

function updateCustomerOrderExportScopeText() {
  const el = document.getElementById('customer-order-export-scope-text');
  if (!el) return;
  if (activeExportOrders) {
    el.innerText = activeExportOrderIds && activeExportOrderIds.length > 0
      ? `${activeExportOrderIds.length} đơn đã tích chọn`
      : `${activeExportOrders.length} đơn theo bộ lọc hiện tại`;
    return;
  }
  const count = getExportCustomersByScope().length;
  if (activeExportCustomerId) el.innerText = `1 khách hàng đang xem`;
  else if (selectedCustomerIdsForExport.size > 0) el.innerText = `${count} khách hàng đã tích chọn`;
  else el.innerText = `${count} khách hàng theo bộ lọc hiện tại`;
}

function openCustomerOrderExportModal(customerId = null) {
  activeExportOrders = null;
  activeExportOrderIds = null;
  activeExportCustomerId = customerId;
  activeExportScopeMode = customerId ? 'single' : (selectedCustomerIdsForExport.size > 0 ? 'selected' : 'filtered');
  const modal = document.getElementById('customer-order-export-modal');
  if (!modal) return;
  const relevantOrders = customerId
    ? (state.savedOrders || []).filter(order => String(order.customerId || '') === String(customerId))
    : (state.savedOrders || []);
  populateCustomerOrderExportStatusFilter(relevantOrders);
  const fromInput = document.getElementById('customer-order-export-from');
  const toInput = document.getElementById('customer-order-export-to');
  const rangeMode = document.getElementById('customer-order-export-range-mode');
  if (rangeMode) rangeMode.value = 'last_month';
  const lastMonthRange = getCustomerOrderExportDateRange();
  if (fromInput) fromInput.value = lastMonthRange.fromDate;
  if (toInput) toInput.value = lastMonthRange.toDate;
  populateCustomerOrderExportCompanyFilter();
  populateCustomerOrderExportBrandFilter();
  populateCustomerOrderExportManagerFilter();
  populateCustomerOrderExportCustomerFilter();
  renderCustomerOrderExportColumnOptions();
  updateCustomerOrderExportScopeText();
  modal.classList.add('active');
}

export function openHistoryOrderExportModal(orders, selectedOrderIds = []) {
  const availableOrders = Array.isArray(orders) ? orders : [];
  const selectedIds = Array.isArray(selectedOrderIds) && selectedOrderIds.length > 0
    ? selectedOrderIds.map(String)
    : null;
  if (availableOrders.length === 0) {
    showToast('Không có đơn hàng trong kết quả hiện tại để xuất Excel.', 'warning');
    return;
  }
  if (!selectedIds && !confirm(`Xuất toàn bộ ${availableOrders.length} đơn theo bộ lọc hiện tại?`)) {
    return;
  }
  activeExportCustomerId = null;
  activeExportScopeMode = selectedIds ? 'history_selected' : 'history_filtered';
  activeExportOrders = availableOrders;
  activeExportOrderIds = selectedIds;
  const modal = document.getElementById('customer-order-export-modal');
  if (!modal) return;
  const rangeMode = document.getElementById('customer-order-export-range-mode');
  // The history screen has already applied its date filter. Preserve that
  // exact result instead of silently resetting the export to last month.
  if (rangeMode) rangeMode.value = 'current_filter';
  const datedOrders = availableOrders
    .map(order => new Date(order.date || order.createdAt || order.created_at))
    .filter(date => Number.isFinite(date.getTime()))
    .sort((a, b) => a - b);
  const fromDate = datedOrders.length > 0 ? getVnDateInputValueFromDate(datedOrders[0]) : getVnDateInputValue(0);
  const toDate = datedOrders.length > 0 ? getVnDateInputValueFromDate(datedOrders.at(-1)) : fromDate;
  const fromInput = document.getElementById('customer-order-export-from');
  const toInput = document.getElementById('customer-order-export-to');
  if (fromInput) fromInput.value = fromDate;
  if (toInput) toInput.value = toDate;
  const customRange = document.getElementById('customer-order-export-custom-range');
  if (customRange) customRange.style.display = 'none';
  populateCustomerOrderExportCompanyFilter();
  populateCustomerOrderExportBrandFilter();
  populateCustomerOrderExportManagerFilter();
  populateCustomerOrderExportCustomerFilter();
  populateCustomerOrderExportStatusFilter(orders || []);
  renderCustomerOrderExportColumnOptions();
  updateCustomerOrderExportScopeText();
  modal.classList.add('active');
}

function closeCustomerOrderExportModal() {
  const modal = document.getElementById('customer-order-export-modal');
  if (modal) modal.classList.remove('active');
}

async function exportCustomerOrderHistoryExcel() {
  const isHistoryExport = Array.isArray(activeExportOrders);
  const customers = isHistoryExport ? (state.customers || []) : getExportCustomersByScope();
  if (!isHistoryExport && customers.length === 0) {
    showToast('Không có khách hàng phù hợp để xuất.', 'warning');
    return;
  }
  if (!globalThis.XLSX) {
    showToast('Thư viện Excel chưa tải xong. Vui lòng thử lại.', 'danger');
    return;
  }
  const selectedColumns = getSelectedCustomerOrderExportColumns();
  if (selectedColumns.length === 0) {
    showToast('Vui lòng chọn ít nhất một cột để xuất.', 'warning');
    return;
  }
  localStorage.setItem(CUSTOMER_ORDER_EXPORT_COLUMNS_STORAGE_KEY, JSON.stringify(selectedColumns));

  const submitBtn = document.getElementById('btn-submit-customer-order-export');
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerText = 'Đang xuất...';
  }

  const range = getCustomerOrderExportDateRange();
  const fromDate = range.fromDate;
  const toDate = range.toDate;
  const status = document.getElementById('customer-order-export-status')?.value || 'all';
  if (!fromDate || !toDate || fromDate > toDate) {
    showToast('Vui lòng chọn khoảng ngày hợp lệ.', 'warning');
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="download" style="width: 16px; height: 16px;"></i> Xuất Excel';
      safeCreateIcons();
    }
    return;
  }
  try {
    const { startIso, endExclusiveIso } = getVnRangeIso(fromDate, toDate);
    const selectedCompanyId = getSelectedExportCompanyId();
    const selectedBrand = getSelectedExportBrand();
    const selectedManagerId = getSelectedExportManagerId();
    const selectedCustomerId = getSelectedExportCustomerId();
    let scopedCustomers = customers;
    if (selectedCustomerId !== 'all') {
      scopedCustomers = scopedCustomers.filter(c => String(c.id) === String(selectedCustomerId));
    }
    if (!isHistoryExport && selectedCompanyId !== 'all') {
      scopedCustomers = scopedCustomers.filter(c => customerMatchesExportCompany(c, selectedCompanyId));
    }
    if (!isHistoryExport && selectedBrand !== 'all') {
      scopedCustomers = scopedCustomers.filter(c => customerMatchesExportBrand(c, selectedBrand));
    }
    if (selectedManagerId !== 'all') {
      scopedCustomers = scopedCustomers.filter(c => isSameUser(c.managedBy || c.managed_by, selectedManagerId));
    }
    const customerById = new Map(scopedCustomers.map(c => [String(c.id), c]));
    let orders = [];
    if (isHistoryExport) {
      const allowedOrderIds = activeExportOrderIds ? new Set(activeExportOrderIds.map(String)) : null;
      const startTime = new Date(startIso).getTime();
      const endTime = new Date(endExclusiveIso).getTime();
      orders = activeExportOrders.filter(order => {
        if (allowedOrderIds && !allowedOrderIds.has(String(order.id))) return false;
        if (selectedCustomerId !== 'all'
          && String(order.customerId || order.customer_id || '') !== String(selectedCustomerId)) return false;
        const orderTime = new Date(order.date || order.createdAt || order.created_at).getTime();
        if (!Number.isFinite(orderTime) || orderTime < startTime || orderTime >= endTime) return false;
        if (!orderMatchesExportStatus(order, status)) return false;
        if (selectedCompanyId !== 'all' && !orderMatchesExportCompany(order, selectedCompanyId)) return false;
        if (selectedBrand !== 'all') {
          const cust = customerById.get(String(order.customerId || order.customer_id));
          const matchedCustomerBrand = cust && customerMatchesExportBrand(cust, selectedBrand);
          if (!matchedCustomerBrand && !orderMatchesExportBrand(order, selectedBrand)) return false;
        }
        if (selectedManagerId !== 'all') {
          const cust = customerById.get(String(order.customerId || order.customer_id));
          if (!cust || !isSameUser(cust.managedBy || cust.managed_by, selectedManagerId)) return false;
        }
        return true;
      });
    } else {
      orders = await dbFetchCustomersOrderHistory(scopedCustomers.map(c => c.id), startIso, endExclusiveIso, status);
    }
    const exportRows = orders.flatMap(order => {
      const customer = customerById.get(String(order.customerId || order.customer_id)) || {
        id: order.customerId || order.customer_id || '',
        code: order.customerCode || order.customer_code || '',
        name: order.customerName || order.customer_name || 'Khách lẻ',
        phone: order.customerPhone || order.customer_phone || '',
        address: order.customerAddress || order.customer_address || '',
        pricelistId: order.pricelistId || order.pricelist_id || '',
        managedBy: order.customerManagerId || order.customer_manager_id || '',
        brandDiscounts: {}
      };
      if (isHistoryExport) {
        const row = buildHistoryOrderExportRow(order, customer);
        return row ? [row] : [];
      }
      return buildCustomerOrderExportRows([order], customer);
    });
    if (exportRows.length === 0) {
      showToast('Không có đơn hàng phù hợp để xuất Excel.', 'warning');
      return;
    }

    const sheetData = [
      selectedColumns,
      ...exportRows.map(row => selectedColumns.map(col => row[col] ?? ''))
    ];
    const worksheet = XLSX.utils.aoa_to_sheet(sheetData);
    worksheet['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: sheetData.length - 1, c: selectedColumns.length - 1 } }) };
    worksheet['!freeze'] = { xSplit: 0, ySplit: 1 };
    worksheet['!cols'] = selectedColumns.map(col => ({ wch: Math.min(38, Math.max(12, col.length + 4)) }));
    selectedColumns.forEach((_, idx) => {
      const cellRef = XLSX.utils.encode_cell({ r: 0, c: idx });
      if (worksheet[cellRef]) worksheet[cellRef].s = { font: { bold: true } };
    });

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Lịch sử đơn hàng');
    const fileRange = range.label || `${fromDate}-${toDate}`;
    const fileName = `LichSuDonHang_${sanitizeFilePart(fileRange)}_${customers.length}Khach.xlsx`;
    XLSX.writeFile(workbook, fileName);
    closeCustomerOrderExportModal();
    showToast(
      isHistoryExport
        ? `Đã xuất ${exportRows.length} đơn hàng, mỗi đơn một dòng.`
        : `Đã xuất ${exportRows.length} dòng chi tiết lịch sử đơn hàng.`,
      'success'
    );
  } catch (error) {
    console.error('Không thể xuất Excel lịch sử đơn hàng:', error);
    showToast('Không thể xuất Excel lịch sử đơn hàng: ' + (error.message || 'Lỗi hệ thống'), 'danger');
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = '<i data-lucide="download" style="width: 16px; height: 16px;"></i> Xuất Excel';
      safeCreateIcons();
    }
  }
}

function getCustomerDebtSource(historyEntry = {}) {
  const orderId = historyEntry.orderId || historyEntry.order_id;
  if (orderId) return { kind: 'order', id: String(orderId) };
  const cashbookId = historyEntry.cashbookTransactionId || historyEntry.cashbook_transaction_id;
  if (cashbookId) return { kind: 'cashbook', id: String(cashbookId) };
  const salesReturnId = historyEntry.salesReturnId || historyEntry.sales_return_id;
  if (salesReturnId) return { kind: 'return', id: String(salesReturnId) };
  return null;
}

function getCustomerDebtSourceDisplayCode(source) {
  const code = String(source?.id || '');
  if (code.length <= 14) return code;
  const parts = code.split('-').filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}…${parts.at(-1)}`;
  return `${code.slice(0, 7)}…${code.slice(-5)}`;
}

function debtSourceMeta(label, value) {
  return `<div style="padding:0.7rem; border:1px solid var(--border-color); border-radius:7px; background:rgba(255,255,255,0.02);"><div style="font-size:0.7rem; color:var(--text-muted); text-transform:uppercase;">${escapeCustomerHtml(label)}</div><div style="font-weight:600; margin-top:3px;">${escapeCustomerHtml(value || '-')}</div></div>`;
}

function getCachedCashbookTransactions() {
  try {
    const parsed = JSON.parse(localStorage.getItem('billing_system_cashbook_transactions') || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

async function openCustomerDebtSourceDetail(source, historyEntry, customer) {
  if (!source) return;
  const modal = document.getElementById('customer-debt-source-modal');
  const loading = document.getElementById('customer-debt-source-loading');
  const content = document.getElementById('customer-debt-source-content');
  const orderSection = document.getElementById('customer-debt-source-order');
  const cashbookSection = document.getElementById('customer-debt-source-cashbook');
  if (!modal || !loading || !content || !orderSection || !cashbookSection) return;

  modal.classList.add('active');
  loading.style.display = 'block';
  content.style.display = 'none';
  orderSection.style.display = 'none';
  cashbookSection.style.display = 'none';

  try {
    if (source.kind === 'order') {
      let order = (state.savedOrders || []).find(item => String(item.id) === source.id);
      if (!order) {
        await dbRefreshOrderById(source.id);
        order = (state.savedOrders || []).find(item => String(item.id) === source.id);
      }
      if (!order) throw new Error(`Không tìm thấy đơn hàng ${source.id} trong phạm vi được xem.`);

      document.getElementById('customer-debt-source-title').innerText = `Chi tiết đơn hàng ${source.id}`;
      document.getElementById('customer-debt-source-meta').innerHTML = [
        debtSourceMeta('Mã đơn', order.id),
        debtSourceMeta('Khách hàng', order.customerName || customer?.name),
        debtSourceMeta('Thời gian', formatDateOnly(order.date)),
        debtSourceMeta('Trạng thái', order.status === 'settled' ? 'Đã chốt' : order.status === 'cancelled' ? 'Đã hủy' : order.status || '-')
      ].join('');

      const items = Array.isArray(order.items) ? order.items : [];
      document.getElementById('customer-debt-source-items').innerHTML = items.length
        ? items.map(item => {
            const quantity = Number(item.quantity || 0);
            const price = Number(item.price ?? item.unitPrice ?? 0);
            const discount = Number(item.discountPercent || 0);
            const lineTotal = Number(item.lineTotal ?? Math.round(quantity * price * (1 - discount / 100)));
            const specification = item.specificationSnapshot || item.packagingName || item.package || '-';
            return `<tr><td>${escapeCustomerHtml(item.productCode || item.variantCode || item.product?.code || '-')}</td><td>${escapeCustomerHtml(item.productName || item.product?.name || '-')}</td><td>${escapeCustomerHtml(specification)}</td><td style="text-align:right;">${quantity.toLocaleString('vi-VN')}</td><td style="text-align:right;">${formatCurrency(price)}</td><td style="text-align:right;">${discount ? `${discount}%` : '-'}</td><td style="text-align:right; font-weight:600;">${formatCurrency(lineTotal)}</td></tr>`;
          }).join('')
        : '<tr><td colspan="7" style="text-align:center; color:var(--text-muted);">Không có chi tiết sản phẩm.</td></tr>';
      document.getElementById('customer-debt-source-totals').innerHTML = `
        <div style="display:flex;justify-content:space-between;"><span>Tạm tính</span><strong>${formatCurrency(order.subtotal ?? order.totalMarket ?? 0)}</strong></div>
        <div style="display:flex;justify-content:space-between;"><span>Giảm giá</span><strong>-${formatCurrency(order.discountAmount || 0)}</strong></div>
        <div style="display:flex;justify-content:space-between; border-top:1px solid var(--border-color); padding-top:0.45rem;"><span>Khách phải trả</span><strong style="color:var(--color-primary);">${formatCurrency(order.totalPayable ?? order.amountDue ?? 0)}</strong></div>`;
      document.getElementById('customer-debt-source-note').innerText = order.notes || historyEntry.note || '-';
      orderSection.style.display = 'block';
    } else if (source.kind === 'cashbook') {
      let transactions = getCachedCashbookTransactions();
      let transaction = transactions.find(item => String(item.cloudId || item.id) === source.id);
      if (!transaction) {
        transaction = await dbFetchCashbookTransactionById(source.id);
      }
      if (!transaction) throw new Error(`Không tìm thấy phiếu thu/chi ${source.id} trong phạm vi được xem.`);

      document.getElementById('customer-debt-source-title').innerText = `Chi tiết phiếu ${transaction.id}`;
      document.getElementById('customer-debt-source-meta').innerHTML = [
        debtSourceMeta('Mã phiếu', transaction.id),
        debtSourceMeta('Loại', transaction.type === 'chi' ? 'Phiếu chi' : 'Phiếu thu'),
        debtSourceMeta('Thời gian', formatDateOnly(transaction.date)),
        debtSourceMeta('Trạng thái', transaction.status || '-')
      ].join('');
      cashbookSection.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:0.75rem;">${debtSourceMeta('Người nộp/nhận', transaction.partner)}${debtSourceMeta('Loại thu chi', transaction.category)}${debtSourceMeta('Phương thức', transaction.method === 'bank' ? 'Ngân hàng' : transaction.method === 'wallet' ? 'Ví điện tử' : 'Tiền mặt')}${debtSourceMeta('Giá trị', formatCurrency(transaction.value || 0))}</div>`;
      document.getElementById('customer-debt-source-note').innerText = transaction.note || historyEntry.note || '-';
      cashbookSection.style.display = 'block';
    } else {
      const salesReturn = (state.salesReturns || []).find(item => String(item.id) === source.id);
      document.getElementById('customer-debt-source-title').innerText = `Chi tiết phiếu trả ${source.id}`;
      document.getElementById('customer-debt-source-meta').innerHTML = [
        debtSourceMeta('Mã phiếu trả', source.id),
        debtSourceMeta('Khách hàng', customer?.name),
        debtSourceMeta('Thời gian', formatDateOnly(salesReturn?.date || historyEntry.date)),
        debtSourceMeta('Giá trị', formatCurrency(salesReturn?.totalRefund || historyEntry.amount || 0))
      ].join('');
      document.getElementById('customer-debt-source-note').innerText = salesReturn?.reason || historyEntry.note || '-';
    }
  } catch (error) {
    document.getElementById('customer-debt-source-title').innerText = 'Không thể mở chứng từ';
    document.getElementById('customer-debt-source-meta').innerHTML = `<div style="grid-column:1/-1; padding:1rem; color:var(--color-danger); text-align:center;">${escapeCustomerHtml(error.message || 'Không tìm thấy dữ liệu.')}</div>`;
    document.getElementById('customer-debt-source-note').innerText = historyEntry.note || historyEntry.notes || '-';
  } finally {
    loading.style.display = 'none';
    content.style.display = 'block';
    safeCreateIcons();
  }
}

export async function openCustomerDetailModal(index) {
  const modal = document.getElementById('customer-detail-modal');
  let cust = state.customers[index];
  if (!modal || !cust) return;

  modal.classList.add('active');

  const loadingHistoryBody = document.getElementById('detail-debt-history-body');
  if (loadingHistoryBody) {
    loadingHistoryBody.innerHTML = '<tr><td colspan="7" style="text-align:center; padding:2rem; color:var(--text-muted);">Đang tải lịch sử công nợ...</td></tr>';
  }
  const refreshedCustomer = await dbRefreshCustomerFinancialState(cust.id);
  if (refreshedCustomer) cust = refreshedCustomer;

  // Điền thông tin cơ bản
  const modalTitle = document.getElementById('customer-detail-modal-title');
  if (modalTitle) {
    modalTitle.innerText = `Thông tin & Lịch sử công nợ của đại lý mã ${cust.code}`;
  }

  const exportBtn = document.getElementById('btn-open-customer-order-export');
  if (exportBtn) exportBtn.setAttribute('data-customer-id', cust.id);

  document.getElementById('detail-cust-code').innerText = cust.code;
  document.getElementById('detail-cust-name').innerText = cust.name;
  document.getElementById('detail-cust-phone').innerText = formatPhoneNumber(cust.phone);
  const provinceName = getProvinceNameByCode(cust.brandDiscounts && cust.brandDiscounts.province);
  const detailAddress = cust.address || 'N/A';
  document.getElementById('detail-cust-address').innerText = provinceName ? `[${provinceName}] ${detailAddress}` : detailAddress;
  
  const brandEl = document.getElementById('detail-cust-brand');
  if (brandEl) {
    brandEl.innerHTML = `<span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: ${cust.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.2)' : 'rgba(34, 197, 94, 0.15)'}; color: ${cust.assignedBrand === 'Tất cả' ? '#10b981' : '#22c55e'}; border: 1px solid ${cust.assignedBrand === 'Tất cả' ? 'rgba(16, 185, 129, 0.4)' : 'rgba(34, 197, 94, 0.3)'};">${cust.assignedBrand}</span>`;
  }
  
  const mName = cust.managedBy ? getManagerDisplayName(cust.managedBy, state.users) : 'Chưa bàn giao / Trống';
  document.getElementById('detail-cust-manager').innerText = mName;
  
  // Xác định tên bảng giá đang áp dụng
  let plName = '';
  const plId = cust.pricelistId || '';
  if (plId === '') {
    plName = 'Chưa xác định';
  } else if (plId === 'custom') {
    const discSummary = [];
    if (cust.brandDiscounts) {
      for (const [brand, pct] of Object.entries(cust.brandDiscounts)) {
        if (pct > 0) {
          discSummary.push(`${brand}: ${pct}%`);
        }
      }
    }
    plName = discSummary.length > 0 
      ? `CK riêng (${discSummary.join(', ')})` 
      : 'Chiết khấu riêng';
  } else if (plId === 'retail') {
    plName = 'Khách lẻ (Nhập tay)';
  } else {
    const pl = state.pricelists.find(p => p.id === plId);
    plName = pl ? pl.name : plId;
  }
  document.getElementById('detail-cust-pricelist').innerText = plName;
  document.getElementById('detail-cust-notes').innerText = cust.notes || 'N/A';
  
  const metrics = getCustomerMetrics(cust);
  const grossEl = document.getElementById('detail-cust-sales-gross');
  if (grossEl) grossEl.innerText = formatCurrency(metrics.grossSales);
  
  const retTotEl = document.getElementById('detail-cust-returns-total');
  if (retTotEl) retTotEl.innerText = formatCurrency(metrics.totalReturns);

  const netEl = document.getElementById('detail-cust-sales-net');
  if (netEl) netEl.innerText = formatCurrency(metrics.netSales);

  const rateEl = document.getElementById('detail-cust-return-rate');
  if (rateEl) rateEl.innerText = `${metrics.returnRate}%`;

  const payEl = document.getElementById('detail-cust-total-payments');
  if (payEl) payEl.innerText = formatCurrency(metrics.totalPayments);

  const detailDebtEl = document.getElementById('detail-cust-debt');
  if (detailDebtEl) {
    detailDebtEl.innerText = formatCurrency(cust.debt || 0);
    detailDebtEl.style.color = (cust.debt > 0) ? 'var(--color-danger)' : ((cust.debt < 0) ? 'var(--color-success)' : 'var(--text-muted)');
  }


  // Vẽ danh sách lịch sử biến động công nợ
  const historyBody = document.getElementById('detail-debt-history-body');
  if (historyBody) {
    const history = buildCustomerDebtDisplayHistory(cust.debtHistory || [], cust.debt);
    
    // Sắp xếp theo ngày giờ mới nhất lên trên
    // Balance snapshots follow server posting order. A backdated document must
    // not be placed before rows that were already included in its debtBefore.
    const sortedHistory = history.reverse();
    
    if (sortedHistory.length === 0) {
      historyBody.innerHTML = `
        <tr>
          <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">
            Chưa có lịch sử giao dịch công nợ nào cho đại lý này.
          </td>
        </tr>
      `;
    } else {
      historyBody.innerHTML = sortedHistory.map(h => {
        let typeBadge = '';
        let amountText = '';
        let debtBefore = 0;
        const noteText = h.note || h.notes || '-';
        const source = getCustomerDebtSource(h);
        const sourceIcon = source?.kind === 'cashbook' ? 'receipt-text' : source?.kind === 'return' ? 'rotate-ccw' : 'file-text';
        const sourceCell = source
          ? `<button type="button" class="customer-debt-source-link" data-source-kind="${escapeCustomerHtml(source.kind)}" data-source-id="${escapeCustomerHtml(source.id)}" data-history-id="${escapeCustomerHtml(h.id || '')}" title="Mở chứng từ ${escapeCustomerHtml(source.id)}"><i data-lucide="${sourceIcon}" aria-hidden="true"></i><span>${escapeCustomerHtml(getCustomerDebtSourceDisplayCode(source))}</span></button>`
          : '<span style="color:var(--text-muted);">-</span>';
        
        const debtChange = Number.isFinite(Number(h.debtChange)) ? Number(h.debtChange) : null;
        if (h.type === 'payment') {
          typeBadge = `<span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: rgba(16, 185, 129, 0.15); color: #10b981; border: 1px solid rgba(16, 185, 129, 0.3); font-weight: 600; white-space: nowrap;">Thu nợ</span>`;
          amountText = `<span style="color: var(--color-primary); font-weight: 600;">-${formatCurrency(h.amount)}</span>`;
          debtBefore = h.debtBefore ?? (h.debtAfter + h.amount);
        } else if (h.type === 'charge') {
          typeBadge = `<span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: rgba(239, 68, 68, 0.15); color: #ef4444; border: 1px solid rgba(239, 68, 68, 0.3); font-weight: 600; white-space: nowrap;">Ghi nợ</span>`;
          amountText = `<span style="color: var(--color-danger); font-weight: 600;">+${formatCurrency(h.amount)}</span>`;
          debtBefore = h.debtBefore ?? (h.debtAfter - h.amount);
        } else if (h.type === 'return') {
          typeBadge = `<span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: rgba(14, 165, 233, 0.15); color: #0284c7; border: 1px solid rgba(14, 165, 233, 0.3); font-weight: 600; white-space: nowrap;">Trả hàng</span>`;
          const returnChange = debtChange ?? -Math.abs(Number(h.amount || 0));
          amountText = `<span style="color: #0284c7; font-weight: 600;">-${formatCurrency(Math.abs(returnChange))}</span>`;
          debtBefore = h.debtBefore ?? (h.debtAfter - returnChange);
        } else {
          typeBadge = `<span style="font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; background: rgba(99, 102, 241, 0.15); color: #818cf8; border: 1px solid rgba(99, 102, 241, 0.3); font-weight: 600; white-space: nowrap;">Điều chỉnh</span>`;
          const effectiveChange = debtChange ?? Number(h.amount || 0);
          const sign = effectiveChange >= 0 ? '+' : '';
          amountText = `<span style="color: #818cf8; font-weight: 600;">${sign}${formatCurrency(effectiveChange)}</span>`;
          debtBefore = h.debtBefore ?? (h.debtAfter - effectiveChange);
        }
        
        const transactionDate = new Date(getCustomerDebtPostingDate(h));
        const formattedDate = new Intl.DateTimeFormat('vi-VN', {
          year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(transactionDate);
        const formattedTime = new Intl.DateTimeFormat('vi-VN', {
          hour: '2-digit', minute: '2-digit'
        }).format(transactionDate);
        
        return `
          <tr>
            <td class="customer-debt-time-cell"><strong>${formattedDate}</strong><span>${formattedTime}</span></td>
            <td class="customer-debt-source-cell">${sourceCell}</td>
            <td style="text-align: center;">${typeBadge}</td>
            <td style="text-align: right;">${formatCurrency(debtBefore)}</td>
            <td style="text-align: right;">${amountText}</td>
            <td style="text-align: right; font-weight: 600;">${formatCurrency(h.debtAfter)}</td>
            <td style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${escapeCustomerHtml(noteText)}">${escapeCustomerHtml(noteText)}</td>
          </tr>
        `;

      }).join('');

      historyBody.querySelectorAll('.customer-debt-source-link').forEach(button => {
        button.addEventListener('click', async () => {
          const sourceKind = button.getAttribute('data-source-kind');
          const sourceId = button.getAttribute('data-source-id');
          const historyId = button.getAttribute('data-history-id');
          const historyEntry = sortedHistory.find(entry => historyId && String(entry.id || '') === historyId)
            || sortedHistory.find(entry => {
              const candidate = getCustomerDebtSource(entry);
              return candidate?.kind === sourceKind && candidate?.id === sourceId;
            });
          if (!historyEntry) return;
          await openCustomerDebtSourceDetail({ kind: sourceKind, id: sourceId }, historyEntry, cust);
        });
      });

    }
  }

  safeCreateIcons();
}

export function closeCustomerDetailModal() {
  const modal = document.getElementById('customer-detail-modal');
  if (modal) modal.classList.remove('active');
}

// Bổ sung danh sách nhân viên vào Dropdown trong Customer Modal
export function populateManagedByDropdown() {
  const select = document.getElementById('cust-managed-by');
  if (!select) return;
  
  select.innerHTML = `
    <option value="">-- Chưa bàn giao / Trống --</option>
    ${state.users.map(u => `
      <option value="${u.username}">${u.displayName} (${u.isExternal ? 'Kinh doanh ngoài' : (u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale')})</option>
    `).join('')}
  `;
}

let custExcelImportData = [];
let custExcelDuplicateCodeCount = 0;
let isSelectingFile = false;
let custExcelImportDebug = null;

export function openCustExcelModal() {
  const modal = document.getElementById('cust-excel-modal');
  if (modal) {
    modal.classList.add('active');
    


    // Reset UI
    custExcelImportData = [];
    custExcelDuplicateCodeCount = 0;
    custExcelImportDebug = null;
    const mergeMode = document.querySelector('input[name="cust-import-mode"][value="merge"]');
    if (mergeMode) mergeMode.checked = true;
    document.getElementById('cust-excel-file-input').value = '';
    document.getElementById('cust-excel-preview-container').style.display = 'none';
    const submitBtn = document.getElementById('btn-save-cust-excel-submit');
    if (submitBtn) {
      submitBtn.setAttribute('disabled', 'true');
      submitBtn.disabled = true;
    }
    const dropzone = document.getElementById('cust-excel-dropzone');
    if (dropzone) dropzone.className = 'upload-dropzone';
  }
}

export function closeCustExcelModal() {
  const modal = document.getElementById('cust-excel-modal');
  if (modal) modal.classList.remove('active');
}

function handleCustExcelFile(file) {
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array', cellDates: true, UTC: true });
      const expectedSheetName = normalizeExcelSheetName('DanhSachKhachHang');
      const sheetName = workbook.SheetNames.find(name => normalizeExcelSheetName(name) === expectedSheetName);
      if (!sheetName) {
        showToast("Không tìm thấy sheet 'DanhSachKhachHang' trong file Excel!", "danger");
        return;
      }
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1 });
      
      if (rows.length === 0) {
        showToast("Tập tin Excel trống!", "danger");
        return;
      }
      
      const headerMapping = buildCustomerImportColumnMap(rows[0]);
      const colMap = headerMapping.columns;
      custExcelImportDebug = { sheetName, ...headerMapping, sample: null };
      
      if (colMap.name === -1) {
        showToast("Tập tin không có cột 'Tên khách hàng'!", "danger");
        return;
      }

      console.info('[Customer Excel Import] Header mapping', custExcelImportDebug);
      
      const normalizePersonName = value => normalizeExcelHeader(value)
        .replace(/^(?:(?:mr|ms|mrs|anh|chi|mn)\.?\s*)+/, '')
        .trim();

      const resolveImportManager = excelName => {
        if (!excelName) return null;
        const originalTarget = normalizePersonName(excelName);
        const aliases = {
          thuy: 'nguyen thanh thuy',
          'duong hoan': 'duong nhu hoan'
        };
        const targets = [...new Set([originalTarget, aliases[originalTarget]].filter(Boolean))];

        // Always try the exact name from Excel first. Aliases are only a
        // fallback, so "Mr Dương Hoàn" can match a profile named Dương Hoàn
        // instead of being forced to the legacy name Dương Như Hoàn.
        for (const target of targets) {
          const exact = (state.users || []).filter(user =>
            normalizeExcelHeader(user.username) === target
            || normalizePersonName(user.displayName) === target
          );
          if (exact.length === 1) return exact[0];
        }

        for (const target of targets) {
          const partial = (state.users || []).filter(user => {
            const display = normalizePersonName(user.displayName);
            return display.includes(target) || target.includes(display);
          });
          if (partial.length === 1) return partial[0];
        }
        return null;
      };

      const resolveImportBrand = excelName => {
        const originalTarget = normalizeExcelHeader(excelName);
        const aliases = {
          'festival nano': 'festiva nano',
          fesvival: 'festiva nano',
          'fesvival nano': 'festiva nano',
          'tddkaw nano': 'tdkaw nano'
        };
        const targets = [...new Set([originalTarget, aliases[originalTarget]].filter(Boolean))];
        for (const target of targets) {
          const matches = (state.brands || []).filter(brand =>
            normalizeExcelHeader(brand.name) === target
            || normalizeExcelHeader(brand.id) === target
          );
          if (matches.length === 1) return matches[0];
        }
        return null;
      };

      custExcelImportData = [];
      custExcelDuplicateCodeCount = 0;
      const previewRows = [];
      const rowErrors = [];
      const rowWarnings = [];
      const importTimestamp = new Date().toISOString();
      
      const provinces = Object.entries(PROVINCES).map(([code, name]) => ({ code, name }));
      
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;
        
        let name = colMap.name !== -1 ? readExcelText(row[colMap.name]) : '';
        if (!name) continue; // skip rows without name
        
        let code = colMap.code !== -1 ? readExcelText(row[colMap.code]).toUpperCase() : '';
        let phone = colMap.phone !== -1 ? readExcelText(row[colMap.phone]) : '';
        let address = colMap.address !== -1 ? readExcelText(row[colMap.address]) : '';
        const rawDebt = colMap.debt !== -1 ? row[colMap.debt] : null;
        const rawTotalTransaction = colMap.totalTransaction !== -1 ? row[colMap.totalTransaction] : null;
        const rawTotalReturn = colMap.totalReturns !== -1 ? row[colMap.totalReturns] : null;
        const rawNetRevenue = colMap.netSales !== -1 ? row[colMap.netSales] : null;
        const parsedDebt = parseOptionalImportedNumber(rawDebt);
        const parsedTotalTransaction = parseOptionalImportedNumber(rawTotalTransaction);
        const parsedTotalReturn = parseOptionalImportedNumber(rawTotalReturn);
        const parsedNetRevenue = parseOptionalImportedNumber(rawNetRevenue);
        let debt = parsedDebt ?? 0;
        let totalTransaction = parsedTotalTransaction ?? 0;
        let totalReturn = parsedTotalReturn ?? 0;
        let netRevenue = parsedNetRevenue ?? Math.max(0, totalTransaction - totalReturn);
        let notes = colMap.notes !== -1 ? readExcelText(row[colMap.notes]) : '';
        const rawLastTransactionAt = colMap.lastTransactionAt !== -1 ? row[colMap.lastTransactionAt] : null;
        const rawCreatedAt = colMap.createdAt !== -1 ? row[colMap.createdAt] : null;
        let lastTransactionAt = colMap.lastTransactionAt !== -1
          ? parseExcelDate(rawLastTransactionAt)
          : null;
        let createdAt = colMap.createdAt !== -1 ? parseExcelDate(rawCreatedAt) : null;
        const rawDebtDays = colMap.debtDays !== -1 ? row[colMap.debtDays] : null;
        const parsedDebtDays = parseOptionalImportedNumber(rawDebtDays);
        let debtDays = parsedDebtDays === null ? null : Math.trunc(parsedDebtDays);

        if (hasExcelValue(rawCreatedAt) && !createdAt) {
          rowErrors.push(`Dòng ${i + 1}: Ngày tạo không hợp lệ (${String(rawCreatedAt)})`);
          continue;
        }
        if (hasExcelValue(rawLastTransactionAt) && !lastTransactionAt) {
          rowErrors.push(`Dòng ${i + 1}: Ngày giao dịch cuối không hợp lệ (${String(rawLastTransactionAt)})`);
          continue;
        }
        
        const codeLower = code.toLowerCase();

        // Brand assignment
        let assignedBrand = '';
        let assignedBrandId = null;
        let excelBrandVal = colMap.excelBrand !== -1 ? readExcelText(row[colMap.excelBrand]) : '';
        if (excelBrandVal) {
          const foundBrand = resolveImportBrand(excelBrandVal);
          if (!foundBrand) {
            rowWarnings.push(`Dòng ${i + 1}: Không tìm thấy nhãn sơn "${excelBrandVal}"; đã để trống`);
          } else {
            assignedBrand = foundBrand.name;
            assignedBrandId = foundBrand.id;
          }
        }

        
        // Auto detect pricelist
        let pricelistId = '';
        let excelPlVal = colMap.excelPricelist !== -1 ? readExcelText(row[colMap.excelPricelist]) : '';
        if (excelPlVal) {
          const normalizedPriceList = normalizeExcelHeader(excelPlVal);
          const foundPl = state.pricelists.find(p =>
            normalizeExcelHeader(p.name) === normalizedPriceList
            || normalizeExcelHeader(p.id) === normalizedPriceList
          );
          if (foundPl) {
            pricelistId = foundPl.id;
          } else {
            rowWarnings.push(`Dòng ${i + 1}: Không tìm thấy bảng giá "${excelPlVal}"; đã để trống`);
          }
        }
        
        // Auto detect province from address or code
        let provinceCode = 'OTHER';
        const addressLower = address.toLowerCase();
        for (const prov of provinces) {
          const provNameLower = prov.name.toLowerCase();
          if (addressLower.includes(provNameLower) || codeLower.includes(provNameLower)) {
            provinceCode = prov.code;
            break;
          }
        }
        
        if (!code) {
          code = generateUniqueCustomerCode(provinceCode);
        }

        const rawManager = colMap.excelManager !== -1 ? readExcelText(row[colMap.excelManager]) : '';
        let managedBy = '';
        if (rawManager) {
          const normalizedManager = normalizeExcelHeader(rawManager);
          if (normalizedManager.includes('abs japan')) managedBy = 'ctyabs@lendon.com';
          else if (normalizedManager.includes('emp hoa ky')) managedBy = 'emp_hoa_ky';
          else {
            const matchedUser = resolveImportManager(rawManager);
            if (!matchedUser) {
              rowWarnings.push(`Dòng ${i + 1}: Không tìm thấy người quản lý "${rawManager}"; đã để trống`);
            } else {
              managedBy = matchedUser.username;
            }
          }
        }
        
        const customerObj = {
          id: `cust-${Date.now()}-${i}-${Math.floor(Math.random() * 1000)}`,
          code: code,
          name: name,
          phone: phone,
          address: address,
          assignedBrand: assignedBrand,
          assignedBrandId,
          brandDiscounts: {
            province: provinceCode,
            salesBaselineImportedAt: importTimestamp,
            ...(debtDays !== null ? { debtDays } : {})
          },
          shippingSupport: false,
          debt: debt,
          totalTransaction: totalTransaction,
          totalReturn: totalReturn,
          netRevenue: netRevenue,
          debtDays: debtDays ?? 0,
          lastOrderAt: lastTransactionAt || null,
          createdAt: createdAt || null,
          salesBaselineImportedAt: importTimestamp,
          notes,
          pricelistId: pricelistId,
          managedBy,
          importFieldPresence: {
            phone: hasExcelValue(colMap.phone !== -1 ? row[colMap.phone] : null),
            address: hasExcelValue(colMap.address !== -1 ? row[colMap.address] : null),
            assignedBrand: Boolean(excelBrandVal),
            pricelistId: Boolean(excelPlVal),
            managedBy: Boolean(rawManager),
            notes: hasExcelValue(colMap.notes !== -1 ? row[colMap.notes] : null),
            debt: parsedDebt !== null,
            totalTransaction: parsedTotalTransaction !== null,
            totalReturn: parsedTotalReturn !== null,
            netRevenue: parsedNetRevenue !== null || parsedTotalTransaction !== null || parsedTotalReturn !== null,
            debtDays: parsedDebtDays !== null,
            lastOrderAt: hasExcelValue(rawLastTransactionAt),
            createdAt: hasExcelValue(rawCreatedAt)
          },
          debtHistory: debt !== 0 ? [{
            date: new Date().toISOString(),
            type: 'adjust',
            amount: debt,
            debtAfter: debt,
            notes: 'Số dư đầu kỳ nhập từ KiotViet'
          }] : []
        };

        if (!custExcelImportDebug.sample) {
          custExcelImportDebug.sample = {
            excelRow: i + 1,
            rawCreatedAt,
            parsedCreatedAt: createdAt,
            createdAtDatabaseField: 'customers.created_at',
            rawLastTransactionAt,
            parsedLastTransactionAt: lastTransactionAt,
            lastTransactionDatabaseField: 'customers.last_order_at',
            mappedCustomer: { ...customerObj, debtHistory: undefined }
          };
          console.info('[Customer Excel Import] Parsed row sample', custExcelImportDebug.sample);
        }
        
        custExcelImportData.push(customerObj);
      }

      if (rowErrors.length > 0) {
        console.error('[Customer Excel Import] Mapping errors', rowErrors);
        custExcelImportData = [];
        throw new Error(`${rowErrors.length} dòng không thể ánh xạ. ${rowErrors.slice(0, 5).join(' | ')}`);
      }

      if (rowWarnings.length > 0) {
        console.warn('[Customer Excel Import] Unmatched optional associations left blank', rowWarnings);
      }
      
      if (custExcelImportData.length === 0) {
        showToast("Không phân tích được khách hàng nào hợp lệ!", "warning");
        return;
      }

      custExcelDuplicateCodeCount = makeImportCustomerCodesUnique(custExcelImportData);
      custExcelImportData.slice(0, 5).forEach(customer => {
        previewRows.push({
          code: customer.code,
          name: customer.name,
          phone: customer.phone,
          address: customer.address,
          province: customer.brandDiscounts?.province || 'OTHER',
          pricelistId: customer.pricelistId,
          debt: customer.debt,
          totalTransaction: customer.totalTransaction,
          totalReturn: customer.totalReturn,
          netRevenue: customer.netRevenue,
          lastOrderAt: customer.lastOrderAt,
          createdAt: customer.createdAt,
          debtDays: customer.debtDays
        });
      });
      
      // Render preview table
      const previewBody = document.getElementById('cust-excel-preview-table-body');
      if (previewBody) {
        previewBody.innerHTML = previewRows.map((c, idx) => {
          const pl = state.pricelists.find(p => p.id === c.pricelistId);
          const plName = pl ? pl.name : (c.pricelistId === 'custom' ? 'Chiết khấu riêng' : 'Chiết khấu riêng');
          const provName = provinces.find(p => p.code === c.province)?.name || 'Khác';
          return `
            <tr>
              <td style="text-align: center;">${idx + 1}</td>
              <td style="font-weight: 600;">${c.code}</td>
              <td>${c.name}</td>
              <td>${c.phone || '-'}</td>
              <td>[${provName}] ${c.address || '-'}</td>
              <td>${plName}</td>
              <td style="text-align: center; white-space: nowrap;">${c.lastOrderAt ? formatDateOnly(c.lastOrderAt) : '-'}</td>
              <td style="text-align: center; white-space: nowrap;">${c.createdAt ? formatDateOnly(c.createdAt) : '-'}</td>
              <td style="text-align: center;">${c.debtDays}</td>
              <td style="text-align: right;">${formatCurrency(c.debt)}</td>
              <td style="text-align: right;">${formatCurrency(c.totalTransaction)}</td>
            </tr>
          `;
        }).join('');
      }
      
      const summaryText = document.getElementById('cust-excel-preview-summary');
      if (summaryText) {
        const totals = calculateCustomerTotals(custExcelImportData);
        summaryText.innerHTML = `
          Đã đọc <strong>${totals.count}</strong> khách hàng.
          Công nợ: <strong>${formatCurrency(totals.debt)}</strong> ·
          Doanh số: <strong>${formatCurrency(totals.grossSales)}</strong> ·
          Trả hàng: <strong>${formatCurrency(totals.totalReturns)}</strong> ·
          Sau trả hàng: <strong>${formatCurrency(totals.netSales)}</strong>
          ${custExcelDuplicateCodeCount > 0
            ? ` · Đã đổi mã cho <strong>${custExcelDuplicateCodeCount}</strong> dòng bị trùng để lưu đủ dữ liệu.`
            : ''}
          ${rowWarnings.length > 0
            ? ` · <strong>${rowWarnings.length}</strong> liên kết Nhãn/Bảng giá/Người quản lý không khớp đã được để trống.`
            : ''}
        `;
      }
      
      const previewContainer = document.getElementById('cust-excel-preview-container');
      if (previewContainer) previewContainer.style.display = 'block';
      
      const submitBtn = document.getElementById('btn-save-cust-excel-submit');
      if (submitBtn) {
        submitBtn.removeAttribute('disabled');
        submitBtn.disabled = false;
      }
      
      const dropzone = document.getElementById('cust-excel-dropzone');
      if (dropzone) dropzone.className = 'upload-dropzone success-uploaded';
      
      showToast(
        `Đọc tệp thành công! Tìm thấy ${custExcelImportData.length} khách hàng.${rowWarnings.length > 0 ? ` ${rowWarnings.length} liên kết không khớp đã để trống.` : ''}`,
        rowWarnings.length > 0 ? "warning" : "success"
      );
    } catch (err) {
      console.error(err);
      showToast("Lỗi đọc tập tin Excel: " + err.message, "danger");
    } finally {
      const el = document.getElementById('cust-excel-file-input');
      if (el) el.value = '';
    }
  };
  reader.readAsArrayBuffer(file);
}

async function processCustomerExcelImport() {
  if (custExcelImportData.length === 0) return;

  const mode = document.querySelector('input[name="cust-import-mode"]:checked')?.value || 'merge';
  if (mode === 'overwrite' && !['admin', 'accounting'].includes(state.currentUser?.role)) {
    showToast('Chỉ Admin hoặc Kế toán được ghi đè danh sách khách hàng.', 'danger');
    return;
  }
  
  try {
    showToast("Đang đồng bộ dữ liệu đám mây mới nhất...", "info");
    const cloudCustomersLoaded = await dbFetchCustomers();
    if (mode === 'overwrite' && !cloudCustomersLoaded) {
      throw new Error('Không tải được danh sách khách hàng mới nhất; đã hủy ghi đè để bảo vệ dữ liệu hiện tại.');
    }
    const customersBeforeImport = [...state.customers];
    
    showToast("Đang nhập dữ liệu khách hàng vào hệ thống...", "info");
    
    // Mỗi khách hiện có chỉ được ghép một lần để các mã trùng trong Excel
    // vẫn được giữ thành các dòng khách hàng riêng biệt.
    const claimedExistingIds = new Set();
    for (const c of custExcelImportData) {
      let idx = -1;
      const cCodeClean = c.code.trim().toUpperCase().normalize('NFC');
      const cPhoneClean = String(c.phone || '').replace(/\D/g, '');
      idx = state.customers.findIndex(oc => {
        if (claimedExistingIds.has(oc.id)) return false;
        const sameCode = (oc.code || '').toString().trim().toUpperCase().normalize('NFC') === cCodeClean;
        const existingPhone = String(oc.phone || '').replace(/\D/g, '');
        const samePhone = Boolean(cPhoneClean && existingPhone && cPhoneClean === existingPhone);
        return sameCode || samePhone;
      });
      
      if (idx > -1) {
        // Update existing customer
        const existingCustomer = state.customers[idx];
        const oldId = existingCustomer.id;
        claimedExistingIds.add(oldId);
        c.id = oldId; // keep original ID

        const presence = c.importFieldPresence || {};
        if (mode === 'merge') {
          if (!presence.phone) c.phone = existingCustomer.phone || '';
          if (!presence.address) c.address = existingCustomer.address || '';
          if (!presence.assignedBrand) {
            c.assignedBrand = existingCustomer.assignedBrand || c.assignedBrand;
            c.assignedBrandId = existingCustomer.assignedBrandId || existingCustomer.assigned_brand_id || c.assignedBrandId;
          }
          if (!presence.pricelistId) c.pricelistId = existingCustomer.pricelistId || '';
          if (!presence.managedBy) c.managedBy = existingCustomer.managedBy || '';
          if (!presence.notes) c.notes = existingCustomer.notes || '';
          if (!presence.debt) c.debt = Number(existingCustomer.importedDebtBaseline || 0);
          if (!presence.totalTransaction) c.totalTransaction = Number(existingCustomer.importedTotalTransactionBaseline || 0);
          if (!presence.totalReturn) c.totalReturn = Number(existingCustomer.importedTotalReturnBaseline || 0);
          if (!presence.netRevenue) c.netRevenue = Number(existingCustomer.importedNetRevenueBaseline || 0);
          c.brandDiscounts = { ...(existingCustomer.brandDiscounts || {}), ...(c.brandDiscounts || {}) };
          if (!presence.debtDays && existingCustomer.brandDiscounts?.debtDays !== undefined) {
            c.brandDiscounts.debtDays = existingCustomer.brandDiscounts.debtDays;
            c.debtDays = existingCustomer.brandDiscounts.debtDays;
          }
        }
        
        // Merge debt histories
        const oldHistory = existingCustomer.debtHistory || [];
        c.debtHistory = [...oldHistory, ...c.debtHistory];
        c.lastPaymentAt = existingCustomer.lastPaymentAt || existingCustomer.last_payment_at || null;
        c.createdAt = c.createdAt || existingCustomer.createdAt || existingCustomer.created_at || null;
        
        state.customers[idx] = c;
      } else {
        // Insert new customer
        // A blank Excel creation date intentionally stays null so PostgreSQL's
        // default applies only to this individual new customer.
        c.createdAt = c.createdAt || null;
        state.customers.push(c);
      }
    }
    
    // Perform a single BULK UPSERT to Supabase (de-duplicate by id to prevent Postgres ON CONFLICT error)
    const uniqueImportMap = new Map();
    for (const c of custExcelImportData) {
      uniqueImportMap.set(c.id, c);
    }
    const uniqueImportData = Array.from(uniqueImportMap.values());
    const importedIds = new Set(uniqueImportData.map(customer => customer.id));
    const obsoleteCustomerIds = mode === 'overwrite'
      ? customersBeforeImport.filter(customer => !importedIds.has(customer.id)).map(customer => customer.id)
      : [];

    if (mode === 'overwrite') {
      const confirmed = confirm(
        `Ghi đè toàn bộ sẽ thay danh sách hiện tại bằng ${uniqueImportData.length} khách hàng trong file` +
        ` và xóa ${obsoleteCustomerIds.length} khách hàng không có trong file. Lịch sử đơn hàng vẫn được giữ nguyên. Bạn có chắc chắn tiếp tục?`
      );
      if (!confirmed) {
        state.customers = customersBeforeImport;
        return;
      }
    }
    
    const saved = await dbSaveCustomersBulk(uniqueImportData);
    if (saved) {
      const financialsSaved = await dbImportCustomerFinancialBaselines(uniqueImportData);
      if (!financialsSaved) return;

      const expectedTotals = calculateCustomerTotals(uniqueImportData);
      localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      const refreshedFromCloud = await dbFetchCustomers();
      const persistedImportData = refreshedFromCloud
        ? state.customers.filter(customer => importedIds.has(customer.id))
        : uniqueImportData;
      const persistedTotals = calculateCustomerImportedBaselineTotals(persistedImportData);

      const datesMatch = customerImportDatesMatch(uniqueImportData, persistedImportData);
      if (persistedImportData.length !== uniqueImportData.length || !customerTotalsMatch(expectedTotals, persistedTotals) || !datesMatch) {
        console.error('Customer Excel import verification failed', { expectedTotals, persistedTotals });
        showToast(
          !datesMatch
            ? 'Ngày tạo hoặc ngày giao dịch cuối trên máy chủ chưa khớp file Excel.'
            : `Dữ liệu lưu chưa khớp file. Mong đợi ${formatCurrency(expectedTotals.grossSales)}, máy chủ trả về ${formatCurrency(persistedTotals.grossSales)}.`,
          "danger"
        );
        return;
      }

      // Chỉ xóa hồ sơ cũ sau khi toàn bộ dữ liệu mới đã được máy chủ xác nhận.
      // Lịch sử đơn, sổ nợ và chứng từ không nằm trong phạm vi xóa này.
      if (mode === 'overwrite' && obsoleteCustomerIds.length > 0) {
        const removed = await dbDeleteCustomersBulk(obsoleteCustomerIds);
        if (!removed) return;
        await dbFetchCustomers();
      }

      renderAll();
      closeCustExcelModal();
      showToast(
        `${mode === 'overwrite' ? 'Đã ghi đè' : 'Đã nhập đủ'} ${uniqueImportData.length} khách hàng · Doanh số ${formatCurrency(persistedTotals.grossSales)} · Sau trả hàng ${formatCurrency(persistedTotals.netSales)}.`,
        "success"
      );
    }
  } catch (err) {
    console.error(err);
    showToast("Lỗi lưu dữ liệu khách hàng: " + err.message, "danger");
  }
}
