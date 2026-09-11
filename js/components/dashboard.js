import { state } from '../state.js';
import { formatCurrency, safeCreateIcons, isSameUser, getUserCompanyId, getCompanyNameById, getCompanyIdByBrand, getCanonicalBrandName, normalizeCompanyId, getNormalizedBrandName, removeVietnameseTones, showToast, getUserDisplayName } from '../utils.js';
import { switchTab } from '../main.js?v=20260909-inline-filter-v4';
import { openProductModal } from './products.js?v=20260909-inline-filter-v4';
import { tenantStorage } from '../services/tenant-storage.js';
import { dbFetchPhase5Dashboard } from '../services/supabase.js?v=20260909-inline-filter-v4';
import { buildDashboardChartSeries } from '../domain/dashboard-series.js';
import { filterLoginEmployeeRevenueRows } from '../domain/dashboard-employees.js';

let revenueChartInstance = null;
let dashboardChartRequestId = 0;
let dashboardStatsInFlight = null;
let dashboardStatsInFlightKey = '';
let dashboardStatsCache = { key: '', payload: null, cachedAt: 0 };
const DASHBOARD_STATS_CACHE_MS = 10_000;
const DASHBOARD_COMPANY_SCOPE_VERSION = 'finance-all-companies-v1';
const dashboardBreakdownCharts = new Map();
const DASHBOARD_CHART_COLORS = ['#0057cd', '#006e08', '#bf0014', '#006eff', '#05e61f', '#ffb4ab', '#00419d', '#ba1a1a'];
const DASHBOARD_CHART_FONT = "'Inter', system-ui, sans-serif";
const DASHBOARD_CHART_GRID = '#e2e2e2';
const DASHBOARD_CHART_TEXT = '#3e484e';
const DASHBOARD_CHART_TOOLTIP = Object.freeze({
  backgroundColor: '#1a1c1c',
  titleColor: '#ffffff',
  bodyColor: '#f8fafc',
  borderColor: 'rgba(255,255,255,.12)',
  borderWidth: 1,
  cornerRadius: 8,
  padding: 10,
  titleFont: { family: DASHBOARD_CHART_FONT, size: 12, weight: '600' },
  bodyFont: { family: DASHBOARD_CHART_FONT, size: 12, weight: '500' }
});
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function renderOnboardingChecklist() {
  const card = document.getElementById('saas-onboarding-checklist');
  const list = document.getElementById('saas-onboarding-steps');
  if (!card || !list) return;
  const role = String(state.currentUser?.organizationRole || '').toLowerCase();
  if (!['owner', 'admin'].includes(role) || !state.currentUser?.organizationId) {
    card.style.display = 'none';
    return;
  }

  const planOrders = Number(state.saasContext?.planUsage?.orders?.used || 0);
  const steps = [
    { key: 'organization', label: 'Thông tin doanh nghiệp', detail: 'Workspace và địa chỉ sovie.vn đã sẵn sàng.', done: Boolean(state.saasContext?.organizationName && state.saasContext?.organizationSlug), target: 'settings-panel', action: 'Kiểm tra' },
    { key: 'members', label: 'Mời nhân viên', detail: 'Thêm ít nhất một thành viên để cùng vận hành.', done: (state.users || []).filter(user => !user.isExternal && user.membershipStatus !== 'suspended').length > 1, target: 'users-panel', action: 'Mời thành viên' },
    { key: 'products', label: 'Tạo sản phẩm', detail: 'Khai báo sản phẩm hoặc nhập danh mục có sẵn.', done: (state.products || []).length > 0, target: 'products-panel', action: 'Thêm sản phẩm' },
    { key: 'customers', label: 'Tạo khách hàng', detail: 'Thêm khách hàng đầu tiên để lập đơn.', done: (state.customers || []).length > 0, target: 'customers-panel', action: 'Thêm khách hàng' },
    { key: 'order', label: 'Tạo đơn hàng đầu tiên', detail: 'Hoàn tất một giao dịch thử nghiệm trên Cloud.', done: planOrders > 0 || (state.savedOrders || []).length > 0, target: 'invoice-panel', action: 'Lập đơn hàng' }
  ];
  const completed = steps.filter(step => step.done).length;
  const percent = Math.round((completed / steps.length) * 100);
  card.style.display = completed === steps.length ? 'none' : '';
  const progressLabel = document.getElementById('saas-onboarding-progress-label');
  const progressBar = document.getElementById('saas-onboarding-progress-bar');
  const summary = document.getElementById('saas-onboarding-summary');
  if (progressLabel) progressLabel.textContent = `${completed}/${steps.length}`;
  if (progressBar) progressBar.style.width = `${percent}%`;
  if (summary) summary.textContent = completed
    ? `Đã hoàn thành ${completed}/${steps.length} bước. Tiếp tục để sẵn sàng vận hành.`
    : 'Thực hiện các bước nền tảng trước khi vận hành đơn hàng đầu tiên.';
  list.innerHTML = steps.map(step => `
    <article class="saas-onboarding-step ${step.done ? 'is-complete' : ''}">
      <span class="saas-onboarding-step-icon"><i data-lucide="${step.done ? 'check' : 'circle'}"></i></span>
      <span class="saas-onboarding-step-copy"><strong>${escapeHtml(step.label)}</strong><small>${escapeHtml(step.detail)}</small></span>
      ${step.done ? '<span class="saas-onboarding-done">Hoàn tất</span>' : `<button type="button" class="saas-onboarding-action" data-target="${step.target}">${escapeHtml(step.action)} <i data-lucide="arrow-right"></i></button>`}
    </article>`).join('');
  safeCreateIcons();
}

function canViewAllDashboardCompanies(user = state.currentUser) {
  return ['admin', 'accounting'].includes(String(user?.role || '').toLowerCase());
}

function dashboardCompanyScopeActor(user = state.currentUser) {
  return String(user?.authUserId || user?.auth_user_id || user?.id || user?.username || '');
}

const VN_TIMEZONE = 'Asia/Ho_Chi_Minh';
const VALID_REVENUE_STATUSES = new Set(['settled', 'completed', 'complete', 'confirmed', 'partially_returned', 'returned']);

function toNumber(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback;
  const normalized = typeof value === 'string'
    ? value.replace(/[^\d.-]/g, '')
    : value;
  const num = Number(normalized);
  return Number.isFinite(num) ? num : fallback;
}

function normalizeKey(value, fallback = 'unassigned') {
  if (!value) return fallback;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed && trimmed !== 'null' && trimmed !== 'undefined' && !trimmed.startsWith('[object Object]') ? trimmed : fallback;
  }
  if (Array.isArray(value)) {
    const first = value.find(Boolean);
    return normalizeKey(first, fallback);
  }
  if (typeof value === 'object') {
    return normalizeKey(value.username || value.id || value.code || value.name, fallback);
  }
  return String(value);
}

function getVnDateParts(dateInput) {
  const date = new Date(dateInput);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: VN_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short'
  }).formatToParts(date);
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  const ymd = `${map.year}-${map.month}-${map.day}`;
  return {
    ymd,
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    weekday: map.weekday
  };
}

