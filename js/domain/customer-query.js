const DAY_MS = 86400000;

export function normalizeCustomerSearch(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLocaleLowerCase('vi')
    .trim()
    .replace(/\s+/g, ' ');
}

export function normalizeCustomerPhone(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function matchesCustomerQuickSearch(customer, rawSearch) {
  const search = normalizeCustomerSearch(rawSearch);
  if (!search) return true;

  const textMatches = normalizeCustomerSearch([
    customer.code, customer.name, customer.phone
  ].join(' ')).includes(search);
  if (textMatches) return true;

  // Only use digits-only phone matching for phone-shaped queries. This avoids
  // a customer code such as KH003 matching every phone number containing 003.
  const raw = String(rawSearch ?? '').trim();
  if (!/^[+\d\s()./-]+$/.test(raw)) return false;
  const phoneQuery = normalizeCustomerPhone(raw);
  return Boolean(phoneQuery) && normalizeCustomerPhone(customer.phone).includes(phoneQuery);
}

export function finiteCustomerNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = typeof value === 'number'
    ? value
    : Number(String(value).replace(/\s/g, '').replace(/,/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

export function customerDateKey(value) {
  if (!value) return '';
  const iso = String(value).match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function dateFromKey(key) {
  const match = String(key || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 12) : null;
}

function shiftDate(date, days) {
  const copy = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function dateRangeForPreset(preset, now = new Date()) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  const key = customerDateKey;
  switch (preset) {
    case 'today': return [key(today), key(today)];
    case 'yesterday': { const d = shiftDate(today, -1); return [key(d), key(d)]; }
    case 'last7': return [key(shiftDate(today, -6)), key(today)];
    case 'last30': return [key(shiftDate(today, -29)), key(today)];
    case 'last90': return [key(shiftDate(today, -89)), key(today)];
    case 'last180': return [key(shiftDate(today, -179)), key(today)];
    case 'last365': return [key(shiftDate(today, -364)), key(today)];
    case 'thisMonth': return [key(new Date(today.getFullYear(), today.getMonth(), 1, 12)), key(today)];
    case 'previousMonth': return [
      key(new Date(today.getFullYear(), today.getMonth() - 1, 1, 12)),
      key(new Date(today.getFullYear(), today.getMonth(), 0, 12))
    ];
    case 'thisYear': return [key(new Date(today.getFullYear(), 0, 1, 12)), key(today)];
    default: return ['', ''];
  }
}

function inDateRange(value, from, to) {
  const key = customerDateKey(value);
  if (!key) return false;
  return (!from || key >= from) && (!to || key <= to);
}

export function customerDaysSince(value, now = new Date()) {
  const key = customerDateKey(value);
  const date = dateFromKey(key);
  if (!date) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12);
  return Math.max(0, Math.floor((today - date) / DAY_MS));
}

function debtStatus(customer, now) {
  const debt = finiteCustomerNumber(customer.debt) ?? 0;
  const debtDays = Math.trunc(finiteCustomerNumber(customer.debtDays) ?? 0);
  const daysSince = customerDaysSince(customer.lastTransactionAt, now);
  if (debt < 0) return { status: 'negative', overdueDays: 0 };
  if (debt === 0) return { status: 'none', overdueDays: 0 };
  if (debtDays <= 0 || daysSince === null) return { status: 'unconfigured', overdueDays: 0 };
  const overdueDays = daysSince - debtDays;
  return overdueDays > 0
    ? { status: 'overdue', overdueDays }
    : { status: overdueDays >= -7 ? 'dueSoon' : 'notDue', overdueDays: 0 };
}

function hasValue(value) {
  return value !== null && value !== undefined && String(value).trim() !== '';
}

function matchesPresence(value, mode) {
  if (!mode || mode === 'all') return true;
  return mode === 'has' ? hasValue(value) : !hasValue(value);
}

function selectedIncludes(selected, value) {
  return !Array.isArray(selected) || selected.length === 0 || selected.includes(String(value ?? ''));
}

function salesValue(customer, metric) {
  if (metric === 'grossSales') return finiteCustomerNumber(customer.grossSales) ?? 0;
  if (metric === 'totalReturns') return finiteCustomerNumber(customer.totalReturns) ?? 0;
  return finiteCustomerNumber(customer.netSales) ?? 0;
}

function matchesSalesPreset(value, preset) {
  if (!preset) return true;
  if (preset === 'zero') return value === 0;
  if (preset === 'positive') return value !== 0;
  const threshold = Number(preset.replace('gt', ''));
  return Number.isFinite(threshold) ? value > threshold : true;
}

function matchesDebtPreset(customer, preset, now) {
  if (!preset) return true;
  const debt = finiteCustomerNumber(customer.debt) ?? 0;
  const info = debtStatus(customer, now);
  if (preset === 'zero') return debt === 0;
  if (preset === 'positive') return debt > 0;
  if (preset === 'negative') return debt < 0;
  if (preset === 'overdue') return info.status === 'overdue';
  if (preset === 'notOverdue') return debt > 0 && info.status !== 'overdue';
  if (preset === 'unconfigured') return info.status === 'unconfigured';
  if (preset.startsWith('overdue')) {
    const [min, max] = preset.replace('overdue', '').split('-').map(Number);
    return info.status === 'overdue' && info.overdueDays >= min && (!max || info.overdueDays <= max);
  }
  const threshold = Number(preset.replace('gt', ''));
  return Number.isFinite(threshold) ? debt > threshold : true;
}

function matchesLastTransactionPreset(customer, preset, now) {
  if (!preset) return true;
  const last = customer.lastTransactionAt;
  const days = customerDaysSince(last, now);
  if (preset === 'never') return !last;
  if (!last || days === null) return false;
  if (preset.startsWith('inactive')) return days > Number(preset.replace('inactive', ''));
  const range = dateRangeForPreset(preset, now);
  return inDateRange(last, range[0], range[1]);
}

function missingCount(customer) {
  return [customer.phone, customer.address, customer.brand, customer.pricelistId,
    customer.managerId, customer.notes, customer.createdAt]
    .reduce((count, value) => count + (hasValue(value) ? 0 : 1), 0);
}

function viCompare(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), 'vi', { sensitivity: 'base', numeric: true });
}

function compareNullable(a, b, direction, nullsFirst = false, compare = viCompare) {
  const aNull = a === null || a === undefined || a === '' || Number.isNaN(a);
  const bNull = b === null || b === undefined || b === '' || Number.isNaN(b);
  if (aNull || bNull) {
    if (aNull && bNull) return 0;
    return (aNull ? 1 : -1) * (nullsFirst ? -1 : 1);
  }
  return compare(a, b) * (direction === 'asc' ? 1 : -1);
}

function primarySort(customer, key, now) {
  switch (key) {
    case 'createdAt': return customerDateKey(customer.createdAt);
    case 'lastTransactionAt': return customerDateKey(customer.lastTransactionAt);
    case 'daysInactive': return customerDaysSince(customer.lastTransactionAt, now);
    case 'grossSales': return finiteCustomerNumber(customer.grossSales) ?? 0;
    case 'totalReturns': return finiteCustomerNumber(customer.totalReturns) ?? 0;
    case 'netSales': return finiteCustomerNumber(customer.netSales) ?? 0;
    case 'debt': return finiteCustomerNumber(customer.debt) ?? 0;
    case 'overdueDays': return debtStatus(customer, now).overdueDays;
    case 'missing': return missingCount(customer);
    case 'code': return customer.code;
    case 'manager': return customer.managerName;
    case 'brand': return customer.brand;
    case 'pricelist': return customer.pricelistName;
    case 'province': return customer.provinceName;
    default: return customer.name;
  }
}

export function sortCustomerRows(rows, query = {}, now = new Date()) {
  const key = query.sortKey || 'lastTransactionAt';
  const direction = query.sortDirection || 'desc';
  const nullsFirst = query.nulls === 'first';
  const numericKeys = new Set(['daysInactive', 'grossSales', 'totalReturns', 'netSales', 'debt', 'overdueDays', 'missing']);
  return [...rows].sort((a, b) => {
    const aPrimary = primarySort(a, key, now);
    const bPrimary = primarySort(b, key, now);
    const primary = compareNullable(aPrimary, bPrimary, direction, nullsFirst,
      numericKeys.has(key) ? (x, y) => x - y : viCompare);
    if (primary) return primary;
    const lastTie = compareNullable(customerDateKey(a.lastTransactionAt), customerDateKey(b.lastTransactionAt), 'desc');
    if (lastTie) return lastTie;
    const nameTie = viCompare(a.name, b.name);
    return nameTie || viCompare(a.id, b.id);
  });
}

export function filterCustomerRows(rows, query = {}, now = new Date()) {
  const createdPresetRange = dateRangeForPreset(query.createdPreset, now);
  const salesMin = finiteCustomerNumber(query.salesMin);
  const salesMax = finiteCustomerNumber(query.salesMax);
  const debtMin = finiteCustomerNumber(query.debtMin);
  const debtMax = finiteCustomerNumber(query.debtMax);

  return rows.filter(customer => {
    if (!matchesCustomerQuickSearch(customer, query.q)) return false;

    const createdAt = customer.createdAt;
    if (query.createdPreset === 'missing' && createdAt) return false;
    if (query.createdPreset && query.createdPreset !== 'missing'
      && !inDateRange(createdAt, createdPresetRange[0], createdPresetRange[1])) return false;
    if ((query.createdFrom || query.createdTo)
      && !inDateRange(createdAt, query.createdFrom, query.createdTo)) return false;

    if (!matchesLastTransactionPreset(customer, query.lastPreset, now)) return false;
    if ((query.lastFrom || query.lastTo)
      && !inDateRange(customer.lastTransactionAt, query.lastFrom, query.lastTo)) return false;

    const sales = salesValue(customer, query.salesMetric || 'netSales');
    if (!matchesSalesPreset(sales, query.salesPreset)) return false;
    if (salesMin !== null && sales < salesMin) return false;
    if (salesMax !== null && sales > salesMax) return false;

    const debt = finiteCustomerNumber(customer.debt) ?? 0;
    if (!matchesDebtPreset(customer, query.debtPreset, now)) return false;
    if (debtMin !== null && debt < debtMin) return false;
    if (debtMax !== null && debt > debtMax) return false;

    if (!selectedIncludes(query.brands, customer.brand)) return false;
    if (!selectedIncludes(query.pricelists, customer.pricelistId)) return false;
    if (!selectedIncludes(query.managers, customer.managerId)) return false;
    if (!selectedIncludes(query.provinces, customer.provinceCode)) return false;
    if (query.status && query.status !== customer.status) return false;
    if (!matchesPresence(customer.phone, query.phoneState)) return false;
    if (!matchesPresence(customer.address, query.addressState)) return false;
    if (!matchesPresence(customer.pricelistId, query.pricelistState)) return false;
    if (!matchesPresence(customer.managerId, query.managerState)) return false;
    if (!matchesPresence(customer.brand, query.brandState)) return false;
    if (!matchesPresence(customer.notes, query.notesState)) return false;
    return true;
  });
}

export function queryCustomerRows(rows, query = {}, now = new Date()) {
  return sortCustomerRows(filterCustomerRows(rows, query, now), query, now);
}