function getDashboardDateRange(timeRange = state.dashboardFilter.timeRange || 'month') {
  const nowParts = getVnDateParts(new Date());
  if (!nowParts) return null;
  if (timeRange === 'custom') {
    if (!state.dashboardFilter.startDate || !state.dashboardFilter.endDate) return null;
    return { start: state.dashboardFilter.startDate, end: state.dashboardFilter.endDate };
  }
  if (timeRange === 'day') {
    return { start: nowParts.ymd, end: nowParts.ymd };
  }
  if (timeRange === 'week') {
    const now = new Date(`${nowParts.ymd}T00:00:00+07:00`);
    const day = now.getDay();
    const diff = now.getDate() - day + (day === 0 ? -6 : 1);
    const startDate = new Date(now);
    startDate.setDate(diff);
    const endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    return {
      start: getVnDateParts(startDate).ymd,
      end: getVnDateParts(endDate).ymd
    };
  }
  if (timeRange === 'year') {
    return { start: `${nowParts.year}-01-01`, end: `${nowParts.year}-12-31` };
  }
  const lastDay = new Date(nowParts.year, nowParts.month, 0).getDate();
  return {
    start: `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-01`,
    end: `${nowParts.year}-${String(nowParts.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  };
}

function isDateInRange(dateInput, range = getDashboardDateRange()) {
  if (!range) return true;
  const parts = getVnDateParts(dateInput);
  if (!parts) return false;
  return parts.ymd >= range.start && parts.ymd <= range.end;
}

function isValidDashboardOrder(order) {
  const status = String(order?.status || 'settled').toLowerCase();
  return VALID_REVENUE_STATUSES.has(status) && !order.deletedAt && !order.deleted_at && !order.isDeleted;
}

function getOrderCompanyId(order) {
  return normalizeCompanyId(order?.companyId || order?.company_id || 'ABS_NORTH');
}

function getItemRevenueCompanyId(item, orderCompanyId) {
  const pBrand = getCanonicalBrandName(item.productBrand || item.brand || 'COVA NANO', state.brands);
  const rBrand = getCanonicalBrandName(item.revenueBrand || pBrand, state.brands);
  // Công ty nhận doanh thu được xác định từ thương hiệu của từng dòng hàng.
  // Không dùng công ty của người lập/chốt đơn vì một đơn có thể chứa nhãn của
  // công ty khác với công ty của nhân viên thao tác.
  return normalizeCompanyId(getCompanyIdByBrand(rBrand, state.brands), rBrand);
}

function getOrderManagedSalesperson(order) {
  const customerId = order?.customerId || order?.customer_id;
  const customer = (state.customers || []).find(c => String(c.id) === String(customerId));
  return normalizeKey(customer?.managedBy || customer?.managed_by || order?.customerManagerId || order?.customer_manager_id || order?.managedBy);
}

function orderMatchesDashboardCompany(order, companyId) {
  if (!companyId || companyId === 'all') return true;
  const selectedCompanyId = normalizeCompanyId(companyId);
  if (getOrderCompanyId(order) === selectedCompanyId) return true;
  return (order.items || []).some(item => getItemRevenueCompanyId(item, getOrderCompanyId(order)) === selectedCompanyId);
}

function isValidReturn(ret) {
  const status = String(ret?.status || 'completed').toLowerCase();
  return status !== 'cancelled' && status !== 'canceled' && status !== 'draft' && !ret.deletedAt && !ret.deleted_at;
}

function getItemGross(item) {
  const qty = toNumber(item.quantity);
  const price = toNumber(item.price ?? item.unitPrice ?? item.refundPrice);
  const discountPercent = toNumber(item.discountPercent);
  if (item.subtotal !== undefined && item.subtotal !== null && item.subtotal !== '') return toNumber(item.subtotal);
  return Math.max(0, qty * price * (1 - discountPercent / 100));
}

function getOrderDiscountRatio(order) {
  const itemsSubtotal = (order.items || []).reduce((sum, item) => sum + getItemGross(item), 0);
  const payable = toNumber(order.totalPayable ?? order.total_payable ?? order.netRevenue ?? order.totalAmount);
  if (itemsSubtotal > 0 && payable > 0) return Math.min(1, payable / itemsSubtotal);
  return 1;
}

function getOrderRevenueRows(order, sign = 1) {
  const ratio = sign > 0 ? getOrderDiscountRatio(order) : 1;
  const orderCompany = getOrderCompanyId(order);
  const custObj = (state.customers || []).find(c => String(c.id) === String(order.customerId || order.customer_id));
  const spKey = getOrderManagedSalesperson(order);
  const custKey = normalizeKey(order.customerId || order.customer_id || (custObj ? custObj.id : ''), 'walkin');
  const customerName = order.customerName || (custObj ? custObj.name : 'Khách lẻ');

  return (order.items || []).map(item => {
    const qty = toNumber(item.quantity);
    const gross = sign > 0 ? getItemGross(item) * ratio : toNumber(item.subtotal ?? (toNumber(item.refundPrice) * qty));
    const rawPBrand = item.productBrand || item.brand || 'COVA NANO';
    const pBrand = getCanonicalBrandName(rawPBrand, state.brands);
    const rBrand = getCanonicalBrandName(item.revenueBrand || pBrand, state.brands);
    const rCompany = getItemRevenueCompanyId(item, orderCompany);

    return {
      orderId: order.id || order.saleId || order.orderId,
      date: order.date || order.returnDate || order.createdAt,
      amount: Math.round(Math.max(0, gross)) * sign,
      quantity: sign > 0 ? qty : 0,
      productKey: item.productId || item.productCode || item.code || item.name || 'Unknown',
      productName: item.productName || item.name || item.product?.name || item.productId || 'Sản phẩm không tên',
      pBrand,
      rBrand,
      rCompany,
      spKey,
      custKey,
      customerName
    };
  }).filter(row => row.amount || row.quantity);
}

function matchesDashboardBrand(row) {
  const fBrand = state.dashboardFilter.brand || 'all';
  if (fBrand === 'all') return true;
  return getCanonicalBrandName(row.rBrand, state.brands).toLowerCase() === getCanonicalBrandName(fBrand, state.brands).toLowerCase();
}

function getFilteredDashboardReturns(filteredOrders) {
  const range = getDashboardDateRange();
  const filteredOrderIds = new Set((filteredOrders || []).map(o => String(o.id)));
  const candidateOrders = (state.savedOrders || []).filter(isValidDashboardOrder);
  return (state.salesReturns || []).filter(ret => {
    if (!isValidReturn(ret)) return false;
    if (!isDateInRange(ret.returnDate || ret.createdAt || ret.date, range)) return false;
    const sourceOrder = candidateOrders.find(o => String(o.id) === String(ret.saleId || ret.orderId));
    if (ret.saleId || ret.orderId) {
      if (!sourceOrder) return false;
      if (!filteredOrderIds.has(String(ret.saleId || ret.orderId))) return false;
    }
    if (state.dashboardFilter.customerId && state.dashboardFilter.customerId !== 'all' && String(ret.customerId) !== String(state.dashboardFilter.customerId)) return false;
    if (state.dashboardFilter.saleUser && state.dashboardFilter.saleUser !== 'all') {
      const retSale = getOrderManagedSalesperson(sourceOrder || ret);
      if (!isSameUser(retSale, state.dashboardFilter.saleUser)) return false;
    }
    return true;
  });
}

function buildDashboardRevenueRows(filteredOrders) {
  const rows = filteredOrders.flatMap(order => getOrderRevenueRows(order, 1));
  if (state.dashboardSalesMode !== 'gross') {
    const returns = getFilteredDashboardReturns(filteredOrders);
    returns.forEach(ret => {
      const sourceOrder = (state.savedOrders || []).find(o => String(o.id) === String(ret.saleId || ret.orderId)) || {};
      rows.push(...getOrderRevenueRows({
        ...sourceOrder,
        ...ret,
        id: ret.saleId || ret.orderId || ret.id,
        companyId: ret.companyId || sourceOrder.companyId,
        customerId: ret.customerId || sourceOrder.customerId,
        customerName: ret.customerName || sourceOrder.customerName,
        salespersonId: ret.salespersonId || sourceOrder.salespersonId,
        createdBy: ret.createdBy || sourceOrder.createdBy,
        date: ret.returnDate || ret.createdAt || ret.date
      }, -1));
    });
  }
  const selectedCompanyId = state.dashboardFilter.companyId || 'all';
  return rows
    .filter(row => selectedCompanyId === 'all' || row.rCompany === normalizeCompanyId(selectedCompanyId))
    .filter(matchesDashboardBrand);
}

export function saveDashboardFilterToStorage() {
  try {
    tenantStorage.setItem('billing_system_dashboard_filter', JSON.stringify({
      filter: state.dashboardFilter,
      mode: state.dashboardSalesMode,
      companyScopeVersion: DASHBOARD_COMPANY_SCOPE_VERSION,
      companyScopeActor: dashboardCompanyScopeActor()
    }));
  } catch (e) {}
}

export function loadDashboardFilterFromStorage() {
  try {
    const stored = tenantStorage.getItem('billing_system_dashboard_filter');
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed.filter) {
        const allowedFilterKeys = new Set(['timeRange', 'startDate', 'endDate', 'companyId', 'brand', 'saleUser', 'customerId']);
        const persistedFilter = Object.fromEntries(
          Object.entries(parsed.filter).filter(([key]) => allowedFilterKeys.has(key))
        );
        state.dashboardFilter = { ...state.dashboardFilter, ...persistedFilter };
      }
      // Older Accounting sessions were silently pinned to the profile's
      // company. Start the expanded finance scope at "all" once, while still
      // preserving later company choices made through the visible filter.
      if (state.currentUser?.role === 'accounting'
        && (parsed.companyScopeVersion !== DASHBOARD_COMPANY_SCOPE_VERSION
          || parsed.companyScopeActor !== dashboardCompanyScopeActor())) {
        state.dashboardFilter.companyId = 'all';
      }
      if (parsed.mode) {
        state.dashboardSalesMode = parsed.mode;
      }
    }
  } catch (e) {}
}

let isFilterLoaded = false;

export function populateDashboardFilters() {
  if (!isFilterLoaded) {
    loadDashboardFilterFromStorage();
    isFilterLoaded = true;
  }
  const companySelect = document.getElementById('dashboard-company-filter');
  const companyGroup = document.getElementById('dashboard-company-filter-group');
  const brandSelect = document.getElementById('dashboard-brand-filter');
  const timeSelect = document.getElementById('dashboard-time-filter');
  const modeSelect = document.getElementById('dashboard-sales-mode-filter');

  const currUser = state.currentUser;

  // 0. Thời gian & Mode
  if (timeSelect) timeSelect.value = state.dashboardFilter.timeRange || 'month';
  if (modeSelect) modeSelect.value = state.dashboardSalesMode || 'net';

  // 1. Công ty
  if (companySelect) {
    if (currUser && !canViewAllDashboardCompanies(currUser)) {
      const userCompId = getUserCompanyId(currUser);
      if (companyGroup) companyGroup.style.display = 'none';
      state.dashboardFilter.companyId = userCompId;
    } else {
      if (companyGroup) companyGroup.style.display = 'flex';
      const compOpts = (state.companies || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
      companySelect.innerHTML = `<option value="all">-- Tất cả công ty --</option>${compOpts}`;
      companySelect.value = state.dashboardFilter.companyId || 'all';
    }
  }

  // 2. Thương hiệu (lọc theo công ty được chọn và thương hiệu dùng chung)
  const selectedCompId = state.dashboardFilter.companyId || 'all';

  const allBrandsSet = new Set();
  (state.brands || []).forEach(b => {
    if (!b.name) return;
    if (selectedCompId === 'all') {
      allBrandsSet.add(b.name);
    } else {
      const bCompId = b.companyId || '';
      const isShared = !bCompId || bCompId === 'shared' || b.companyName === 'Dùng chung';
      if (bCompId === selectedCompId || isShared) {
        allBrandsSet.add(b.name);
      }
    }
  });

  (state.products || []).forEach(p => {
    if (!p.brand) return;
    if (selectedCompId === 'all') {
      allBrandsSet.add(p.brand);
    } else {
      const foundBrand = (state.brands || []).find(b => b.name && b.name.toLowerCase() === p.brand.toLowerCase());
      const bCompId = foundBrand ? (foundBrand.companyId || '') : '';
      const isShared = !bCompId || bCompId === 'shared' || (foundBrand && foundBrand.companyName === 'Dùng chung');
      if (!foundBrand || bCompId === selectedCompId || isShared) {
        allBrandsSet.add(p.brand);
      }
    }
  });

  const cleanBrands = Array.from(allBrandsSet);

  const brandOptions = cleanBrands.map(b => `<option value="${b}">${b}</option>`).join('');

  if (brandSelect) {
    brandSelect.innerHTML = `<option value="all">-- Tất cả thương hiệu --</option>${brandOptions}`;
    if (cleanBrands.includes(state.dashboardFilter.brand)) {
      brandSelect.value = state.dashboardFilter.brand;
    } else {
      state.dashboardFilter.brand = 'all';
      brandSelect.value = 'all';
    }
  }

  if (state.dashboardFilter.customerId !== 'all'
    && (state.customers || []).length > 0
    && !(state.customers || []).some(customer => String(customer.id) === String(state.dashboardFilter.customerId))) {
    state.dashboardFilter.customerId = 'all';
  }

  // 3. Nhân viên Sale (Ẩn nếu là Sale đăng nhập)
  const saleGroup = document.getElementById('dashboard-sale-filter-group');
  if (currUser && currUser.role === 'sale') {
    if (saleGroup) saleGroup.style.display = 'none';
    state.dashboardFilter.saleUser = currUser.username;
  } else if (saleGroup) {
    saleGroup.style.display = 'flex';
  }
}

export function getFilteredDashboardOrders() {
  let orders = (state.savedOrders || []).filter(isValidDashboardOrder);
  const currUser = state.currentUser;

  if (currUser) {
    const userCompanyId = getUserCompanyId(currUser);
    if (currUser.role === 'sale') {
      orders = orders.filter(o => isSameUser(getOrderManagedSalesperson(o), currUser.username) && orderMatchesDashboardCompany(o, userCompanyId));
    } else if (canViewAllDashboardCompanies(currUser) && state.dashboardFilter.companyId && state.dashboardFilter.companyId !== 'all') {
      orders = orders.filter(o => orderMatchesDashboardCompany(o, state.dashboardFilter.companyId));
    } else if (currUser.role === 'manager') {
      orders = orders.filter(o => orderMatchesDashboardCompany(o, userCompanyId));
    }
  }

  if (state.dashboardFilter.saleUser && state.dashboardFilter.saleUser !== 'all') {
    orders = orders.filter(o => isSameUser(getOrderManagedSalesperson(o), state.dashboardFilter.saleUser));
  }

  if (state.dashboardFilter.customerId && state.dashboardFilter.customerId !== 'all') {
    orders = orders.filter(o => String(o.customerId || o.customer_id) === String(state.dashboardFilter.customerId));
  }

  return orders.filter(order => isDateInRange(order.date || order.createdAt));
}
export function renderRevenueChart(orders) {
  const chartCanvas = document.getElementById('revenue-chart');
  if (!chartCanvas) return;
  const ctx = chartCanvas.getContext('2d');
  if (revenueChartInstance) revenueChartInstance.destroy();

  const rows = buildDashboardRevenueRows(orders || []);
  let labels = [];
  let dataPoints = [];
  const nowParts = getVnDateParts(new Date());
  const view = state.dashboardChartView;

  if (view === 'day') {
    labels = Array.from({ length: 12 }, (_, i) => `${String(i * 2).padStart(2, '0')}:00`);
    dataPoints = Array(12).fill(0);
    rows.forEach(row => {
      const d = new Date(row.date);
      const parts = getVnDateParts(d);
      if (parts && nowParts && parts.ymd === nowParts.ymd) {
        const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone: VN_TIMEZONE, hour: '2-digit', hour12: false }).format(d));
        const bucket = Math.floor(hour / 2);
        if (bucket >= 0 && bucket < 12) dataPoints[bucket] += row.amount;
      }
    });
  } else if (view === 'week') {
    labels = ['Thứ 2', 'Thứ 3', 'Thứ 4', 'Thứ 5', 'Thứ 6', 'Thứ 7', 'Chủ nhật'];
    dataPoints = Array(7).fill(0);
    const range = getDashboardDateRange();
    rows.forEach(row => {
      const parts = getVnDateParts(row.date);
      if (!parts || !range) return;
      const dayDiff = Math.floor((new Date(`${parts.ymd}T00:00:00+07:00`) - new Date(`${range.start}T00:00:00+07:00`)) / 86400000);
      if (dayDiff >= 0 && dayDiff < 7) dataPoints[dayDiff] += row.amount;
    });
  } else if (view === 'month') {
    const year = nowParts.year;
    const month = nowParts.month;
    const numDays = new Date(year, month, 0).getDate();
    labels = Array.from({ length: numDays }, (_, i) => `${i + 1}`);
    dataPoints = Array(numDays).fill(0);
    rows.forEach(row => {
      const parts = getVnDateParts(row.date);
      if (parts && parts.year === year && parts.month === month && parts.day >= 1 && parts.day <= numDays) {
        dataPoints[parts.day - 1] += row.amount;
      }
    });
  } else if (view === 'year') {
    labels = ['Th 1', 'Th 2', 'Th 3', 'Th 4', 'Th 5', 'Th 6', 'Th 7', 'Th 8', 'Th 9', 'Th 10', 'Th 11', 'Th 12'];
    dataPoints = Array(12).fill(0);
    rows.forEach(row => {
      const parts = getVnDateParts(row.date);
      if (parts && parts.year === nowParts.year) dataPoints[parts.month - 1] += row.amount;
    });
  }

  revenueChartInstance = new Chart(ctx, {
    type: 'line',
    data: { labels, datasets: [{ label: 'Doanh thu', data: dataPoints, borderColor: '#0057cd', borderWidth: 2.5, pointBackgroundColor: '#ffffff', pointBorderColor: '#0057cd', pointBorderWidth: 2, pointRadius: 2.5, pointHoverRadius: 4, tension: 0, fill: true, backgroundColor: 'rgba(177, 197, 255, 0.28)' }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      transitions: { active: { animation: { duration: 0 } }, resize: { animation: { duration: 0 } } },
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { display: false }, tooltip: { ...DASHBOARD_CHART_TOOLTIP, displayColors: false, callbacks: { label: context => `Doanh thu: ${formatCurrency(context.raw)}` } } },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: DASHBOARD_CHART_TEXT, maxRotation: 0, padding: 8, font: { family: DASHBOARD_CHART_FONT, size: 10, weight: '500' } } },
        y: { beginAtZero: true, grid: { color: DASHBOARD_CHART_GRID, drawTicks: false }, border: { display: false }, ticks: { color: DASHBOARD_CHART_TEXT, padding: 9, font: { family: DASHBOARD_CHART_FONT, size: 10, weight: '500' }, callback: value => value >= 1e6 ? `${(value / 1e6).toFixed(1)}M ₫` : value >= 1e3 ? `${(value / 1e3).toFixed(0)}k ₫` : `${value} ₫` } }
      }
    }
  });
}

export function renderTopProducts(orders) {
  const topProductsList = document.getElementById('top-products-list');
  if (!topProductsList) return;

  const salesMap = {};
  buildDashboardRevenueRows(orders || []).filter(row => row.quantity > 0).forEach(row => {
    if (!salesMap[row.productKey]) salesMap[row.productKey] = { code: row.productKey, name: row.productName, quantity: 0, revenue: 0 };
    salesMap[row.productKey].quantity += row.quantity;
    salesMap[row.productKey].revenue += row.amount;
  });

  const salesList = Object.values(salesMap);
  if (salesList.length === 0) {
    topProductsList.innerHTML = `<div style="text-align: center; color: var(--text-muted); padding: 3rem; font-size: 0.9rem;">Chưa có dữ liệu bán hàng trong khoảng thời gian này</div>`;
    return;
  }

  salesList.sort((a, b) => b.quantity - a.quantity);
  const top5 = salesList.slice(0, 5);
  const maxQty = top5[0].quantity || 1;
  topProductsList.innerHTML = top5.map((p, rankIdx) => {
    const percent = Math.round((p.quantity / maxQty) * 100);
    const rankBadge = rankIdx === 0
      ? '<span class="top-product-rank rank-1" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#fef3c7;color:#b45309;font-weight:800;font-size:0.75rem;border:1px solid #fde68a;">1</span>'
      : (rankIdx === 1
        ? '<span class="top-product-rank rank-2" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#f1f5f9;color:#475569;font-weight:800;font-size:0.75rem;border:1px solid #cbd5e1;">2</span>'
        : (rankIdx === 2
          ? '<span class="top-product-rank rank-3" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#ffedd5;color:#c2410c;font-weight:800;font-size:0.75rem;border:1px solid #fed7aa;">3</span>'
          : `<span class="top-product-rank" style="display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#f8fafc;color:#94a3b8;font-weight:700;font-size:0.75rem;border:1px solid #e2e8f0;">${rankIdx + 1}</span>`));
    return `<div class="top-product-item"><div class="top-product-info"><div style="display:flex;align-items:center;gap:0.4rem;min-width:0;">${rankBadge}<span class="top-product-name" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span></div><span class="top-product-sales">${p.quantity} đã bán</span></div><div class="top-product-progress-bg"><div class="top-product-progress-bar" style="width: ${percent}%;"></div></div><div class="top-product-meta"><span>Mã: ${escapeHtml(p.code)}</span><span style="font-weight: 600; color: #0e9f67;">${formatCurrency(p.revenue)}</span></div></div>`;
  }).join('');
}
function formatCompactDashboardCurrency(value) {
  const amount = Number(value || 0);
  const absolute = Math.abs(amount);
  if (absolute >= 1e9) return `${(amount / 1e9).toFixed(1)} tỷ`;
  if (absolute >= 1e6) return `${(amount / 1e6).toFixed(0)} tr`;
  if (absolute >= 1e3) return `${(amount / 1e3).toFixed(0)} nghìn`;
  return `${amount}`;
}

function renderDashboardBreakdownChart({
  key,
  canvasId,
  emptyId,
  metaId,
  rows,
  labelResolver = rowKey => rowKey,
  type = 'bar',
  limit = 8,
  metaLabel = 'mục'
}) {
  const canvas = document.getElementById(canvasId);
  const emptyState = document.getElementById(emptyId);
  const meta = document.getElementById(metaId);
  const previousChart = dashboardBreakdownCharts.get(key);
  if (previousChart) {
    previousChart.destroy();
    dashboardBreakdownCharts.delete(key);
  }

  const normalizedRows = (rows || [])
    .map(row => ({ ...row, amount: Number(row.amount || 0), label: String(labelResolver(row.key, row) || row.key || 'Chưa xác định') }))
    .filter(row => Number.isFinite(row.amount) && row.amount !== 0)
    .sort((a, b) => b.amount - a.amount);
  const displayedRows = normalizedRows.slice(0, limit);

  if (meta) {
    meta.textContent = type === 'doughnut'
      ? `${normalizedRows.length} ${metaLabel}`
      : (normalizedRows.length > limit ? `Top ${limit}/${normalizedRows.length}` : `${normalizedRows.length} ${metaLabel}`);
  }

  if (!canvas || !globalThis.Chart || displayedRows.length === 0) {
    if (canvas) canvas.style.display = 'none';
    if (emptyState) emptyState.style.display = 'flex';
    return;
  }

  canvas.style.display = 'block';
  if (emptyState) emptyState.style.display = 'none';
  const labels = displayedRows.map(row => row.label);
  const amounts = displayedRows.map(row => type === 'doughnut' ? Math.max(0, row.amount) : row.amount);
  const commonTooltip = {
    ...DASHBOARD_CHART_TOOLTIP,
    callbacks: { label: context => `${context.label}: ${formatCurrency(context.raw)}` }
  };

  const isDoughnut = type === 'doughnut';
  const chart = new globalThis.Chart(canvas.getContext('2d'), {
    type,
    data: {
      labels,
      datasets: [{
        label: 'Doanh thu',
        data: amounts,
        backgroundColor: displayedRows.map((_, index) => DASHBOARD_CHART_COLORS[index % DASHBOARD_CHART_COLORS.length]),
        borderColor: isDoughnut ? '#ffffff' : 'transparent',
        borderWidth: isDoughnut ? 3 : 0,
        borderRadius: isDoughnut ? 0 : 5,
        borderSkipped: false,
        hoverOffset: 0,
        maxBarThickness: 24
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      indexAxis: isDoughnut ? undefined : 'y',
      cutout: isDoughnut ? '68%' : undefined,
      layout: { padding: isDoughnut ? 4 : { right: 14 } },
      plugins: {
        legend: isDoughnut
          ? { position: 'bottom', labels: { usePointStyle: true, pointStyle: 'circle', boxWidth: 7, boxHeight: 7, padding: 12, color: '#475467', font: { family: DASHBOARD_CHART_FONT, size: 10, weight: '500' } } }
          : { display: false },
        tooltip: commonTooltip
      },
      scales: isDoughnut ? undefined : {
        x: {
          beginAtZero: true,
          grid: { color: DASHBOARD_CHART_GRID, drawTicks: false },
          border: { display: false },
          ticks: { color: DASHBOARD_CHART_TEXT, maxTicksLimit: 5, padding: 8, callback: value => formatCompactDashboardCurrency(value), font: { family: DASHBOARD_CHART_FONT, size: 10, weight: '500' } }
        },
        y: {
          grid: { display: false },
          border: { display: false },
          ticks: { color: '#344054', autoSkip: false, padding: 7, font: { family: DASHBOARD_CHART_FONT, size: 10, weight: '500' }, callback: (_value, index) => labels[index]?.length > 24 ? `${labels[index].slice(0, 23)}…` : labels[index] }
        }
      },
      animation: false
    }
  });
  dashboardBreakdownCharts.set(key, chart);
}

function renderServerRevenueChart(payload) {
  const chartCanvas = document.getElementById('revenue-chart');
  if (!chartCanvas || !globalThis.Chart) return;
  const salesModeLabel = state.dashboardSalesMode === 'gross' ? 'Doanh số gốc' : 'Doanh số ròng';
  const chartSeries = buildDashboardChartSeries(payload?.series || [], state.dashboardChartView, payload?.period || {});

  if (revenueChartInstance) {
    revenueChartInstance.data.labels = chartSeries.labels;
    revenueChartInstance.data.datasets[0].label = salesModeLabel;
    revenueChartInstance.data.datasets[0].data = chartSeries.dataPoints;
    revenueChartInstance.update();
    return;
  }

  const chartContext = chartCanvas.getContext('2d');
  revenueChartInstance = new Chart(chartContext, {
    type: 'line',
    data: { labels: chartSeries.labels, datasets: [{ label: salesModeLabel, data: chartSeries.dataPoints, borderColor: '#0057cd', backgroundColor: 'rgba(177, 197, 255, 0.28)', borderWidth: 2.5, pointBackgroundColor: '#ffffff', pointBorderColor: '#0057cd', pointBorderWidth: 2, pointRadius: 2.5, pointHoverRadius: 4, tension: 0, fill: true }] },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      transitions: { active: { animation: { duration: 0 } }, resize: { animation: { duration: 0 } } },
      interaction: { intersect: false, mode: 'index' },
      plugins: { legend: { display: false }, tooltip: { ...DASHBOARD_CHART_TOOLTIP, displayColors: false, callbacks: { label: context => `${salesModeLabel}: ${formatCurrency(context.raw)}` } } },
      scales: {
        x: { grid: { display: false }, border: { display: false }, ticks: { color: DASHBOARD_CHART_TEXT, maxRotation: 0, padding: 8, font: { family: DASHBOARD_CHART_FONT, size: 10, weight: '500' } } },
        y: { beginAtZero: true, grid: { color: DASHBOARD_CHART_GRID, drawTicks: false }, border: { display: false }, ticks: { color: DASHBOARD_CHART_TEXT, padding: 9, callback: value => formatCompactDashboardCurrency(value), font: { family: DASHBOARD_CHART_FONT, size: 10, weight: '500' } } }
      }
    }
  });
}

function dashboardRequestFiltersForRange(timeRange) {
  const range = getDashboardDateRange(timeRange);
  const endExclusive = range?.end ? new Date(`${range.end}T00:00:00+07:00`) : null;
  if (endExclusive) endExclusive.setDate(endExclusive.getDate() + 1);
  return {
    start: range?.start ? `${range.start}T00:00:00+07:00` : null,
    end: endExclusive?.toISOString() || null,
    company_id: state.dashboardFilter.companyId || 'all',
    brand_id: state.dashboardFilter.brand || 'all',
    salesperson_id: state.dashboardFilter.saleUser || 'all',
    customer_id: state.dashboardFilter.customerId || 'all',
    sales_mode: state.dashboardSalesMode || 'net'
  };
}

async function updateRevenueChartForView(view, prefetchedPayload = null) {
  const requestId = ++dashboardChartRequestId;
  try {
    const payload = prefetchedPayload || await dbFetchPhase5Dashboard(dashboardRequestFiltersForRange(view));
    if (requestId !== dashboardChartRequestId || view !== state.dashboardChartView) return;
    renderServerRevenueChart(payload);
  } catch (error) {
    console.error('Revenue chart RPC error:', error);
    showToast('Không tải được dữ liệu biểu đồ doanh thu.', 'danger');
  }
}

function renderServerDashboard(payload) {
  const summary = payload?.summary || {};
  const setText = (id, value) => { const element = document.getElementById(id); if (element) element.innerText = value; };
  const setKpiContext = (id, value, tone = 'neutral') => {
    const element = document.getElementById(id);
    if (!element) return;
    element.className = `widget-trend trend-${tone}`;
    element.innerText = value;
  };
  const periodLabel = state.dashboardFilter.timeRange === 'custom'
    ? '(Tùy chỉnh)'
    : state.dashboardFilter.timeRange === 'day'
      ? '(Hôm nay)'
      : state.dashboardFilter.timeRange === 'week'
        ? '(Tuần này)'
        : state.dashboardFilter.timeRange === 'year'
          ? '(Năm nay)'
          : '(Tháng này)';
  const salesModeLabel = state.dashboardSalesMode === 'gross' ? 'Doanh số gốc' : 'Doanh số ròng';
  setText('stat-revenue-label', `${salesModeLabel} ${periodLabel}`);
  setText('stat-sold-products-label', `Sản phẩm đã bán ${periodLabel}`);
  setText('stat-total-revenue', formatCurrency(state.dashboardSalesMode === 'gross' ? summary.gross_sales : summary.net_sales));
  setText('stat-total-orders', summary.order_count || 0);
  setText('stat-total-debt', formatCurrency(summary.current_debt));
  setText('stat-total-sold-products', summary.sold_quantity || 0);
  const orderCount = Number(summary.order_count || 0);
  const soldQuantity = Number(summary.sold_quantity || 0);
  const currentDebt = Number(summary.current_debt || 0);
  setKpiContext('stat-revenue-context', orderCount ? `Doanh số theo ${periodLabel.slice(1, -1).toLowerCase()}` : 'Chưa có đơn hàng trong kỳ');
  setKpiContext('stat-orders-context', orderCount ? `${orderCount} đơn hợp lệ trong kỳ` : 'Chưa phát sinh đơn hàng');
  setKpiContext('stat-debt-context', currentDebt > 0 ? 'Cần theo dõi công nợ hiện tại' : 'Không có công nợ cần thu', currentDebt > 0 ? 'warning' : 'up');
  setKpiContext('stat-products-context', soldQuantity ? `${soldQuantity} sản phẩm đã bán trong kỳ` : 'Chưa có sản phẩm bán');
  renderDashboardBreakdownChart({ key: 'company', canvasId: 'company-revenue-chart', emptyId: 'company-revenue-chart-empty', metaId: 'company-revenue-chart-meta', rows: payload.by_company, labelResolver: companyId => getCompanyNameById(companyId, state.companies), type: 'doughnut', limit: 6, metaLabel: 'công ty' });
  renderDashboardBreakdownChart({ key: 'brand', canvasId: 'brand-revenue-chart', emptyId: 'brand-revenue-chart-empty', metaId: 'brand-revenue-chart-meta', rows: payload.by_brand, labelResolver: brandId => (state.brands || []).find(brand => String(brand.id) === String(brandId))?.name || brandId, limit: 8, metaLabel: 'thương hiệu' });
  renderDashboardBreakdownChart({ key: 'salesperson', canvasId: 'salesperson-revenue-chart', emptyId: 'salesperson-revenue-chart-empty', metaId: 'salesperson-revenue-chart-meta', rows: filterLoginEmployeeRevenueRows(payload.by_salesperson, state.users), labelResolver: userId => getUserDisplayName(userId, 'Chưa phân công', state.users), limit: 8, metaLabel: 'nhân viên' });
  renderDashboardBreakdownChart({ key: 'customer', canvasId: 'customer-revenue-chart', emptyId: 'customer-revenue-chart-empty', metaId: 'customer-revenue-chart-meta', rows: payload.by_customer, labelResolver: (_customerId, row) => row.name || row.key, limit: 8, metaLabel: 'khách hàng' });

  const topProducts = document.getElementById('top-products-list');
  if (topProducts) {
    topProducts.innerHTML = payload.top_skus?.length ? payload.top_skus.slice(0, 5).map(item => `<div class="top-product-item"><div class="top-product-info"><span class="top-product-name">${escapeHtml(item.name || item.code)}</span><span class="top-product-sales">${Number(item.quantity || 0)} đã bán</span></div><div class="top-product-meta"><span>Mã: ${escapeHtml(item.code)}</span><span>${formatCurrency(item.amount)}</span></div></div>`).join('')
      : '<div style="text-align:center;color:var(--text-muted);padding:2rem">Không có dữ liệu bán hàng</div>';
  }
  const recentBody = document.getElementById('dashboard-recent-orders-body');
  if (recentBody) {
    recentBody.innerHTML = payload.recent_orders?.length ? payload.recent_orders.map(order => `<tr><td style="font-weight:600">${escapeHtml(order.id)}</td><td>${new Date(order.order_date).toLocaleDateString('vi-VN')}</td><td>${escapeHtml(order.customer_name)}</td><td style="text-align:right">${formatCurrency(order.net_revenue)}</td><td style="text-align:center"><button class="btn btn-secondary btn-sm dash-view-order-btn" data-id="${escapeHtml(order.id)}"><i data-lucide="eye"></i></button></td></tr>`).join('')
      : '<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:2rem">Không có đơn hàng phù hợp</td></tr>';
  }
  document.querySelectorAll('.dash-view-order-btn').forEach(button => button.addEventListener('click', () => {
    switchTab('history-panel');
    const search = document.getElementById('order-search-input');
    if (search) { search.value = button.dataset.id; search.dispatchEvent(new Event('input')); }
  }));
  safeCreateIcons();
}

export async function updateDashboardStats({ force = false } = {}) {
  renderOnboardingChecklist();
  populateDashboardFilters();
  const filters = dashboardRequestFiltersForRange(state.dashboardFilter.timeRange || 'month');
  const requestKey = JSON.stringify(filters);
  const renderPayload = async payload => {
    renderServerDashboard(payload);
    const canReusePayload = state.dashboardFilter.timeRange !== 'custom'
      && state.dashboardChartView === state.dashboardFilter.timeRange;
    await updateRevenueChartForView(state.dashboardChartView, canReusePayload ? payload : null);
    return payload;
  };

  if (!force
      && dashboardStatsCache.key === requestKey
      && dashboardStatsCache.payload
      && Date.now() - dashboardStatsCache.cachedAt < DASHBOARD_STATS_CACHE_MS) {
    return renderPayload(dashboardStatsCache.payload);
  }
  if (!force && dashboardStatsInFlight && dashboardStatsInFlightKey === requestKey) {
    return dashboardStatsInFlight;
  }

  const request = (async () => {
    try {
      const payload = await dbFetchPhase5Dashboard(filters);
      dashboardStatsCache = { key: requestKey, payload, cachedAt: Date.now() };
      return await renderPayload(payload);
    } catch (error) {
      console.error('Phase 5 dashboard RPC error:', error);
      ['stat-total-revenue', 'stat-total-orders', 'stat-total-debt', 'stat-total-sold-products'].forEach(id => {
        const element = document.getElementById(id); if (element) element.innerText = '—';
      });
      showToast('Không tải được dashboard từ cơ sở dữ liệu. Kiểm tra migration 0012.', 'danger');
      return null;
    }
  })();
  dashboardStatsInFlight = request;
  dashboardStatsInFlightKey = requestKey;
  try {
    return await request;
  } finally {
    if (dashboardStatsInFlight === request) {
      dashboardStatsInFlight = null;
      dashboardStatsInFlightKey = '';
    }
  }
}

function updateDashboardStatsLegacy() {
  populateDashboardFilters();
  const filteredOrders = getFilteredDashboardOrders();

  let userCustomers = state.customers;
  if (state.currentUser && state.currentUser.role === 'sale') {
    userCustomers = state.customers.filter(c => isSameUser(c.managedBy, state.currentUser.username));
  } else if (state.dashboardFilter.saleUser && state.dashboardFilter.saleUser !== 'all') {
    userCustomers = state.customers.filter(c => isSameUser(c.managedBy, state.dashboardFilter.saleUser));
  }
  if (state.dashboardFilter.customerId && state.dashboardFilter.customerId !== 'all') {
    userCustomers = userCustomers.filter(customer => String(customer.id) === String(state.dashboardFilter.customerId));
  }

  const labelSuffix = state.dashboardFilter.timeRange === 'custom' 
    ? '(Tùy chỉnh)' 
    : state.dashboardFilter.timeRange === 'day' 
      ? '(Hôm nay)' 
      : state.dashboardFilter.timeRange === 'week' 
        ? '(Tuần này)' 
        : state.dashboardFilter.timeRange === 'year' 
          ? '(Năm nay)' 
          : '(Tháng này)';
  
  const revLabel = document.getElementById('stat-revenue-label');
  if (revLabel) revLabel.innerText = `Doanh thu tích lũy ${labelSuffix}`;
  
  const soldLabel = document.getElementById('stat-sold-products-label');
  if (soldLabel) soldLabel.innerText = `Sản phẩm đã bán ${labelSuffix}`;

  let totalSoldProducts = 0;
  const companyRevenueMap = {};
  const brandRevenueMap = {};
  const salespersonRevenueMap = {};
  const customerRevenueMap = {};
  const customerNameMap = {};

  const revenueRows = buildDashboardRevenueRows(filteredOrders);
  let actualRevenue = 0;
  revenueRows.forEach(row => {
    actualRevenue += row.amount;
    totalSoldProducts += row.quantity;
    companyRevenueMap[row.rCompany] = (companyRevenueMap[row.rCompany] || 0) + row.amount;
    brandRevenueMap[row.rBrand] = (brandRevenueMap[row.rBrand] || 0) + row.amount;
    salespersonRevenueMap[row.spKey] = (salespersonRevenueMap[row.spKey] || 0) + row.amount;
    customerRevenueMap[row.custKey] = (customerRevenueMap[row.custKey] || 0) + row.amount;
    customerNameMap[row.custKey] = row.customerName;
  });
  const totalOrdersCount = filteredOrders.length;
  const totalDebt = userCustomers.reduce((sum, c) => sum + (c.debt || 0), 0);

  // Hiển thị thẻ chỉ số
  const revEl = document.getElementById('stat-total-revenue');
  if (revEl) revEl.innerText = formatCurrency(actualRevenue);
  
  const ordEl = document.getElementById('stat-total-orders');
  if (ordEl) ordEl.innerText = totalOrdersCount;
  
  const debtEl = document.getElementById('stat-total-debt');
  if (debtEl) debtEl.innerText = formatCurrency(totalDebt);
  
  const soldEl = document.getElementById('stat-total-sold-products');
  if (soldEl) soldEl.innerText = totalSoldProducts;

  const setKpiContext = (id, value, tone = 'neutral') => {
    const element = document.getElementById(id);
    if (!element) return;
    element.className = `widget-trend trend-${tone}`;
    element.innerText = value;
  };
  setKpiContext('stat-revenue-context', totalOrdersCount ? `Doanh số theo ${labelSuffix.slice(1, -1).toLowerCase()}` : 'Chưa có đơn hàng trong kỳ');
  setKpiContext('stat-orders-context', totalOrdersCount ? `${totalOrdersCount} đơn hợp lệ trong kỳ` : 'Chưa phát sinh đơn hàng');
  setKpiContext('stat-debt-context', totalDebt > 0 ? 'Cần theo dõi công nợ hiện tại' : 'Không có công nợ cần thu', totalDebt > 0 ? 'warning' : 'up');
  setKpiContext('stat-products-context', totalSoldProducts ? `${totalSoldProducts} sản phẩm đã bán trong kỳ` : 'Chưa có sản phẩm bán');

  renderDashboardBreakdownChart({
    key: 'company', canvasId: 'company-revenue-chart', emptyId: 'company-revenue-chart-empty', metaId: 'company-revenue-chart-meta',
    rows: Object.entries(companyRevenueMap).map(([key, amount]) => ({ key, amount })),
    labelResolver: companyId => getCompanyNameById(companyId, state.companies), type: 'doughnut', limit: 6, metaLabel: 'công ty'
  });
  renderDashboardBreakdownChart({
    key: 'brand', canvasId: 'brand-revenue-chart', emptyId: 'brand-revenue-chart-empty', metaId: 'brand-revenue-chart-meta',
    rows: Object.entries(brandRevenueMap).map(([key, amount]) => ({ key, amount })),
    limit: 8, metaLabel: 'thương hiệu'
  });

  renderDashboardBreakdownChart({
    key: 'salesperson', canvasId: 'salesperson-revenue-chart', emptyId: 'salesperson-revenue-chart-empty', metaId: 'salesperson-revenue-chart-meta',
    rows: filterLoginEmployeeRevenueRows(Object.entries(salespersonRevenueMap).map(([key, amount]) => ({ key, amount })), state.users),
    labelResolver: userId => getUserDisplayName(userId, 'Chưa phân công', state.users), limit: 8, metaLabel: 'nhân viên'
  });
  renderDashboardBreakdownChart({
    key: 'customer', canvasId: 'customer-revenue-chart', emptyId: 'customer-revenue-chart-empty', metaId: 'customer-revenue-chart-meta',
    rows: Object.entries(customerRevenueMap).map(([key, amount]) => ({ key, amount, name: customerNameMap[key] })),
    labelResolver: (customerId, row) => row.name || customerId, limit: 8, metaLabel: 'khách hàng'
  });

  // Render recent / filtered orders on dashboard
  const recentOrdersBody = document.getElementById('dashboard-recent-orders-body');
  if (recentOrdersBody) {
    const recent = filteredOrders.slice(0, 10);
    if (recent.length === 0) {
      recentOrdersBody.innerHTML = `
        <tr>
          <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
            Không có đơn hàng nào khớp với bộ lọc
          </td>
        </tr>
      `;
    } else {
      recentOrdersBody.innerHTML = recent.map(o => {
        const itemSummary = o.items.map(item => `${item.productName || (item.product && item.product.name)} x${item.quantity}`).join(', ');
        const compName = getCompanyNameById(o.companyId, state.companies);
        return `
          <tr>
            <td style="font-weight: 600; color: #fff;">${o.id}<div style="font-size: 0.7rem; color: var(--text-muted);">${compName}</div></td>
            <td style="font-size: 0.8rem; color: var(--text-secondary);">${new Date(o.date).toLocaleDateString('vi-VN')}</td>
            <td style="max-width: 230px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${itemSummary}">${itemSummary}</td>
            <td style="text-align: right; font-weight: 600; color: var(--color-primary);">${formatCurrency(buildDashboardRevenueRows([o]).reduce((sum, row) => sum + row.amount, 0))}</td>
            <td style="text-align: center;">
              <button class="btn btn-secondary btn-sm dash-view-order-btn" data-id="${o.id}">
                <i data-lucide="eye" style="width: 12px; height: 12px;"></i>
              </button>
            </td>
          </tr>
        `;
      }).join('');

      document.querySelectorAll('.dash-view-order-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const id = btn.getAttribute('data-id');
          switchTab('history-panel');
          const searchInput = document.getElementById('order-search-input');
          if (searchInput) {
            searchInput.value = id;
            searchInput.dispatchEvent(new Event('input'));
          }
        });
      });
    }
  }

  // Draw revenue chart and top products
  renderRevenueChart(filteredOrders);
  renderTopProducts(filteredOrders);
  safeCreateIcons();
  updateDashboardFilterSummary();
}

export function updateChartViewActiveButton(view) {
  document.querySelectorAll('.chart-view-btn').forEach(btn => {
    if (btn.getAttribute('data-view') === view) {
      btn.classList.remove('btn-secondary');
      btn.classList.add('btn-primary');
    } else {
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-secondary');
    }
  });
}

export function setupDashboardFilters() {
  const timeSelect = document.getElementById('dashboard-time-filter');
  const startDateInput = document.getElementById('dashboard-start-date');
  const endDateInput = document.getElementById('dashboard-end-date');
  const customDatesDiv = document.getElementById('dashboard-custom-dates');
  const companyFilter = document.getElementById('dashboard-company-filter');
  const brandFilter = document.getElementById('dashboard-brand-filter');
  const modeFilter = document.getElementById('dashboard-sales-mode-filter');
  const resetBtn = document.getElementById('btn-reset-dashboard-filters');
  const refreshBtn = document.getElementById('btn-refresh-dashboard-data');

  if (timeSelect) {
    timeSelect.addEventListener('change', () => {
      const val = timeSelect.value;
      state.dashboardFilter.timeRange = val;
      if (val === 'custom') {
        if (customDatesDiv) customDatesDiv.style.display = 'flex';
      } else {
        if (customDatesDiv) customDatesDiv.style.display = 'none';
      }
      saveDashboardFilterToStorage();
      updateDashboardStats();
    });
  }

  if (startDateInput) {
    startDateInput.addEventListener('change', () => {
      state.dashboardFilter.startDate = startDateInput.value;
      saveDashboardFilterToStorage();
      updateDashboardStats();
    });
  }

  if (endDateInput) {
    endDateInput.addEventListener('change', () => {
      state.dashboardFilter.endDate = endDateInput.value;
      saveDashboardFilterToStorage();
      updateDashboardStats();
    });
  }

  if (companyFilter) {
    companyFilter.addEventListener('change', () => {
      state.dashboardFilter.companyId = companyFilter.value;
      saveDashboardFilterToStorage();
      populateDashboardFilters();
      updateDashboardStats();
    });
  }

  if (brandFilter) {
    brandFilter.addEventListener('change', () => {
      state.dashboardFilter.brand = brandFilter.value;
      saveDashboardFilterToStorage();
      updateDashboardStats();
    });
  }

  if (modeFilter) {
    modeFilter.addEventListener('change', () => {
      state.dashboardSalesMode = modeFilter.value;
      saveDashboardFilterToStorage();
      updateDashboardStats();
    });
  }

  if (resetBtn) {
    resetBtn.onclick = () => {
      state.dashboardFilter = {
        timeRange: 'month',
        startDate: '',
        endDate: '',
        companyId: 'all',
        brand: 'all',
        saleUser: 'all',
        customerId: 'all'
      };
      state.dashboardSalesMode = 'net';
      saveDashboardFilterToStorage();
      populateDashboardFilters();
      setupSaleAutocomplete();
      setupCustomerAutocomplete();
      updateDashboardStats();
      showToast('Đã đặt lại toàn bộ bộ lọc về mặc định!');
    };
  }

  if (refreshBtn) {
    refreshBtn.onclick = async () => {
      showToast('Đang làm mới dữ liệu...', 'info');
      await updateDashboardStats({ force: true });
      showToast('Đã làm mới dữ liệu mới nhất!');
    };
  }

  const openFilterBtn = document.getElementById('btn-open-dashboard-filter');
  const closeFilterBtn = document.getElementById('btn-close-dashboard-filter-modal');
  const applyFilterBtn = document.getElementById('btn-apply-dashboard-filters');
  const filterModal = document.getElementById('dashboard-filter-modal');

  if (openFilterBtn) openFilterBtn.onclick = openDashboardFilterModal;
  if (closeFilterBtn) closeFilterBtn.onclick = closeDashboardFilterModal;
  if (applyFilterBtn) {
    applyFilterBtn.onclick = () => {
      closeDashboardFilterModal();
      updateDashboardStats();
    };
  }
  if (filterModal) {
    filterModal.addEventListener('click', (e) => {
      if (e.target === filterModal) closeDashboardFilterModal();
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && filterModal?.classList.contains('active')) {
      closeDashboardFilterModal();
    }
  });

  setupSaleAutocomplete();
  setupCustomerAutocomplete();
  updateDashboardFilterSummary();

  document.querySelectorAll('.chart-view-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.getAttribute('data-view');
      state.dashboardChartView = view;
      updateChartViewActiveButton(view);
      updateRevenueChartForView(view);
    });
  });
}

export function openDashboardFilterModal() {
  const modal = document.getElementById('dashboard-filter-modal');
  if (!modal) return;
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('btn-open-dashboard-filter')?.setAttribute('aria-expanded', 'true');
  safeCreateIcons();
}

export function closeDashboardFilterModal() {
  const modal = document.getElementById('dashboard-filter-modal');
  if (!modal) return;
  modal.classList.remove('active');
  modal.setAttribute('aria-hidden', 'true');
  document.getElementById('btn-open-dashboard-filter')?.setAttribute('aria-expanded', 'false');
}

export function updateDashboardFilterSummary() {
  const timeLabel = document.getElementById('dashboard-summary-time');
  const modeLabel = document.getElementById('dashboard-summary-mode');
  const extraLabel = document.getElementById('dashboard-summary-extra');
  const badge = document.getElementById('dashboard-filter-count');
  const openBtn = document.getElementById('btn-open-dashboard-filter');

  const filter = state.dashboardFilter || {};
  const timeRange = filter.timeRange || 'month';
  const timeNames = {
    month: 'Tháng này',
    day: 'Hôm nay',
    week: 'Tuần này',
    year: 'Năm nay',
    custom: filter.startDate ? `${filter.startDate} → ${filter.endDate || '...'}` : 'Tùy chọn ngày'
  };
  if (timeLabel) timeLabel.textContent = timeNames[timeRange] || 'Tháng này';

  const mode = state.dashboardSalesMode || 'net';
  if (modeLabel) modeLabel.textContent = mode === 'gross' ? 'Doanh số gốc' : 'Doanh số ròng';

  let activeCount = 0;
  const extras = [];

  if (timeRange !== 'month') activeCount++;
  if (mode !== 'net') activeCount++;

  if (filter.companyId && filter.companyId !== 'all') {
    activeCount++;
    const comp = (state.companies || []).find(c => c.id === filter.companyId);
    extras.push(comp ? comp.name : 'Công ty');
  }

  if (filter.brand && filter.brand !== 'all') {
    activeCount++;
    extras.push(filter.brand);
  }

  if (filter.saleUser && filter.saleUser !== 'all') {
    activeCount++;
    const user = (state.users || []).find(u => isSameUser(u.username, filter.saleUser));
    extras.push(user ? user.displayName : filter.saleUser);
  }

  if (filter.customerId && filter.customerId !== 'all') {
    activeCount++;
    const cust = (state.customers || []).find(c => String(c.id) === String(filter.customerId));
    extras.push(cust ? cust.name : 'Khách hàng');
  }

  if (badge) {
    badge.textContent = String(activeCount);
    badge.style.display = activeCount > 0 ? 'inline-flex' : 'none';
  }

  if (openBtn) {
    openBtn.classList.toggle('btn-primary', activeCount > 0);
    openBtn.classList.toggle('btn-secondary', activeCount === 0);
  }

  if (extraLabel) {
    const hasExtras = extras.length > 0;
    extraLabel.textContent = hasExtras ? `+ ${extras.join(', ')}` : '';
    extraLabel.hidden = !hasExtras;
  }
}

let saleDebounceTimer = null;
let customerDebounceTimer = null;

function setupSaleAutocomplete() {
  const input = document.getElementById('dashboard-sale-search-input');
  const clearBtn = document.getElementById('btn-clear-sale-search');
  const list = document.getElementById('dashboard-sale-suggestions');
  if (!input || !list) return;

  const updateInputDisplay = () => {
    if (state.dashboardFilter.saleUser && state.dashboardFilter.saleUser !== 'all') {
      const found = (state.users || []).find(u => isSameUser(u.username, state.dashboardFilter.saleUser));
      input.value = found ? `${found.displayName} (${found.username})` : state.dashboardFilter.saleUser;
      if (clearBtn) clearBtn.style.display = 'block';
    } else {
      input.value = '';
      input.placeholder = '-- Tất cả nhân viên --';
      if (clearBtn) clearBtn.style.display = 'none';
    }
  };

  updateInputDisplay();
  if (input.dataset.dashboardAutocompleteBound === 'true') return;
  input.dataset.dashboardAutocompleteBound = 'true';

  const renderSuggestions = (query = '') => {
    const cleanQuery = removeVietnameseTones(query.trim().toLowerCase());
    const sales = (state.users || []).filter(u => u.role === 'sale' || u.isExternal);
    
    let filtered = sales;
    if (cleanQuery) {
      filtered = sales.filter(u => {
        const name = removeVietnameseTones((u.displayName || '').toLowerCase());
        const uname = removeVietnameseTones((u.username || '').toLowerCase());
        const email = removeVietnameseTones((u.email || '').toLowerCase());
        return name.includes(cleanQuery) || uname.includes(cleanQuery) || email.includes(cleanQuery);
      });
    }

    filtered = filtered.slice(0, 20);

    let html = `<li class="suggestion-item select-sale-opt" data-username="all" style="padding: 8px 12px; cursor: pointer; color: var(--color-primary); font-weight: 600;">-- Tất cả nhân viên --</li>`;
    if (filtered.length > 0) {
      html += filtered.map(u => `
        <li class="suggestion-item select-sale-opt" data-username="${u.username}" style="padding: 8px 12px; cursor: pointer; display: flex; justify-content: space-between;">
          <span style="font-weight: 500; color: var(--text-primary);">${u.displayName}</span>
          <span style="font-size: 0.75rem; color: var(--text-secondary);">${u.username}</span>
        </li>
      `).join('');
    } else {
      html += `<li style="padding: 8px 12px; color: var(--text-muted); font-size: 0.85rem;">Không tìm thấy nhân viên</li>`;
    }

    list.innerHTML = html;
    list.style.display = 'block';

    list.querySelectorAll('.select-sale-opt').forEach(li => {
      li.onclick = () => {
        const username = li.getAttribute('data-username');
        state.dashboardFilter.saleUser = username;
        updateInputDisplay();
        list.style.display = 'none';
        saveDashboardFilterToStorage();
        updateDashboardStats();
      };
    });
  };

  input.onfocus = () => {
    renderSuggestions(input.value);
  };

  input.oninput = () => {
    if (clearBtn) clearBtn.style.display = input.value ? 'block' : 'none';
    if (saleDebounceTimer) clearTimeout(saleDebounceTimer);
    saleDebounceTimer = setTimeout(() => {
      renderSuggestions(input.value);
    }, 300);
  };

  if (clearBtn) {
    clearBtn.onclick = () => {
      state.dashboardFilter.saleUser = 'all';
      updateInputDisplay();
      list.style.display = 'none';
      saveDashboardFilterToStorage();
      updateDashboardStats();
    };
  }

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !list.contains(e.target) && (!clearBtn || !clearBtn.contains(e.target))) {
      list.style.display = 'none';
      updateInputDisplay();
    }
  });
}

function setupCustomerAutocomplete() {
  const input = document.getElementById('dashboard-customer-search-input');
  const clearBtn = document.getElementById('btn-clear-customer-search');
  const list = document.getElementById('dashboard-customer-suggestions');
  if (!input || !list) return;

  const updateInputDisplay = () => {
    if (state.dashboardFilter.customerId && state.dashboardFilter.customerId !== 'all') {
      const found = (state.customers || []).find(c => String(c.id) === String(state.dashboardFilter.customerId));
      input.value = found
        ? `${found.name || 'Khách hàng'}${found.code ? ` (${found.code})` : ''}`
        : state.dashboardFilter.customerId;
      if (clearBtn) clearBtn.style.display = 'block';
    } else {
      input.value = '';
      input.placeholder = '-- Tất cả khách hàng --';
      if (clearBtn) clearBtn.style.display = 'none';
    }
  };

  updateInputDisplay();
  if (input.dataset.dashboardAutocompleteBound === 'true') return;
  input.dataset.dashboardAutocompleteBound = 'true';

  const renderSuggestions = (query = '') => {
    const cleanQuery = removeVietnameseTones(query.trim().toLowerCase());
    const custs = (state.customers || []).filter(customer => {
      if (state.currentUser?.role === 'sale') return isSameUser(customer.managedBy || customer.managed_by, state.currentUser.username);
      if (state.dashboardFilter.saleUser && state.dashboardFilter.saleUser !== 'all') {
        return isSameUser(customer.managedBy || customer.managed_by, state.dashboardFilter.saleUser);
      }
      return true;
    });
    
    let filtered = custs;
    if (cleanQuery) {
      filtered = custs.filter(c => {
        const name = removeVietnameseTones((c.name || '').toLowerCase());
        const code = removeVietnameseTones((c.code || '').toLowerCase());
        const phone = (c.phone || '').replace(/\D/g, '');
        return name.includes(cleanQuery) || code.includes(cleanQuery) || phone.includes(cleanQuery);
      });
    }

    filtered = filtered.slice(0, 20);

    let html = `<li class="suggestion-item select-cust-opt" data-id="all" style="padding: 8px 12px; cursor: pointer; color: var(--color-primary); font-weight: 600;">-- Tất cả khách hàng --</li>`;
    if (filtered.length > 0) {
      html += filtered.map(c => `
        <li class="suggestion-item select-cust-opt" data-id="${escapeHtml(c.id)}" style="padding: 8px 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center;">
          <div>
            <span style="font-weight: 500; color: var(--text-primary);">${escapeHtml(c.name || 'Khách hàng')}</span>
            <span style="font-size: 0.75rem; color: var(--text-secondary); display: block;">Mã: ${escapeHtml(c.code || '—')} • ${escapeHtml(c.phone || 'N/A')}</span>
          </div>
        </li>
      `).join('');
    } else {
      html += `<li style="padding: 8px 12px; color: var(--text-muted); font-size: 0.85rem;">Không tìm thấy khách hàng</li>`;
    }

    list.innerHTML = html;
    list.style.display = 'block';

    list.querySelectorAll('.select-cust-opt').forEach(li => {
      li.onclick = () => {
        const custId = li.getAttribute('data-id');
        state.dashboardFilter.customerId = custId;
        updateInputDisplay();
        list.style.display = 'none';
        saveDashboardFilterToStorage();
        updateDashboardStats();
      };
    });
  };

  input.onfocus = () => {
    renderSuggestions(input.value);
  };

  input.oninput = () => {
    if (clearBtn) clearBtn.style.display = input.value ? 'block' : 'none';
    if (customerDebounceTimer) clearTimeout(customerDebounceTimer);
    customerDebounceTimer = setTimeout(() => {
      renderSuggestions(input.value);
    }, 300);
  };

  if (clearBtn) {
    clearBtn.onclick = () => {
      state.dashboardFilter.customerId = 'all';
      updateInputDisplay();
      list.style.display = 'none';
      saveDashboardFilterToStorage();
      updateDashboardStats();
    };
  }

  document.addEventListener('click', (e) => {
    if (!input.contains(e.target) && !list.contains(e.target) && (!clearBtn || !clearBtn.contains(e.target))) {
      list.style.display = 'none';
      updateInputDisplay();
    }
  });
}

export function setupDashboardQuickActions() {
  document.getElementById('saas-onboarding-checklist')?.addEventListener('click', event => {
    const button = event.target.closest('.saas-onboarding-action');
    if (button?.dataset.target) switchTab(button.dataset.target);
  });
  const quickOrderBtn = document.getElementById('btn-quick-order');
  const addProdBtn = document.getElementById('dash-btn-add-product');
  const newOrdBtn = document.getElementById('dash-btn-new-order');
  const viewAllBtn = document.getElementById('btn-view-all-history');

  if (quickOrderBtn) {
    quickOrderBtn.addEventListener('click', () => {
      switchTab('invoice-panel');
    });
  }
  
  if (addProdBtn) {
    addProdBtn.addEventListener('click', () => {
      switchTab('products-panel');
      openProductModal();
    });
  }
  
  if (newOrdBtn) {
    newOrdBtn.addEventListener('click', () => {
      switchTab('invoice-panel');
    });
  }
  
  if (viewAllBtn) {
    viewAllBtn.addEventListener('click', () => {
      switchTab('history-panel');
    });
  }
}
