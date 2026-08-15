import { state } from '../state.js';
import { showToast, formatCurrency, formatNumber, safeCreateIcons, formatDateTime, isSameUser, getManagerDisplayName, getCustomerName, getUserById, getUserDisplayName, getCompanyName, normalizeCompanyId, getCompanyIdByBrand, getCanonicalBrandName } from '../utils.js';
import { dbDeleteOrder, dbDeleteAllOrders, dbRecordSalesReturn, dbCancelSalesReturn, dbCancelOrder, dbRefreshCustomerFinancialState, dbUpdateOrderNotes, dbLoadOrdersForHistoryRange, cacheOrdersLocally } from '../services/supabase.js?v=20260814-invoice-discount-label-v19';
import { ensurePanelCloudData, renderAll } from '../main.js?v=20260814-invoice-discount-label-v19';
import { openPrintTypeModal, resetInvoiceBuilder, syncInvoiceBusinessDateControl } from './invoice.js?v=20260814-invoice-discount-label-v19';
import { openHistoryOrderExportModal } from './customers.js?v=20260814-invoice-discount-label-v19';
import {
  getOrderFinancialBreakdown,
  isOrderIncludedInFinancialSummary
} from '../domain/order-financials.js?v=20260814-invoice-discount-label-v19';
import { getOrderDisplayCode } from '../domain/order-display.js';
import { matchesHistoryOrderStatuses } from '../domain/order-status.js';
import { currentBusinessDateInputValue, orderDateToInputValue } from '../domain/order-business-date.js';
import { normalizeOrderItemsForEditing, resolveOrderCustomerForEditing } from '../domain/order-edit.js';
import { getApplicablePriceList, normalizePriceListType, PRICE_LIST_TYPES } from '../domain/pricing.js?v=20260814-invoice-discount-label-v19';

const selectedHistoryOrderIdsForExport = new Set();
let pendingSalesReturnKey = '';
let historyFilterTimer = null;
let historyRenderCache = null;
let historyFinancialCache = null;
let expandedHistoryOrderId = null;
let historyWindowRequestId = 0;

function localDateStart(value) {
  if (!value) return null;
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getCurrentWeekWindow() {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const endExclusive = new Date(start);
  endExclusive.setDate(endExclusive.getDate() + 7);
  return { start, endExclusive };
}

function getHistoryDateWindow() {
  const mode = document.getElementById('history-date-mode')?.value || 'week';
  let start = null;
  let endExclusive = null;
  if (mode === 'week') {
    ({ start, endExclusive } = getCurrentWeekWindow());
  } else if (mode === 'date') {
    start = localDateStart(document.getElementById('history-filter-date')?.value);
    if (start) {
      endExclusive = new Date(start);
      endExclusive.setDate(endExclusive.getDate() + 1);
    }
  } else if (mode === 'month') {
    const value = document.getElementById('history-filter-month')?.value || '';
    if (/^\d{4}-\d{2}$/.test(value)) {
      start = localDateStart(`${value}-01`);
      endExclusive = new Date(start);
      endExclusive.setMonth(endExclusive.getMonth() + 1);
    }
  } else if (mode === 'year') {
    const year = Number(document.getElementById('history-filter-year')?.value);
    if (Number.isInteger(year) && year > 0) {
      start = new Date(year, 0, 1);
      endExclusive = new Date(year + 1, 0, 1);
    }
  } else if (mode === 'range') {
    start = localDateStart(document.getElementById('history-filter-from')?.value);
    const inclusiveEnd = localDateStart(document.getElementById('history-filter-to')?.value);
    if (inclusiveEnd) {
      endExclusive = new Date(inclusiveEnd);
      endExclusive.setDate(endExclusive.getDate() + 1);
    }
  }
  return {
    mode,
    start,
    endExclusive,
    startIso: start?.toISOString() || null,
    endExclusiveIso: endExclusive?.toISOString() || null
  };
}

async function reloadHistoryDateWindow() {
  const requestId = ++historyWindowRequestId;
  const window = getHistoryDateWindow();
  const container = document.getElementById('history-orders-container');
  if (container) {
    container.innerHTML = '<div class="empty-state"><div class="empty-state-title">Đang tải đúng khoảng thời gian…</div></div>';
  }
  await dbLoadOrdersForHistoryRange(window.startIso, window.endExclusiveIso);
  if (requestId !== historyWindowRequestId) return;
  historyRenderCache = null;
  historyFinancialCache = null;
  renderHistoryOrders();
}

function escapeHistoryHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
}

function scheduleHistoryFilter(onFilterChange) {
  if (historyFilterTimer) clearTimeout(historyFilterTimer);
  historyFilterTimer = setTimeout(() => {
    historyFilterTimer = null;
    onFilterChange();
  }, 180);
}

function createHistoryLookups() {
  const customerById = new Map();
  const customerByName = new Map();
  (state.customers || []).forEach(customer => {
    if (customer.id !== null && customer.id !== undefined) {
      customerById.set(String(customer.id), customer);
    }
    const normalizedName = String(customer.name || '').toLowerCase();
    if (normalizedName && !customerByName.has(normalizedName)) customerByName.set(normalizedName, customer);
  });

  const pricelistById = new Map((state.pricelists || []).map(item => [String(item.id), item]));
  const returnsByOrderId = new Map();
  const activeReturnsByOrderId = new Map();
  (state.salesReturns || []).forEach(item => {
    const orderId = String(item.saleId || item.orderId || item.sale_id || item.order_id || '');
    if (!orderId) return;
    if (!returnsByOrderId.has(orderId)) returnsByOrderId.set(orderId, []);
    returnsByOrderId.get(orderId).push(item);
    if (!['cancelled', 'canceled', 'draft'].includes(String(item.status || 'completed').toLowerCase())) {
      if (!activeReturnsByOrderId.has(orderId)) activeReturnsByOrderId.set(orderId, []);
      activeReturnsByOrderId.get(orderId).push(item);
    }
  });

  return { customerById, customerByName, pricelistById, returnsByOrderId, activeReturnsByOrderId };
}

function getHistoryCustomer(order, lookups) {
  if (order.customerId !== null && order.customerId !== undefined && order.customerId !== '') {
    return lookups.customerById.get(String(order.customerId)) || null;
  }
  return lookups.customerByName.get(String(order.customerName || '').toLowerCase()) || null;
}

function orderWasCreatedByUser(order, user) {
  if (!order?.createdBy || !user) return false;
  const creator = getUserById(order.createdBy, state.users);
  if (creator) {
    const creatorAuthId = creator.authUserId || creator.auth_user_id || '';
    const userAuthId = user.authUserId || user.auth_user_id || '';
    return (creator.id && user.id && String(creator.id) === String(user.id))
      || (creatorAuthId && userAuthId && String(creatorAuthId) === String(userAuthId))
      || isSameUser(creator.username, user.username);
  }
  return isSameUser(order.createdBy, user.username)
    || String(order.createdBy) === String(user.authUserId || user.auth_user_id || user.id || '');
}

function orderIsVisibleToSale(order, user, lookups) {
  if (orderWasCreatedByUser(order, user)) return true;
  if (order?.customerId === null || order?.customerId === undefined || order?.customerId === '') return false;

  // Customers are already restricted by customers_select RLS. An exact ID
  // match therefore means this dealer is in the Sale's managed/assigned scope.
  return lookups.customerById.has(String(order.customerId));
}

function updateHistorySummary(orders, lookups) {
  const beforeDiscountEl = document.getElementById('history-total-before-discount');
  const discountEl = document.getElementById('history-total-discount');
  const otherFeeEl = document.getElementById('history-total-other-fee');
  const payableEl = document.getElementById('history-total-payable');
  const countEl = document.getElementById('history-total-settled-count');
  if (!beforeDiscountEl || !discountEl || !otherFeeEl || !payableEl || !countEl) return;

  const settledOrders = (orders || []).filter(isOrderIncludedInFinancialSummary);
  const totals = settledOrders.reduce((summary, order) => {
    const breakdown = getHistoryOrderAmountBreakdown(order, lookups);
    summary.totalBeforeDiscount += breakdown.totalBeforeDiscount;
    summary.totalDiscountAmount += breakdown.totalDiscountAmount;
    summary.shippingFeeAmount += breakdown.shippingFeeAmount;
    summary.totalPayment += breakdown.totalPayment;
    return summary;
  }, { totalBeforeDiscount: 0, totalDiscountAmount: 0, shippingFeeAmount: 0, totalPayment: 0 });

  beforeDiscountEl.innerText = formatNumber(totals.totalBeforeDiscount);
  discountEl.innerText = formatNumber(totals.totalDiscountAmount);
  otherFeeEl.innerText = formatNumber(totals.shippingFeeAmount);
  payableEl.innerText = formatNumber(totals.totalPayment);
  countEl.innerText = `${settledOrders.length} / ${(orders || []).length} đơn hợp lệ`;
}

function getHistoryOrderAmountBreakdown(order, lookups) {
  const ordersRef = state.savedOrders || [];
  const returnsRef = state.salesReturns || [];
  if (!historyFinancialCache
      || historyFinancialCache.ordersRef !== ordersRef
      || historyFinancialCache.orderCount !== ordersRef.length
      || historyFinancialCache.returnsRef !== returnsRef
      || historyFinancialCache.returnCount !== returnsRef.length) {
    historyFinancialCache = {
      ordersRef,
      orderCount: ordersRef.length,
      returnsRef,
      returnCount: returnsRef.length,
      breakdownByOrderId: new Map()
    };
  }

  const orderId = String(order.id || '');
  if (!historyFinancialCache.breakdownByOrderId.has(orderId)) {
    const orderReturns = lookups?.returnsByOrderId?.get(orderId) || [];
    historyFinancialCache.breakdownByOrderId.set(orderId, getOrderFinancialBreakdown(order, orderReturns));
  }
  return historyFinancialCache.breakdownByOrderId.get(orderId);
}

function getHistoryOrderActionContext(order, lookups) {
  const financeRole = ['admin', 'accounting'].includes(state.currentUser?.role);
  const activeOrderReturns = lookups.activeReturnsByOrderId.get(String(order.id)) || [];
  return {
    financeRole,
    activeOrderReturns,
    canEditNotes: financeRole,
    showDeleteBtn: order.status === 'draft',
    showCancelBtn: order.status === 'settled' && financeRole,
    showReturnBtn: ['settled', 'partially_returned'].includes(order.status) && financeRole,
    showAmendBtn: order.status === 'settled' && financeRole && activeOrderReturns.length === 0
  };
}

function getHistoryOrderPaymentSummary(order, amountBreakdown) {
  const storedInvoiceDiscount = order.discountAmount ?? order.discount_amount;
  const discountValue = Number(order.discountValue ?? order.discount_value ?? 0);
  const discountType = String(order.discountType ?? order.discount_type ?? 'amount').toLowerCase();
  const discountBase = Number(order.subtotal || 0) > 0
    ? Number(order.subtotal)
    : Number(amountBreakdown.totalBeforeDiscount || 0);
  const derivedInvoiceDiscount = discountType === 'percent'
    ? Math.round(discountBase * Math.max(0, discountValue) / 100)
    : Math.max(0, discountValue);
  const invoiceDiscount = Number(storedInvoiceDiscount ?? derivedInvoiceDiscount);
  const paidAmount = Number(order.paidAmount ?? order.paid_amount ?? 0);
  return {
    totalGoods: Number(amountBreakdown.totalBeforeDiscount || 0),
    invoiceDiscount: Number.isFinite(invoiceDiscount) ? Math.max(0, invoiceDiscount) : 0,
    shippingFeeAmount: Number(amountBreakdown.shippingFeeAmount || 0),
    customerPayable: Number(amountBreakdown.totalPayment || 0),
    paidAmount: Number.isFinite(paidAmount) ? Math.max(0, paidAmount) : 0
  };
}

function historyOrderDetailId(orderId) {
  return `history-order-detail-${String(orderId || '').replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

function getHistoryItemDisplayValues(item) {
  const quantity = Number(item?.quantity || 0);
  const unitPrice = Number(item?.unitPrice ?? item?.listPrice ?? item?.price ?? 0);
  const discountPercent = Number(item?.discountPercent ?? item?.discount ?? 0);
  const discountAmount = Number(item?.discountAmount || 0);
  const calculatedSalePrice = unitPrice * (1 - Math.max(0, discountPercent) / 100) - discountAmount;
  const salePrice = Number(item?.finalUnitPrice ?? item?.salePrice ?? item?.finalPrice ?? calculatedSalePrice);
  const lineTotal = Number(item?.lineTotal ?? item?.total ?? (quantity * salePrice));

  return {
    code: item?.variantCode || item?.variantCodeSnapshot || item?.productCode || item?.code || '',
    name: item?.productName || item?.product?.name || item?.name || 'Sản phẩm',
    packageName: item?.package || item?.packageType || item?.specification || '',
    colorCode: item?.colorCode || item?.color_code || '',
    quantity: Number.isFinite(quantity) ? quantity : 0,
    unitPrice: Number.isFinite(unitPrice) ? unitPrice : 0,
    discountPercent: Number.isFinite(discountPercent) ? discountPercent : 0,
    discountAmount: Number.isFinite(discountAmount) ? discountAmount : 0,
    salePrice: Number.isFinite(salePrice) ? Math.max(0, salePrice) : 0,
    lineTotal: Number.isFinite(lineTotal) ? Math.max(0, lineTotal) : 0
  };
}

function renderHistoryExpandedItems(order) {
  const items = Array.isArray(order?.items) ? order.items : [];
  const totalQuantity = items.reduce((sum, item) => sum + Math.max(0, Number(item?.quantity || 0)), 0);
  const rows = items.map(item => {
    const values = getHistoryItemDisplayValues(item);

    return `
      <tr>
        <td class="history-product-code">${escapeHistoryHtml(values.code || '—')}</td>
        <td>
          <div class="history-product-name">${escapeHistoryHtml(values.name)}</div>
          ${values.packageName ? `<div class="history-product-package">${escapeHistoryHtml(values.packageName)}</div>` : ''}
        </td>
        <td class="history-product-color">${escapeHistoryHtml(values.colorCode || '—')}</td>
        <td class="history-product-number">${formatNumber(values.quantity)}</td>
        <td class="history-product-number">${formatNumber(values.unitPrice)}</td>
        <td class="history-product-number">${formatNumber(values.salePrice)}</td>
        <td class="history-product-number history-product-total">${formatNumber(values.lineTotal)}</td>
      </tr>
    `;
  }).join('');

  return `
    <div class="history-expanded-products">
      <div class="history-expanded-products-heading">
        <strong>Danh sách sản phẩm</strong>
        <span>${formatNumber(items.length)} mặt hàng · ${formatNumber(totalQuantity)} sản phẩm</span>
      </div>
      ${items.length ? `
        <div class="history-expanded-products-scroll">
          <table class="history-expanded-products-table">
            <thead>
              <tr>
                <th>Mã hàng</th>
                <th>Tên hàng</th>
                <th>Mã màu</th>
                <th>Số lượng</th>
                <th>Đơn giá</th>
                <th>Giá bán</th>
                <th>Thành tiền</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      ` : '<div class="history-expanded-products-empty">Đơn hàng chưa có sản phẩm.</div>'}
    </div>
  `;
}

function populateHistoryCompanyAndBrandFilters() {
  const companySelect = document.getElementById('history-company-filter');
  const brandSelect = document.getElementById('history-brand-filter');

  if (companySelect) {
    const currentCompany = companySelect.value || 'all';
    const companyOptions = (state.companies || [])
      .map(c => `<option value="${c.id}">${c.name || c.id}</option>`)
      .join('');
    companySelect.innerHTML = `<option value="all">Tất cả công ty</option>${companyOptions}`;
    companySelect.value = Array.from(companySelect.options).some(opt => opt.value === currentCompany) ? currentCompany : 'all';
  }

  if (brandSelect) {
    const currentBrand = brandSelect.value || 'all';
    const brandOptions = Array.from(new Set((state.brands || []).map(b => b.name).filter(Boolean)))
      .sort((a, b) => a.localeCompare(b, 'vi'))
      .map(name => `<option value="${name}">${name}</option>`)
      .join('');
    brandSelect.innerHTML = `<option value="all">Tất cả nhãn sơn</option>${brandOptions}`;
    brandSelect.value = Array.from(brandSelect.options).some(opt => opt.value === currentBrand) ? currentBrand : 'all';
  }
}

function orderMatchesHistoryCompany(order, companyId) {
  if (!companyId || companyId === 'all') return true;
  const selectedCompanyId = normalizeCompanyId(companyId);
  if (normalizeCompanyId(order.companyId || order.company_id) === selectedCompanyId) return true;

  return (order.items || []).some(item => {
    const itemCompany = item.revenueCompany || item.companyId || item.company_id ||
      getCompanyIdByBrand(item.revenueBrand || item.agencyBrand || item.productBrand || item.brand, state.brands);
    return normalizeCompanyId(itemCompany) === selectedCompanyId;
  });
}

function orderMatchesHistoryBrand(order, brandName) {
  if (!brandName || brandName === 'all') return true;
  const selectedBrand = getCanonicalBrandName(brandName, state.brands).toLowerCase();

  return (order.items || []).some(item =>
    [item.revenueBrand, item.agencyBrand, item.productBrand, item.brand]
      .filter(Boolean)
      .some(brand => getCanonicalBrandName(brand, state.brands).toLowerCase() === selectedBrand)
  );
}

export function setupHistoryPanel() {
  const searchInput = document.getElementById('history-search-input');
  
  const onFilterChange = () => {
    state.historyPage = 1;
    renderHistoryOrders();
  };
  const onDateFilterChange = () => {
    state.historyPage = 1;
    void reloadHistoryDateWindow();
  };

  if (searchInput) {
    searchInput.addEventListener('input', () => scheduleHistoryFilter(onFilterChange));
  }
  
  // Thiết lập các bộ lọc thời gian, công ty, nhãn sơn, nhân viên
  const dateModeSelect = document.getElementById('history-date-mode');
  const filterDateInput = document.getElementById('history-filter-date');
  const filterMonthInput = document.getElementById('history-filter-month');
  const filterYearSelect = document.getElementById('history-filter-year');
  const filterRangeDiv = document.getElementById('history-filter-range');
  
  if (dateModeSelect) {
    // Khởi tạo năm động (năm hiện tại lùi về 5 năm)
    const currentYear = new Date().getFullYear();
    filterYearSelect.innerHTML = '<option value="">-- Chọn năm --</option>';
    for (let y = currentYear; y >= currentYear - 5; y--) {
      const opt = document.createElement('option');
      opt.value = y.toString();
      opt.textContent = y.toString();
      filterYearSelect.appendChild(opt);
    }
    filterYearSelect.value = currentYear.toString();
    const today = new Date();
    const localToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    filterDateInput.value = localToday;
    filterMonthInput.value = localToday.slice(0, 7);
    document.getElementById('history-filter-from').value = localToday;
    document.getElementById('history-filter-to').value = localToday;



    dateModeSelect.addEventListener('change', () => {
      const mode = dateModeSelect.value;
      
      // Ẩn tất cả trước
      filterDateInput.style.display = 'none';
      filterMonthInput.style.display = 'none';
      filterYearSelect.style.display = 'none';
      filterRangeDiv.style.display = 'none';
      
      // Hiện cái tương ứng
      if (mode === 'date') filterDateInput.style.display = 'block';
      else if (mode === 'month') filterMonthInput.style.display = 'block';
      else if (mode === 'year') filterYearSelect.style.display = 'block';
      else if (mode === 'range') filterRangeDiv.style.display = 'flex';
      
      onDateFilterChange();
    });
    
    filterDateInput.addEventListener('input', onDateFilterChange);
    filterMonthInput.addEventListener('input', onDateFilterChange);
    filterYearSelect.addEventListener('change', onDateFilterChange);
    document.getElementById('history-filter-from').addEventListener('input', onDateFilterChange);
    document.getElementById('history-filter-to').addEventListener('input', onDateFilterChange);
  }

  ['history-company-filter', 'history-brand-filter'].forEach(id => {
    const select = document.getElementById(id);
    if (select) select.addEventListener('change', onFilterChange);
  });

  document.querySelectorAll('.history-status-filter-check').forEach(checkbox => {
    checkbox.addEventListener('change', onFilterChange);
  });
  
  const creatorFilter = document.getElementById('history-creator-filter');
  if (creatorFilter) {
    creatorFilter.addEventListener('input', () => {
      renderHistoryCreatorSuggestions();
      scheduleHistoryFilter(onFilterChange);
    });
    creatorFilter.addEventListener('focus', renderHistoryCreatorSuggestions);
  }

  document.addEventListener('click', (e) => {
    const creatorWrap = document.querySelector('.history-creator-filter-wrap');
    const suggestions = document.getElementById('history-creator-suggestions');
    if (creatorWrap && suggestions && !creatorWrap.contains(e.target)) {
      suggestions.style.display = 'none';
    }
  });

  document.addEventListener('click', (e) => {
    const item = e.target.closest('.history-creator-suggestion');
    if (!item) return;
    const creatorFilter = document.getElementById('history-creator-filter');
    const suggestions = document.getElementById('history-creator-suggestions');
    if (creatorFilter) creatorFilter.value = decodeURIComponent(item.getAttribute('data-name') || '');
    if (suggestions) suggestions.style.display = 'none';
    onFilterChange();
  });

  const refreshBtn = document.getElementById('btn-refresh-history');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      const icon = refreshBtn.querySelector('i');
      if (icon) icon.classList.add('spin-animation');
      
      showToast('Đang làm mới dữ liệu từ Cloud...', 'info');
      try {
        const window = getHistoryDateWindow();
        await Promise.all([
          dbLoadOrdersForHistoryRange(window.startIso, window.endExclusiveIso),
          ensurePanelCloudData('history-panel', { force: true, domains: ['salesReturns'] })
        ]);
        renderAll();
        showToast('Đã làm mới dữ liệu từ Cloud thành công!', 'success');
      } catch (err) {
        showToast('Lỗi khi làm mới dữ liệu: ' + err.message, 'danger');
      } finally {
        if (icon) {
          setTimeout(() => icon.classList.remove('spin-animation'), 500);
        }
      }
    });
  }

  const exportBtn = document.getElementById('btn-open-history-export-modal');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const filteredIds = state.historyFilteredOrderIds || [];
      const selectedIds = Array.from(selectedHistoryOrderIdsForExport).filter(id => filteredIds.includes(id));
      const orders = (state.savedOrders || []).filter(o => filteredIds.includes(String(o.id)));
      openHistoryOrderExportModal(orders, selectedIds);
    });
  }

  const returnForm = document.getElementById('sales-return-form');
  if (returnForm) {
    returnForm.addEventListener('submit', processSalesReturnSubmit);
  }

  const btnCard = document.getElementById('btn-history-view-card');
  const btnDetails = document.getElementById('btn-history-view-details');
  if (btnCard) {
    btnCard.addEventListener('click', () => {
      state.historyViewMode = 'card';
      localStorage.setItem('historyViewMode', 'card');
      renderHistoryOrders({ reuseFiltered: true });
    });
  }
  if (btnDetails) {
    btnDetails.addEventListener('click', () => {
      state.historyViewMode = 'details';
      localStorage.setItem('historyViewMode', 'details');
      renderHistoryOrders({ reuseFiltered: true });
    });
  }
}

export function printOrderById(orderId) {
  const order = state.savedOrders.find(o => o.id === orderId);
  if (!order) {
    showToast(`Không tìm thấy đơn hàng "${orderId}"!`, 'danger');
    return;
  }
  openPrintTypeModal(order);
}

export async function deleteOrder(id) {
  const order = state.savedOrders.find(o => o.id === id);
  if (!order) return;
  
  if (order.status === 'settled') {
    showToast('Đơn đã chốt không được xóa vật lý. Vui lòng dùng nghiệp vụ hủy/đảo giao dịch khi giai đoạn 2 được triển khai.', 'warning');
    return;
  }
  
  if (confirm(`Bạn có chắc chắn muốn xóa đơn hàng "${id}" không?`)) {
    const deleted = await dbDeleteOrder(id, order.status);
    if (deleted) {
      state.savedOrders = state.savedOrders.filter(o => o.id !== id);
      renderAll();
      showToast(`Đã xóa đơn hàng ${id} thành công!`, 'warning');
    }
  }
}

export async function cancelOrderById(id) {
  if (!['admin', 'accounting'].includes(state.currentUser?.role)) {
    showToast('Chỉ Admin hoặc Kế toán được hủy đơn đã chốt.', 'danger');
    return;
  }
  const order = state.savedOrders.find(item => String(item.id) === String(id));
  if (!order || order.status !== 'settled') {
    showToast('Chỉ đơn đã chốt và chưa trả hàng mới được hủy ở giai đoạn này.', 'warning');
    return;
  }
  const reason = prompt(`Nhập lý do hủy đơn ${order.id}:`, 'Hủy theo yêu cầu nghiệp vụ');
  if (reason === null) return;
  if (reason.trim().length < 3) {
    showToast('Lý do hủy phải có ít nhất 3 ký tự.', 'warning');
    return;
  }
  if (!confirm(`Xác nhận hủy đơn ${order.id}? Database sẽ tạo giao dịch đảo công nợ và doanh số.`)) return;

  const result = await dbCancelOrder(order.id, reason.trim());
  if (!result) return;
  order.status = 'cancelled';
  order.cancelledAt = result.cancelled_at || new Date().toISOString();
  order.cancelledBy = result.cancelled_by || state.currentUser?.authUserId || '';
  order.cancellationReason = result.cancellation_reason || reason.trim();
  // Reload the authoritative customer balance and debt ledger. The cancellation
  // RPC appends an order_cancel row; patching only customer.debt would hide it.
  const customersRefreshed = order.customerId
    ? await dbRefreshCustomerFinancialState(order.customerId, { includeHistory: false })
    : true;
  cacheOrdersLocally(state.savedOrders);
  renderAll();
  if (customersRefreshed) {
    showToast(`Đã hủy đơn ${order.id} và ghi giao dịch đảo.`, 'success');
  } else {
    showToast(`Đơn ${order.id} đã hủy trên Cloud nhưng chưa tải lại được lịch sử công nợ. Vui lòng tải lại trang.`, 'warning');
  }
}

let lastUserLength = 0;

export function populateHistoryFilters() {
  const creatorSuggestions = document.getElementById('history-creator-suggestions');
  populateHistoryCompanyAndBrandFilters();
  if (!creatorSuggestions) return;
  
  // Chỉ cập nhật nếu số lượng người dùng thay đổi
  if (state.users.length === lastUserLength) {
    return;
  }
  
  lastUserLength = state.users.length;
  renderHistoryCreatorSuggestions();
}

function renderHistoryCreatorSuggestions() {
  const input = document.getElementById('history-creator-filter');
  const suggestions = document.getElementById('history-creator-suggestions');
  if (!input || !suggestions) return;

  const query = input.value.toLowerCase().trim();
  const users = state.users
    .filter(u => {
      if (!query) return true;
      return (u.displayName || '').toLowerCase().includes(query) ||
        (u.username || '').toLowerCase().includes(query);
    })
    .slice(0, 12);

  if (users.length === 0) {
    suggestions.innerHTML = `<li class="suggestion-item" style="color: var(--text-muted); cursor: default;">Không tìm thấy nhân viên</li>`;
  } else {
    suggestions.innerHTML = users.map(u => {
      const roleText = u.isExternal ? 'Kinh doanh ngoài' : (u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale');
      return `
        <li class="suggestion-item history-creator-suggestion" data-name="${encodeURIComponent(u.displayName || u.username || '')}">
          <div class="suggestion-info">
            <span class="suggestion-code">${u.displayName || u.username}</span>
            <span class="suggestion-name">@${u.username || ''}</span>
          </div>
          <span class="suggestion-brand-badge">${roleText}</span>
        </li>
      `;
    }).join('');
  }

  suggestions.style.display = document.activeElement === input ? 'block' : 'none';
}

export function renderHistoryOrders({ reuseFiltered = false } = {}) {
  const container = document.getElementById('history-orders-container');
  if (!container) return;
  
  populateHistoryFilters();

  // Đồng bộ trạng thái active cho nút chuyển đổi giao diện
  const btnCard = document.getElementById('btn-history-view-card');
  const btnDetails = document.getElementById('btn-history-view-details');
  if (btnCard && btnDetails) {
    if (state.historyViewMode === 'details') {
      btnCard.classList.remove('active');
      btnDetails.classList.add('active');
      container.classList.add('details-mode');
    } else {
      btnCard.classList.add('active');
      btnDetails.classList.remove('active');
      container.classList.remove('details-mode');
    }
  }
  
  const searchVal = (document.getElementById('history-search-input')?.value || '').toLowerCase().trim();
  
  const dateModeSelect = document.getElementById('history-date-mode');
  const filterDateInput = document.getElementById('history-filter-date');
  const filterMonthInput = document.getElementById('history-filter-month');
  const filterYearSelect = document.getElementById('history-filter-year');
  const filterFromInput = document.getElementById('history-filter-from');
  const filterToInput = document.getElementById('history-filter-to');
  const companyFilterSelect = document.getElementById('history-company-filter');
  const brandFilterSelect = document.getElementById('history-brand-filter');
  const creatorFilterSelect = document.getElementById('history-creator-filter');
  
  const dateMode = dateModeSelect ? dateModeSelect.value : 'all';
  const filterDate = filterDateInput ? filterDateInput.value : '';
  const filterMonth = filterMonthInput ? filterMonthInput.value : '';
  const filterYear = filterYearSelect ? filterYearSelect.value : '';
  const filterFrom = filterFromInput ? filterFromInput.value : '';
  const filterTo = filterToInput ? filterToInput.value : '';
  const selectedCompany = companyFilterSelect ? companyFilterSelect.value : 'all';
  const selectedBrand = brandFilterSelect ? brandFilterSelect.value : 'all';
  const selectedStatuses = [...document.querySelectorAll('.history-status-filter-check:checked')]
    .map(checkbox => checkbox.value);
  const selectedCreator = creatorFilterSelect ? creatorFilterSelect.value : '';
  const filterKey = JSON.stringify({
    searchVal, dateMode, filterDate, filterMonth, filterYear, filterFrom, filterTo,
    selectedCompany, selectedBrand, selectedStatuses, selectedCreator,
    currentUserId: state.currentUser?.id || state.currentUser?.authUserId || state.currentUser?.username || '',
    currentUserRole: state.currentUser?.role || ''
  });
  const canReuseFiltered = reuseFiltered
    && historyRenderCache
    && historyRenderCache.ordersRef === state.savedOrders
    && historyRenderCache.orderCount === (state.savedOrders || []).length
    && historyRenderCache.returnsRef === state.salesReturns
    && historyRenderCache.returnCount === (state.salesReturns || []).length
    && historyRenderCache.customersRef === state.customers
    && historyRenderCache.usersRef === state.users
    && historyRenderCache.filterKey === filterKey;

  let sorted;
  let lookups;
  if (canReuseFiltered) {
    ({ sorted, lookups } = historyRenderCache);
  } else {
    // A normal render may follow an in-place order edit. Rebuild financial
    // values for correctness; page/view changes explicitly reuse this cache.
    historyFinancialCache = null;
    lookups = createHistoryLookups();
    const filterLower = selectedCreator.toLowerCase().trim();
    const matchingUsers = filterLower
      ? (state.users || []).filter(u =>
        (u.displayName || '').toLowerCase().includes(filterLower)
        || (u.username || '').toLowerCase().includes(filterLower))
      : [];
    const activeWindow = getHistoryDateWindow();
    const fromDate = activeWindow.start;
    const endExclusiveDate = activeWindow.endExclusive;

    const filtered = (state.savedOrders || []).filter(o => {
    // 1. Phân quyền hiển thị đơn của Sale
    if (state.currentUser && state.currentUser.role === 'sale') {
      if (!orderIsVisibleToSale(o, state.currentUser, lookups)) return false;
    }
    
    // 2. Lọc theo tìm kiếm từ khóa
    const matchesSearch = String(o.id || '').toLowerCase().includes(searchVal)
      || getOrderDisplayCode(o).toLowerCase().includes(searchVal)
      || String(o.customerName || '').toLowerCase().includes(searchVal);
    if (!matchesSearch) return false;

    if (!orderMatchesHistoryCompany(o, selectedCompany)) return false;
    if (!orderMatchesHistoryBrand(o, selectedBrand)) return false;
    if (!matchesHistoryOrderStatuses(o.status, selectedStatuses)) return false;
    
    // 3. Lọc theo nhân viên quản lý đại lý (Tìm kiếm tương đối)
    if (selectedCreator) {
      const orderCustomer = getHistoryCustomer(o, lookups);
      const managerValue = orderCustomer ? (orderCustomer.managedBy || orderCustomer.managed_by || '') : '';
      const managerDisplay = managerValue ? getManagerDisplayName(managerValue, state.users) : '';

      let matched = false;
      if (matchingUsers.length > 0) {
        matched = matchingUsers.some(u => isSameUser(managerValue, u.username));
      }

      if (!matched && managerValue) {
        const managerClean = managerValue.toLowerCase();
        const managerDisplayClean = managerDisplay.toLowerCase();
        matched = managerClean.includes(filterLower) || managerDisplayClean.includes(filterLower);
      }
      
      if (!matched) {
        // Fallback cho đơn cũ chưa liên kết được đại lý: vẫn cho lọc theo người tạo đơn.
        const creatorClean = (o.createdBy || '').toLowerCase();
        if (creatorClean.includes(filterLower)) {
          matched = true;
        } else if (matchingUsers.length > 0) {
          matched = matchingUsers.some(u => Boolean(getUserById(o.createdBy, [u])));
        }
      }
      
      if (!matched) return false;
    }
    
    // 4. Lọc theo thời gian
    if (o.date) {
      const oDate = new Date(o.date);
      if (isNaN(oDate.getTime())) return true;
      
      if (dateMode !== 'all') {
        if (fromDate && oDate < fromDate) return false;
        if (endExclusiveDate && oDate >= endExclusiveDate) return false;
      }
    }
    
    return true;
    });
    sorted = filtered.sort((a, b) => new Date(b.date) - new Date(a.date));
    historyRenderCache = {
      ordersRef: state.savedOrders,
      orderCount: (state.savedOrders || []).length,
      returnsRef: state.salesReturns,
      returnCount: (state.salesReturns || []).length,
      customersRef: state.customers,
      usersRef: state.users,
      filterKey,
      sorted,
      lookups
    };
    updateHistorySummary(sorted, lookups);
  }

  if (sorted.length === 0) {
    expandedHistoryOrderId = null;
    state.historyFilteredOrderIds = [];
    container.innerHTML = `
      <div class="empty-state" style="grid-column: 1 / -1;">
        <i data-lucide="clipboard-list"></i>
        <div class="empty-state-title">Không tìm thấy hóa đơn nào</div>
        <div class="empty-state-desc">Thử tìm bằng từ khóa khác hoặc tạo đơn hàng mới trên hệ thống.</div>
      </div>
    `;
    safeCreateIcons();
    return;
  }

  state.historyFilteredOrderIds = sorted.map(o => String(o.id));

  const ITEMS_PER_PAGE = 20;
  const totalItems = sorted.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;

  if (state.historyPage > totalPages) state.historyPage = totalPages;
  if (state.historyPage < 1) state.historyPage = 1;

  const startIndex = (state.historyPage - 1) * ITEMS_PER_PAGE;
  const paginatedItems = sorted.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  const visibleOrderIds = new Set(paginatedItems.map(order => String(order.id)));
  if (state.historyViewMode !== 'details' || !visibleOrderIds.has(String(expandedHistoryOrderId || ''))) {
    expandedHistoryOrderId = null;
  }

  let ordersContentHtml = '';

  if (state.historyViewMode === 'details') {
    // ---------------------- DẠNG CHI TIẾT (DETAILS TABLE VIEW) ----------------------
    const tableRows = paginatedItems.map((order, idx) => {
      const indexNumber = startIndex + idx + 1;
      const amountBreakdown = getHistoryOrderAmountBreakdown(order, lookups);
      const paymentSummary = getHistoryOrderPaymentSummary(order, amountBreakdown);
      const displayOrderCode = getOrderDisplayCode(order);
      const orderId = String(order.id);
      const detailId = historyOrderDetailId(orderId);
      const isExpanded = expandedHistoryOrderId === orderId;

      let statusBadge = '';
      if (['cancelled', 'canceled'].includes(String(order.status || '').toLowerCase())) {
        statusBadge = `<span style="background: rgba(107, 114, 128, 0.14); color: #6b7280; border: 1px solid rgba(107, 114, 128, 0.28); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đã hủy</span>`;
      } else if (order.status === 'draft') {
        statusBadge = `<span style="background: var(--color-danger-light); color: var(--color-danger); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đơn nháp</span>`;
      } else if (order.status === 'partially_returned') {
        statusBadge = `<span style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Trả 1 phần</span>`;
      } else if (order.status === 'returned') {
        statusBadge = `<span style="background: rgba(168, 85, 247, 0.15); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.3); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đã trả toàn bộ</span>`;
      } else {
        statusBadge = `<span style="background: var(--color-primary-light); color: var(--color-primary); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đã chốt</span>`;
      }

      const {
        financeRole, activeOrderReturns, canEditNotes, showDeleteBtn,
        showCancelBtn, showReturnBtn, showAmendBtn
      } = getHistoryOrderActionContext(order, lookups);

      const cust = getHistoryCustomer(order, lookups);
      let plName = 'Nhập tay';
      let debtText = '0 ₫';
      let managerName = 'Chưa phân công';
      
      if (cust) {
        const managerValue = cust.managedBy || cust.managed_by || '';
        managerName = managerValue ? getManagerDisplayName(managerValue, state.users) : managerName;
        const pl = lookups.pricelistById.get(String(cust.pricelistId));
        plName = pl ? pl.name : (cust.pricelistId === 'custom' ? 'Chiết khấu riêng' : (cust.pricelistId === 'retail' ? 'Nhập tay' : 'Chưa xác định'));
        debtText = formatCurrency(cust.debt || 0);
      } else {
        const orderPlId = order.pricelistId || 'retail';
        const pl = lookups.pricelistById.get(String(orderPlId));
        plName = pl ? pl.name : (orderPlId === 'custom' ? 'Chiết khấu riêng' : (orderPlId === 'retail' ? 'Nhập tay' : 'Chiết khấu riêng'));
      }

      return `
        <tr class="history-order-row${isExpanded ? ' is-expanded' : ''}" data-order-id="${escapeHistoryHtml(orderId)}"
            tabindex="0" role="button" aria-expanded="${isExpanded}" aria-controls="${detailId}">
          <td style="text-align: center;"><input type="checkbox" class="history-export-checkbox" data-id="${escapeHistoryHtml(orderId)}" aria-label="Chọn đơn ${escapeHistoryHtml(displayOrderCode)}" ${selectedHistoryOrderIdsForExport.has(orderId) ? 'checked' : ''}></td>
          <td style="text-align: center; font-weight: 600; color: var(--text-muted);">${indexNumber}</td>
          <td>
            <div title="${escapeHistoryHtml(orderId)}" style="font-weight: 700; color: var(--text-primary); font-size: 0.9rem; margin-bottom: 2px;">${escapeHistoryHtml(displayOrderCode)}</div>
            <div>${statusBadge}</div>
          </td>
          <td style="white-space: nowrap; color: var(--text-secondary); font-size: 0.8rem;">
            ${formatDateTime(order.date)}
          </td>
          <td>
            <div style="font-weight: 600; color: var(--text-primary);">${escapeHistoryHtml(order.customerName)}</div>
            <div style="font-size: 0.78rem; color: var(--text-muted);">Nợ hiện tại: <span style="color: var(--color-danger); font-weight: 600;">${debtText}</span></div>
          </td>
          <td>
            <span style="font-size: 0.8rem; font-weight: 600; color: var(--text-secondary);">${escapeHistoryHtml(managerName)}</span>
          </td>
          <td>
            <span style="font-size: 0.8rem; font-weight: 500; color: var(--color-warning);">${escapeHistoryHtml(plName)}</span>
          </td>
          <td style="text-align: right;">
            <div class="history-money-cell">${formatNumber(amountBreakdown.totalBeforeDiscount)}</div>
          </td>
          <td style="text-align: right;">
            <div class="history-money-cell history-money-discount">${formatNumber(amountBreakdown.totalDiscountAmount)}</div>
          </td>
          <td style="text-align: right;">
            <div class="history-money-cell history-money-other-fee">${formatNumber(amountBreakdown.shippingFeeAmount)}</div>
          </td>
          <td style="text-align: right;">
            <div class="history-money-cell history-money-total">${formatNumber(amountBreakdown.totalPayment)}</div>
          </td>
        </tr>
        <tr id="${detailId}" class="history-expanded-row${isExpanded ? ' is-expanded' : ''}" aria-hidden="${!isExpanded}">
          <td colspan="11">
            <div class="history-expanded-motion">
              <div class="history-expanded-motion-inner">
                <section class="history-expanded-panel" aria-label="Chi tiết thao tác đơn ${escapeHistoryHtml(displayOrderCode)}" ${isExpanded ? '' : 'inert'}>
                  ${renderHistoryExpandedItems(order)}
                  <div class="history-expanded-notes">
                    <label for="history-order-notes-${escapeHistoryHtml(orderId)}">Ghi chú</label>
                    <textarea id="history-order-notes-${escapeHistoryHtml(orderId)}" class="form-control history-order-notes-input"
                              data-id="${escapeHistoryHtml(orderId)}" rows="4" placeholder="Nhập ghi chú cho đơn hàng này..."
                              ${canEditNotes ? '' : 'readonly'}>${escapeHistoryHtml(order.notes || '')}</textarea>
                  </div>
                  <dl class="history-expanded-payment">
                    <div><dt>Tổng tiền hàng</dt><dd>${formatCurrency(paymentSummary.totalGoods)}</dd></div>
                    <div><dt>Giảm giá hóa đơn</dt><dd>${formatCurrency(paymentSummary.invoiceDiscount)}</dd></div>
                    <div><dt>Thu khác</dt><dd>${formatCurrency(paymentSummary.shippingFeeAmount)}</dd></div>
                    <div class="history-expanded-payable"><dt>Khách cần trả</dt><dd>${formatCurrency(paymentSummary.customerPayable)}</dd></div>
                    <div><dt>Khách đã trả</dt><dd>${formatCurrency(paymentSummary.paidAmount)}</dd></div>
                  </dl>
                  <div class="history-expanded-actions" aria-label="Thao tác đơn hàng">
                    ${canEditNotes ? `
                      <button class="history-detail-action history-action-edit history-notes-btn" data-id="${escapeHistoryHtml(orderId)}" type="button">
                        <i data-lucide="save"></i> Lưu ghi chú
                      </button>
                    ` : ''}
                    ${(order.status === 'draft' || showAmendBtn) ? `
                      <button class="history-detail-action history-action-edit history-edit-btn" data-id="${escapeHistoryHtml(orderId)}" type="button">
                        <i data-lucide="edit"></i> Chỉnh sửa
                      </button>
                    ` : ''}
                    <button class="history-detail-action history-action-copy history-copy-btn" data-id="${escapeHistoryHtml(orderId)}" type="button">
                      <i data-lucide="copy"></i> Sao chép
                    </button>
                    <button class="history-detail-action history-action-print history-print-btn" data-id="${escapeHistoryHtml(orderId)}" type="button">
                      <i data-lucide="printer"></i> In
                    </button>
                    <button class="history-detail-action history-action-view history-activity-btn" data-id="${escapeHistoryHtml(orderId)}" type="button">
                      <i data-lucide="history"></i> Lịch sử hoạt động
                    </button>
                    ${showReturnBtn ? `
                      <button class="history-detail-action history-action-return history-return-btn" data-id="${escapeHistoryHtml(orderId)}" type="button">
                        <i data-lucide="rotate-ccw"></i> Trả hàng
                      </button>
                    ` : ''}
                    ${showCancelBtn ? `
                      <button class="history-detail-action history-action-delete history-cancel-btn" data-id="${escapeHistoryHtml(orderId)}" type="button">
                        <i data-lucide="ban"></i> Hủy
                      </button>
                    ` : ''}
                    ${financeRole ? activeOrderReturns.map(item => `
                      <button class="history-detail-action history-return-print-btn" data-return-id="${escapeHistoryHtml(item.id)}" type="button" title="In phiếu trả ${escapeHistoryHtml(item.id)}">
                        <i data-lucide="file-text"></i> In ${escapeHistoryHtml(item.id)}
                      </button>
                      <button class="history-detail-action history-action-delete history-return-cancel-btn" data-return-id="${escapeHistoryHtml(item.id)}" type="button" title="Hủy phiếu trả ${escapeHistoryHtml(item.id)}">
                        <i data-lucide="ban"></i> Hủy phiếu trả
                      </button>
                    `).join('') : ''}
                    ${showDeleteBtn ? `
                      <button class="history-detail-action history-action-delete history-delete-btn" data-id="${escapeHistoryHtml(orderId)}" type="button">
                        <i data-lucide="trash-2"></i> Xóa
                      </button>
                    ` : ''}
                  </div>
                </section>
              </div>
            </div>
          </td>
        </tr>
      `;
    }).join('');

    ordersContentHtml = `
      <div class="table-responsive glass-panel" style="padding: 0.5rem; width: 100%; border-radius: 12px; grid-column: 1 / -1;">
        <table class="table history-details-table" style="min-width: 1375px;">
          <thead>
            <tr>
              <th style="width: 42px; text-align: center;"><input type="checkbox" id="history-select-all-export" title="Chọn tất cả đơn trên trang"></th>
              <th style="width: 45px; text-align: center;">STT</th>
              <th style="width: 120px;">Mã đơn</th>
              <th style="width: 135px;">Ngày lập</th>
              <th style="width: 170px;">Khách hàng</th>
              <th style="width: 150px;">KDQL</th>
              <th style="width: 120px;">Bảng giá</th>
              <th style="width: 140px; text-align: right;">Tổng tiền hàng</th>
              <th style="width: 125px; text-align: right;">Giảm giá</th>
              <th style="width: 120px; text-align: right;">Thu khác</th>
              <th style="width: 145px; text-align: right;">Tổng thanh toán</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows}
          </tbody>
        </table>
      </div>
    `;

  } else {
    // ---------------------- DẠNG THẺ (CARD VIEW) ----------------------
    ordersContentHtml = paginatedItems.map(order => {
      const totalItemsCount = order.items.reduce((sum, item) => sum + Number(item.quantity), 0);
      const amountBreakdown = getHistoryOrderAmountBreakdown(order, lookups);
      const displayOrderCode = getOrderDisplayCode(order);
      let statusBadge = '';
      if (['cancelled', 'canceled'].includes(String(order.status || '').toLowerCase())) {
        statusBadge = `<span style="background: rgba(107, 114, 128, 0.14); color: #6b7280; border: 1px solid rgba(107, 114, 128, 0.28); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đã hủy</span>`;
      } else if (order.status === 'draft') {
        statusBadge = `<span style="background: var(--color-danger-light); color: var(--color-danger); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đơn nháp</span>`;
      } else if (order.status === 'partially_returned') {
        statusBadge = `<span style="background: rgba(245, 158, 11, 0.15); color: #f59e0b; border: 1px solid rgba(245, 158, 11, 0.3); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Trả 1 phần</span>`;
      } else if (order.status === 'returned') {
        statusBadge = `<span style="background: rgba(168, 85, 247, 0.15); color: #a855f7; border: 1px solid rgba(168, 85, 247, 0.3); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đã trả toàn bộ</span>`;
      } else {
        statusBadge = `<span style="background: var(--color-primary-light); color: var(--color-primary); font-size: 0.7rem; font-weight: 600; padding: 1px 6px; border-radius: 4px;">Đã chốt</span>`;
      }
        
      const creatorName = getUserDisplayName(order.createdBy, 'Không xác định', state.users);

      const showDeleteBtn = order.status === 'draft';
      const showCancelBtn = order.status === 'settled' && ['admin', 'accounting'].includes(state.currentUser?.role);
      const showReturnBtn = ['settled', 'partially_returned'].includes(order.status)
        && ['admin', 'accounting'].includes(state.currentUser?.role);
      const activeOrderReturns = lookups.activeReturnsByOrderId.get(String(order.id)) || [];
      const showAmendBtn = order.status === 'settled'
        && ['admin', 'accounting'].includes(state.currentUser?.role)
        && activeOrderReturns.length === 0;

      const cust = getHistoryCustomer(order, lookups);
      
      let managerName = 'Chưa phân công';
      let plName = 'Nhập tay';
      let debtText = '0 ₫';
      
      if (cust) {
        managerName = cust.managedBy ? getManagerDisplayName(cust.managedBy, state.users) : 'Chưa phân công';
        
        const pl = lookups.pricelistById.get(String(cust.pricelistId));
        plName = pl ? pl.name : (cust.pricelistId === 'custom' ? 'Chiết khấu riêng' : (cust.pricelistId === 'retail' ? 'Nhập tay' : 'Chưa xác định'));
        
        debtText = formatCurrency(cust.debt || 0);
      } else {
        const orderPlId = order.pricelistId || 'retail';
        const pl = lookups.pricelistById.get(String(orderPlId));
        plName = pl ? pl.name : (orderPlId === 'custom' ? 'Chiết khấu riêng' : (orderPlId === 'retail' ? 'Nhập tay' : 'Chiết khấu riêng'));
      }

      return `
        <div class="glass-panel order-card flex flex-col justify-between" style="padding: 1.25rem; gap: 1rem; position: relative;">
          <label style="position: absolute; top: 0.9rem; left: 0.9rem; z-index: 2;" title="Chọn đơn để xuất Excel">
            <input type="checkbox" class="history-export-checkbox" data-id="${order.id}" ${selectedHistoryOrderIdsForExport.has(String(order.id)) ? 'checked' : ''}>
          </label>
          ${showDeleteBtn ? `
            <button class="history-delete-btn" data-id="${order.id}" title="Xóa đơn hàng" style="position: absolute; top: 0.85rem; right: 0.85rem; width: 26px; height: 26px; border-radius: 50%; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.35); color: #ef4444; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: all 0.2s; padding: 0;">
              <i data-lucide="x" style="width: 15px; height: 15px; stroke-width: 2.5;"></i>
            </button>
          ` : ''}
          <div>
            <div class="flex justify-between items-center" style="margin-bottom: 0.75rem; padding-right: ${showDeleteBtn ? '2rem' : '0'}; padding-left: 1.4rem;">
              <span class="order-id" title="${order.id}" style="font-weight: 700; color: #fff; font-size: 1.05rem;">${displayOrderCode}</span>
              <div style="display: flex; gap: 0.35rem; align-items: center;">
                ${statusBadge}
              </div>
            </div>
            
            <div class="order-meta" style="font-size: 0.85rem; color: var(--text-secondary); display: flex; flex-direction: column; gap: 0.35rem; margin-bottom: 1rem; border-bottom: 1px solid var(--border-color); padding-bottom: 0.75rem;">
              <div class="flex items-center gap-1"><i data-lucide="user" style="width:13px;height:13px;color: var(--color-primary);"></i> <span>Khách hàng: <strong>${order.customerName}</strong></span></div>
              <div class="flex items-center gap-1"><i data-lucide="calendar" style="width:13px;height:13px;"></i> <span>Ngày lập: ${formatDateTime(order.date)}</span></div>
              <div class="flex items-center gap-1"><i data-lucide="user-check" style="width:13px;height:13px;"></i> <span>Người tạo: ${creatorName}</span></div>
              <div class="flex items-center gap-1"><i data-lucide="users" style="width:13px;height:13px;"></i> <span>Kinh doanh quản lý: ${managerName}</span></div>
              <div class="flex items-center gap-1"><i data-lucide="tags" style="width:13px;height:13px;"></i> <span>Bảng giá: <strong style="color: var(--color-warning);">${plName}</strong></span></div>
              <div class="flex items-center gap-1"><i data-lucide="credit-card" style="width:13px;height:13px;"></i> <span>Công nợ hiện tại: <strong style="color: var(--color-danger);">${debtText}</strong></span></div>
              <div class="flex items-start gap-1"><i data-lucide="notebook-pen" style="width:13px;height:13px;margin-top:2px;"></i> <span>Ghi chú đơn: <strong>${escapeHistoryHtml(order.notes || 'Không có')}</strong></span></div>
            </div>
            
            <div class="order-details-summary" style="font-size: 0.85rem; background: rgba(255,255,255,0.02); border-radius: 6px; padding: 0.5rem 0.75rem; border: 1px solid var(--border-color); margin-bottom: 1rem; max-height: 120px; overflow-y: auto;">
              <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.25rem; font-size: 0.75rem; text-transform: uppercase;">Chi tiết mặt hàng (${totalItemsCount}):</div>
              <ul style="list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.25rem;">
                ${order.items.map(item => `
                  <li style="display: flex; justify-content: space-between; color: var(--text-secondary); font-size: 0.8rem;">
                    <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px;" title="${item.productName || item.product.name} (${item.package})">${item.productName || item.product.name} (${item.package})</span>
                    <span>${item.quantity} x ${formatCurrency(item.price)}</span>
                  </li>
                `).join('')}
              </ul>
            </div>
          </div>
          
          <div>
            <div class="history-card-financials">
              <div><span>Tổng tiền hàng</span><strong>${formatNumber(amountBreakdown.totalBeforeDiscount)}</strong></div>
              <div><span>Giảm giá</span><strong class="history-money-discount">${formatNumber(amountBreakdown.totalDiscountAmount)}</strong></div>
              <div><span>Thu khác</span><strong class="history-money-other-fee">${formatNumber(amountBreakdown.shippingFeeAmount)}</strong></div>
              <div><span>Tổng thanh toán</span><strong class="history-money-total">${formatNumber(amountBreakdown.totalPayment)}</strong></div>
            </div>
            
            <div class="order-actions" style="display: grid; grid-template-columns: repeat(auto-fit, minmax(75px, 1fr)); gap: 0.35rem;">
              <button class="btn btn-indigo btn-sm flex items-center justify-center gap-1 history-print-btn" data-id="${order.id}">
                <i data-lucide="printer" style="width: 13px; height: 13px;"></i> In
              </button>
              <button class="btn btn-secondary btn-sm flex items-center justify-center gap-1 history-copy-btn" data-id="${order.id}" title="Sao chép thành đơn mới">
                <i data-lucide="copy" style="width: 13px; height: 13px;"></i> Sao chép
              </button>
              <button class="btn btn-secondary btn-sm flex items-center justify-center gap-1 history-activity-btn" data-id="${order.id}" title="Xem lịch sử hoạt động của đơn">
                <i data-lucide="history" style="width: 13px; height: 13px;"></i> Hoạt động
              </button>
              ${['admin', 'accounting'].includes(state.currentUser?.role) ? `
                <button class="btn btn-secondary btn-sm flex items-center justify-center gap-1 history-notes-btn" data-id="${order.id}" title="Sửa riêng ghi chú, không thay đổi đơn hoặc công nợ">
                  <i data-lucide="notebook-pen" style="width: 13px; height: 13px;"></i> Ghi chú
                </button>
              ` : ''}
              
              ${order.status === 'draft' ? `
                <button class="btn btn-primary btn-sm flex items-center justify-center gap-1 history-edit-btn" data-id="${order.id}">
                  <i data-lucide="edit" style="width: 13px; height: 13px;"></i> Sửa
                </button>
              ` : `
                ${showAmendBtn ? `
                  <button class="btn btn-primary btn-sm flex items-center justify-center gap-1 history-edit-btn" data-id="${order.id}" title="Sửa đơn đã chốt">
                    <i data-lucide="edit" style="width: 13px; height: 13px;"></i> Sửa
                  </button>
                ` : ''}
                ${showReturnBtn ? `
                  <button class="btn btn-warning btn-sm flex items-center justify-center gap-1 history-return-btn" data-id="${order.id}" style="background: #f59e0b; border-color: #f59e0b; color: #fff;">
                    <i data-lucide="rotate-ccw" style="width: 13px; height: 13px;"></i> Trả
                  </button>
                ` : ''}
                ${showCancelBtn ? `
                  <button class="btn btn-danger btn-sm flex items-center justify-center gap-1 history-cancel-btn" data-id="${order.id}">
                    <i data-lucide="ban" style="width: 13px; height: 13px;"></i> Hủy
                  </button>
                ` : ''}
                ${['admin', 'accounting'].includes(state.currentUser?.role) ? activeOrderReturns.map(item => `
                  <button class="btn btn-secondary btn-sm flex items-center justify-center gap-1 history-return-print-btn" data-return-id="${escapeHistoryHtml(item.id)}" title="In phiếu trả ${escapeHistoryHtml(item.id)}" aria-label="In phiếu trả ${escapeHistoryHtml(item.id)}">
                    <i data-lucide="file-text" style="width: 13px; height: 13px;"></i> In phiếu
                  </button>
                  <button class="btn btn-danger btn-sm history-return-cancel-btn" data-return-id="${escapeHistoryHtml(item.id)}" title="Hủy phiếu trả ${escapeHistoryHtml(item.id)}" aria-label="Hủy phiếu trả ${escapeHistoryHtml(item.id)}">
                    <i data-lucide="ban" style="width: 13px; height: 13px;"></i>
                  </button>
                `).join('') : ''}
              `}
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  const paginationHtml = `
    <div class="pagination-controls" style="grid-column: 1 / -1; display: flex; justify-content: center; align-items: center; gap: 1rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border-color); width: 100%;">
      <button class="btn btn-secondary btn-sm" id="history-prev-page" ${state.historyPage === 1 ? 'disabled' : ''}>
        <i data-lucide="chevron-left" style="width: 16px; height: 16px;"></i> Trước
      </button>
      <span style="font-size: 0.9rem; color: var(--text-secondary); font-weight: 500;">
        Trang <strong>${state.historyPage}</strong> / ${totalPages} (${totalItems} đơn)
      </span>
      <button class="btn btn-secondary btn-sm" id="history-next-page" ${state.historyPage === totalPages ? 'disabled' : ''}>
        Sau <i data-lucide="chevron-right" style="width: 16px; height: 16px;"></i>
      </button>
    </div>
  `;

  container.innerHTML = ordersContentHtml + paginationHtml;

  const prevPageBtn = document.getElementById('history-prev-page');
  if (prevPageBtn) {
    prevPageBtn.addEventListener('click', () => {
      state.historyPage--;
      renderHistoryOrders({ reuseFiltered: true });
      container.scrollIntoView({ behavior: 'smooth' });
    });
  }

  const nextPageBtn = document.getElementById('history-next-page');
  if (nextPageBtn) {
    nextPageBtn.addEventListener('click', () => {
      state.historyPage++;
      renderHistoryOrders({ reuseFiltered: true });
      container.scrollIntoView({ behavior: 'smooth' });
    });
  }

  const syncExpandedOrderDom = (nextOrderId) => {
    expandedHistoryOrderId = nextOrderId;
    container.querySelectorAll('.history-order-row').forEach(row => {
      const expanded = String(row.dataset.orderId) === String(nextOrderId || '');
      row.classList.toggle('is-expanded', expanded);
      row.setAttribute('aria-expanded', String(expanded));
      const toggle = row.querySelector('.history-row-toggle');
      if (toggle) {
        const order = paginatedItems.find(item => String(item.id) === String(row.dataset.orderId));
        toggle.setAttribute('aria-label', `${expanded ? 'Thu gọn' : 'Mở chi tiết'} đơn ${order ? getOrderDisplayCode(order) : ''}`.trim());
      }
      const detailRow = document.getElementById(row.getAttribute('aria-controls'));
      if (detailRow) {
        detailRow.classList.toggle('is-expanded', expanded);
        detailRow.setAttribute('aria-hidden', String(!expanded));
        const panel = detailRow.querySelector('.history-expanded-panel');
        if (panel) panel.inert = !expanded;
      }
    });
  };

  const toggleHistoryOrder = (orderId) => {
    const normalizedId = String(orderId || '');
    syncExpandedOrderDom(expandedHistoryOrderId === normalizedId ? null : normalizedId);
  };

  const rowInteractiveSelector = 'input, button, textarea, select, a, label, [role="link"]';
  container.querySelectorAll('.history-order-row').forEach(row => {
    row.addEventListener('click', event => {
      if (event.target.closest(rowInteractiveSelector)) return;
      toggleHistoryOrder(row.dataset.orderId);
    });
    row.addEventListener('keydown', event => {
      if (event.target !== row || !['Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      toggleHistoryOrder(row.dataset.orderId);
    });
  });

  container.querySelectorAll('.history-row-toggle').forEach(button => {
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      toggleHistoryOrder(button.dataset.id);
    });
  });

  container.querySelectorAll('.history-expanded-panel button, .history-expanded-panel textarea').forEach(element => {
    element.addEventListener('click', event => event.stopPropagation());
  });

  // Gán sự kiện click cho các nút hành động trong lịch sử
  document.querySelectorAll('.history-export-checkbox').forEach(box => {
    box.addEventListener('click', event => event.stopPropagation());
    box.addEventListener('change', () => {
      const id = String(box.getAttribute('data-id'));
      if (box.checked) selectedHistoryOrderIdsForExport.add(id);
      else selectedHistoryOrderIdsForExport.delete(id);
      const selectAll = document.getElementById('history-select-all-export');
      if (selectAll) {
        const visibleIds = paginatedItems.map(o => String(o.id));
        selectAll.checked = visibleIds.length > 0 && visibleIds.every(id => selectedHistoryOrderIdsForExport.has(id));
      }
    });
  });

  const selectAllHistory = document.getElementById('history-select-all-export');
  if (selectAllHistory) {
    const visibleIds = paginatedItems.map(o => String(o.id));
    selectAllHistory.checked = visibleIds.length > 0 && visibleIds.every(id => selectedHistoryOrderIdsForExport.has(id));
    selectAllHistory.onchange = () => {
      visibleIds.forEach(id => {
        if (selectAllHistory.checked) selectedHistoryOrderIdsForExport.add(id);
        else selectedHistoryOrderIdsForExport.delete(id);
      });
      renderHistoryOrders({ reuseFiltered: true });
    };
  }

  document.querySelectorAll('.history-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const b = e.currentTarget;
      const id = b.getAttribute('data-id');
      printOrderById(id);
    });
  });

  document.querySelectorAll('.history-delete-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const b = e.currentTarget;
      const id = b.getAttribute('data-id');
      deleteOrder(id);
    });
  });

  document.querySelectorAll('.history-edit-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const b = e.currentTarget;
      const id = b.getAttribute('data-id');
      const order = state.savedOrders.find(o => String(o.id) === String(id));
      if (order) {
        loadDraftOrderIntoInvoice(order);
      }
    });
  });

  document.querySelectorAll('.history-return-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const b = e.currentTarget;
      const id = b.getAttribute('data-id');
      openSalesReturnModal(id);
    });
  });

  document.querySelectorAll('.history-activity-btn').forEach(btn => {
    btn.addEventListener('click', () => globalThis.openOrderActivityModal?.(btn.dataset.id));
  });

  document.querySelectorAll('.history-copy-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      const order = state.savedOrders.find(item => String(item.id) === String(id));
      if (order) loadDraftOrderIntoInvoice(order, false, true);
    });
  });

  document.querySelectorAll('.history-notes-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const id = e.currentTarget.getAttribute('data-id');
      const order = state.savedOrders.find(item => String(item.id) === String(id));
      if (!order) return;

      const expandedPanel = e.currentTarget.closest('.history-expanded-panel');
      const textarea = expandedPanel?.querySelector('.history-order-notes-input');
      const nextNotes = textarea
        ? textarea.value
        : window.prompt(
          `Sửa ghi chú riêng của đơn ${getOrderDisplayCode(order)} (để trống nếu muốn xóa):`,
          order.notes || ''
        );
      if (nextNotes === null || nextNotes.trim() === String(order.notes || '').trim()) return;

      e.currentTarget.disabled = true;
      const result = await dbUpdateOrderNotes(order.id, nextNotes.trim(), order.status === 'draft');
      if (!result) {
        e.currentTarget.disabled = false;
        return;
      }

      order.notes = result.notes ?? nextNotes.trim();
      order.updatedAt = result.updated_at || new Date().toISOString();
      cacheOrdersLocally(state.savedOrders);
      renderHistoryOrders({ reuseFiltered: true });
      showToast(`Đã cập nhật ghi chú đơn ${getOrderDisplayCode(order)}. Đơn và công nợ không thay đổi.`, 'success');
    });
  });

  document.querySelectorAll('.history-cancel-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = e.currentTarget.getAttribute('data-id');
      cancelOrderById(id);
    });
  });

  document.querySelectorAll('.history-return-print-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const returnId = e.currentTarget.getAttribute('data-return-id');
      const salesReturn = state.salesReturns.find(item => String(item.id) === String(returnId));
      if (salesReturn) printReturnSlip(salesReturn);
    });
  });

  document.querySelectorAll('.history-return-cancel-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      cancelSalesReturn(e.currentTarget.getAttribute('data-return-id'));
    });
  });

  safeCreateIcons();
}



function loadDraftOrderIntoInvoice(order, isReadOnly = false, isCopy = false) {
  // Every history action starts from a clean customer/builder state. This is
  // especially important for guest drafts, which have a name snapshot but no
  // customer record and must not inherit quick-create or prior-customer state.
  resetInvoiceBuilder();
  const isFinalizedAmendment = !isReadOnly && order.status === 'settled';
  const isAmendment = isFinalizedAmendment && !isCopy;
  syncInvoiceBusinessDateControl(
    isCopy ? currentBusinessDateInputValue() : orderDateToInputValue(order.date),
    isReadOnly
  );
  // Đồng bộ khách hàng
  const customerContext = resolveOrderCustomerForEditing(order, state.customers);
  if (!customerContext.isGuest) {
    const cust = customerContext.customer;
    if (cust) {
      state.activeCustomerId = cust.id;
      state.activeCustomerBrand = cust.assignedBrand;
      document.getElementById('invoice-customer-id').value = cust.id;
      document.getElementById('invoice-customer-search').value = cust.name;
      document.getElementById('invoice-customer-search').dataset.selectedCustomerName = cust.name;
      document.getElementById('invoice-customer-search').disabled = isReadOnly;
      const clearCustomerButton = document.getElementById('btn-clear-invoice-customer');
      if (clearCustomerButton) clearCustomerButton.style.display = isReadOnly ? 'none' : 'inline-flex';
      document.getElementById('invoice-customer-info-card').style.display = 'block';
      document.getElementById('selected-customer-name-lbl').innerText = cust.name;
      document.getElementById('selected-customer-phone-lbl').innerText = cust.phone || 'N/A';
      document.getElementById('selected-customer-address-lbl').innerText = cust.address || 'N/A';
      const customerNotesLbl = document.getElementById('selected-customer-notes-lbl');
      if (customerNotesLbl) customerNotesLbl.innerText = cust.notes || 'Không có';
      document.getElementById('selected-customer-brand-lbl').innerText = cust.assignedBrand;
      
      const pl = state.pricelists.find(p => p.id === cust.pricelistId);
      const plName = pl ? pl.name : (cust.pricelistId === 'custom' ? 'Chiết khấu riêng' : (cust.pricelistId === 'retail' ? 'Nhập tay' : 'Chiết khấu riêng'));
      const plLbl = document.getElementById('selected-customer-pricelist-lbl');
      if (plLbl) plLbl.innerText = plName;
      
      document.getElementById('selected-customer-debt-lbl').innerText = formatCurrency(cust.debt);
    }
  } else {
    // Khách lẻ chỉ là tên snapshot trên đơn, không phải chế độ tạo nhanh
    // khách hàng mới (chế độ đó còn yêu cầu tỉnh, nhãn và quản lý).
    state.activeCustomerId = '';
    state.activeCustomerBrand = 'Tất cả';
    state.isQuickCustomerMode = false;
    const customerIdInput = document.getElementById('invoice-customer-id');
    if (customerIdInput) customerIdInput.value = '';
    const customerSearchInput = document.getElementById('invoice-customer-search');
    if (customerSearchInput) {
      customerSearchInput.value = customerContext.customerName;
      customerSearchInput.disabled = isReadOnly;
      customerSearchInput.removeAttribute('data-selected-customer-name');
    }
    const customerInfoCard = document.getElementById('invoice-customer-info-card');
    if (customerInfoCard) customerInfoCard.style.display = 'none';
    const clearCustomerButton = document.getElementById('btn-clear-invoice-customer');
    if (clearCustomerButton) clearCustomerButton.style.display = isReadOnly ? 'none' : 'inline-flex';
  }
  
  // Tải các mặt hàng
  state.invoiceItems = normalizeOrderItemsForEditing(order.items, state.products)
    .map(item => ({
      ...item,
      priceListId: item.priceListId || order.pricelistId || ''
    }));
  
  // Cài đặt Ghi chú & bảng giá
  document.getElementById('invoice-notes').value = order.notes || '';
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (plSelect) {
    const orderPriceListId = order.pricelistId || 'retail';
    const customerDefaultPriceListId = customerContext.customer
      ? getApplicablePriceList(
        customerContext.customer,
        state.allPricelists.length ? state.allPricelists : state.pricelists
      ).priceList?.id || ''
      : '';
    const orderPriceList = (state.pricelists || []).find(priceList => priceList.id === orderPriceListId);
    const isGlobalPriceList = Boolean(
      orderPriceList
      && normalizePriceListType(orderPriceList.type, orderPriceList.customerId) === PRICE_LIST_TYPES.GENERAL
      && !orderPriceList.customerId
      && !orderPriceList.customerGroupId
    );
    plSelect.value = orderPriceListId;
    plSelect.dataset.explicitOverride = String(
      orderPriceListId !== 'retail'
      && Boolean(orderPriceListId)
      && orderPriceListId !== customerDefaultPriceListId
      && isGlobalPriceList
    );
  }
  
  // Thiết lập Giảm giá & Thu khác
  const discValInput = document.getElementById('invoice-discount-value');
  const discTypeSelect = document.getElementById('invoice-discount-type');
  const feeValInput = document.getElementById('invoice-other-fee-value');
  const feeTypeSelect = document.getElementById('invoice-other-fee-type');
  const shippingFeeValInput = document.getElementById('invoice-shipping-fee-value');

  const discType = order.discountType || 'amount';
  const discVal = order.discountValue || 0;
  if (discTypeSelect) discTypeSelect.value = discType;
  if (discValInput) {
    discValInput.value = discType === 'percent' ? discVal : formatNumber(discVal);
  }

  const feeType = order.otherFeeType || 'amount';
  const feeVal = order.otherFeeValue || 0;
  if (feeTypeSelect) feeTypeSelect.value = feeType;
  if (feeValInput) {
    feeValInput.value = feeType === 'percent' ? feeVal : formatNumber(feeVal);
  }
  if (shippingFeeValInput) {
    shippingFeeValInput.value = formatNumber(order.shippingFeeValue || order.shippingFeeAmount || 0);
  }
  
  // Đổi tiêu đề và trạng thái nút chốt đơn trên giao diện lập hóa đơn
  const saveBtn = document.getElementById('btn-save-order');
  const draftBtn = document.getElementById('btn-draft-order');
  const panelTitle = document.querySelector('#invoice-panel .panel-title');

  if (saveBtn) {
    saveBtn.removeAttribute('data-edit-order-id');
    saveBtn.removeAttribute('data-amend-order-id');
  }
  
  if (isReadOnly) {
    if (saveBtn) saveBtn.style.display = 'none';
    if (draftBtn) draftBtn.style.display = 'none';
    if (panelTitle) panelTitle.innerHTML = `<i data-lucide="eye"></i> Chi tiết đơn hàng ${getOrderDisplayCode(order)} (Chỉ xem)`;
  } else {
    if (saveBtn) {
      saveBtn.style.display = 'inline-flex';
      if (isAmendment) {
        saveBtn.innerHTML = `<i data-lucide="check-square"></i> Lưu bản sửa & chốt lại`;
        saveBtn.setAttribute('data-amend-order-id', order.id);
      } else if (isCopy) {
        saveBtn.innerHTML = `<i data-lucide="check-square"></i> Thanh toán & Chốt đơn mới`;
      } else {
        saveBtn.innerHTML = `<i data-lucide="check-square"></i> Chốt đơn`;
        saveBtn.setAttribute('data-edit-order-id', order.id);
      }
    }
    if (draftBtn) {
      draftBtn.style.display = isAmendment ? 'none' : 'inline-flex';
      if (!isAmendment) {
        draftBtn.innerHTML = isCopy
          ? `<i data-lucide="file-text"></i> Lưu thành đơn nháp mới`
          : `<i data-lucide="file-text"></i> Cập nhật nháp`;
      }
    }
    if (panelTitle) {
      panelTitle.innerHTML = isCopy
        ? `<i data-lucide="copy"></i> Đơn mới sao chép từ ${getOrderDisplayCode(order)}`
        : isAmendment
        ? `<i data-lucide="edit"></i> Sửa đơn đã chốt ${getOrderDisplayCode(order)}`
        : `<i data-lucide="edit"></i> Hiệu chỉnh đơn nháp ${getOrderDisplayCode(order)}`;
    }
  }
  
  // Chuyển Tab
  if (plSelect) {
    plSelect.disabled = isReadOnly;
  }
  const plGroup = document.getElementById('invoice-pricelist-group');
  if (plGroup) plGroup.style.display = isReadOnly ? 'none' : 'block';

  // Keep the central navigation state aligned with the panel shown below.
  // Realtime/background renders use currentTab as their source of truth; if it
  // remains on history-panel they immediately pull the user out of order edit.
  state.currentTab = 'invoice-panel';

  document.querySelectorAll('.nav-link').forEach(l => {
    if (l.getAttribute('data-target') === 'invoice-panel') {
      l.classList.add('active');
    } else {
      l.classList.remove('active');
    }
  });

  document.querySelectorAll('.panel').forEach(p => {
    if (p.id === 'invoice-panel') {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });
  
  const heading = document.getElementById('page-title-heading');
  if (heading) heading.innerText = isCopy ? 'Tạo hóa đơn từ bản sao' : 'Cập nhật hóa đơn';
  
  // Tải lại bảng
  const invoiceItemsBody = document.getElementById('invoice-items-body');
  const emptyRow = document.getElementById('invoice-empty-row');
  if (emptyRow) emptyRow.style.display = 'none';
  
  // Re-render
  const renderInvTable = document.getElementById('invoice-items-body');
  if (renderInvTable) {
    // Gọi tính toán và vẽ lại bảng
    document.getElementById('invoice-product-search').focus();
  }
  
  // Trình kích hoạt Render bảng
  const event = new CustomEvent('loadDraftOrder', { detail: { order, isReadOnly, isCopy } });
  document.dispatchEvent(event);

  if (isCopy) {
    showToast(`Đã sao chép dữ liệu từ đơn ${getOrderDisplayCode(order)}. Hãy kiểm tra và lưu để tạo mã đơn mới.`, 'success');
  }
}

// --- PHÂN HỆ TRẢ HÀNG (SALES RETURN LOGIC) ---

export function openSalesReturnModal(orderId) {
  if (!['admin', 'accounting'].includes(state.currentUser?.role)) {
    showToast('Chỉ Admin hoặc Kế toán được lập phiếu trả hàng.', 'danger');
    return;
  }
  const order = state.savedOrders.find(o => String(o.id) === String(orderId));

  if (!order) {
    showToast('Không tìm thấy thông tin đơn hàng!', 'danger');
    return;
  }
  
  const modal = document.getElementById('sales-return-modal');
  if (!modal) return;

  document.getElementById('return-order-id').value = order.id;
  document.getElementById('return-meta-order-id').innerText = order.id;
  document.getElementById('return-meta-customer').innerText = order.customerName;
  document.getElementById('return-meta-date').innerText = formatDateTime(order.date);
  document.getElementById('return-meta-creator').innerText = state.currentUser ? state.currentUser.displayName : 'Administrator';
  document.getElementById('return-reason-input').value = '';
  document.getElementById('return-refund-method').value = 'cash';
  pendingSalesReturnKey = globalThis.crypto.randomUUID();

  const existingReturns = (state.salesReturns || []).filter(r => r.saleId === order.id && r.status !== 'cancelled');
  
  const returnedMap = {};
  existingReturns.forEach(ret => {
    (ret.items || []).forEach(item => {
      const key = item.saleItemId || `${item.variantCode || item.productId || item.variantId}_${item.packagingName || item.packageType}`;
      returnedMap[key] = (returnedMap[key] || 0) + (item.quantity || 0);
    });
  });

  const tbody = document.getElementById('sales-return-items-body');
  if (!tbody) return;

  const orderItemsSubtotal = (order.items || []).reduce((sum, item) => {
    const qty = Number(item.quantity || 0);
    const price = Number(item.price || 0);
    const discountPercent = Number(item.discountPercent || 0);
    return sum + Math.max(0, qty * price * (1 - discountPercent / 100));
  }, 0);
  const orderDiscountRatio = orderItemsSubtotal > 0 && Number(order.totalPayable || 0) > 0
    ? Math.min(1, Number(order.totalPayable || 0) / orderItemsSubtotal)
    : 1;

  tbody.innerHTML = (order.items || []).map((item, idx) => {
    const variantId = item.variantId || item.productId || '';
    const variantCode = item.variantCode || item.variantCodeSnapshot || item.productCode || item.code || '';
    const packagingName = item.packagingName || item.packagingNameSnapshot || item.package || '';
    const specification = item.specificationSnapshot || item.weightOrVolumeSnapshot || [
      packagingName,
      item.weightOrVolume ?? item.packageWeight ?? '',
      item.unitName || item.packageWeightUnit || ''
    ].filter(Boolean).join(' ').trim();
    const itemKey = item.id || `${variantCode || variantId}_${packagingName}`;
    const soldQty = Number(item.quantity || 0);
    const prevReturned = returnedMap[itemKey] || 0;
    const maxReturnable = Math.max(0, soldQty - prevReturned);
    const basePrice = Number(item.price || 0);
    const discountPercent = Number(item.discountPercent || 0);
    const unitPrice = Math.round(Math.max(0, basePrice * (1 - discountPercent / 100) * orderDiscountRatio));
    const prodName = item.productName || (item.product && item.product.name) || item.name || 'Sản phẩm';

    return `
      <tr class="return-item-row" data-key="${itemKey}" data-sale-item-id="${item.id || ''}" data-product-id="${variantCode}" data-variant-id="${variantId}" data-variant-code="${variantCode}" data-product-name="${prodName}" data-package="${packagingName}" data-specification="${specification}" data-unit-price="${unitPrice}" data-sold-qty="${soldQty}" data-prev-returned="${prevReturned}" data-max-returnable="${maxReturnable}" data-product-brand="${item.productBrand || item.brand || ''}" data-agency-brand="${item.agencyBrand || ''}" data-revenue-brand="${item.revenueBrand || ''}" data-revenue-company="${item.revenueCompany || order.companyId || ''}">
        <td>${idx + 1}</td>
        <td style="font-weight: 600; color: #fff;">${prodName}<br><small>${variantCode}</small></td>
        <td>${specification || packagingName || 'Cái'}</td>
        <td style="text-align: right;">${formatCurrency(unitPrice)}</td>
        <td style="text-align: center; font-weight: 600;">${soldQty}</td>
        <td style="text-align: center; color: var(--color-warning);">${prevReturned}</td>
        <td style="text-align: center;">
          <input type="number" class="form-control return-qty-input" min="0" max="${maxReturnable}" value="0" ${maxReturnable === 0 ? 'disabled' : ''} style="width: 70px; text-align: center; font-weight: 700; height: 32px; padding: 2px;">
        </td>
        <td style="text-align: center;">
          <input type="number" class="form-control return-deduction-percent-input" min="0" max="100" step="0.01" value="0" ${maxReturnable === 0 ? 'disabled' : ''} aria-label="Phần trăm khấu trừ khi trả ${prodName}" style="width: 72px; text-align: center; font-weight: 700; height: 32px; padding: 2px;">
        </td>
        <td style="text-align: right; font-weight: 600; color: var(--color-primary);" class="return-refund-price-lbl">${formatCurrency(unitPrice)}</td>
        <td style="text-align: right; font-weight: 700; color: #f59e0b;" class="return-subtotal-lbl">0 ₫</td>
      </tr>
    `;
  }).join('');

  const recalculateTotals = () => {
    let totalRefund = 0;
    document.querySelectorAll('.return-item-row').forEach(row => {
      const unitPrice = parseFloat(row.getAttribute('data-unit-price')) || 0;
      const maxReturnable = parseFloat(row.getAttribute('data-max-returnable')) || 0;
      
      const qtyInput = row.querySelector('.return-qty-input');
      const deductionInput = row.querySelector('.return-deduction-percent-input');
      let qty = parseFloat(qtyInput.value) || 0;
      let deductionPercent = parseFloat(deductionInput?.value) || 0;
      if (qty < 0) { qty = 0; qtyInput.value = 0; }
      if (qty > maxReturnable) {
        showToast(`Số lượng trả không được vượt quá số lượng còn lại (${maxReturnable})!`, 'warning');
        qty = maxReturnable;
        qtyInput.value = maxReturnable;
      }
      if (deductionPercent < 0) { deductionPercent = 0; deductionInput.value = 0; }
      if (deductionPercent > 100) {
        showToast('Khấu trừ trả hàng phải nằm trong khoảng từ 0% đến 100%.', 'warning');
        deductionPercent = 100;
        deductionInput.value = 100;
      }

      const refundPrice = Math.round(unitPrice * (1 - deductionPercent / 100));
      const subtotal = Math.round(unitPrice * qty * (1 - deductionPercent / 100));

      row.querySelector('.return-refund-price-lbl').innerText = formatCurrency(refundPrice);
      row.querySelector('.return-subtotal-lbl').innerText = formatCurrency(subtotal);

      totalRefund += subtotal;
    });

    document.getElementById('return-total-refund-lbl').innerText = formatCurrency(totalRefund);

    const cust = order.customerId ? state.customers.find(c => c.id === order.customerId) : null;
    const warningDiv = document.getElementById('return-excess-warning');
    const excessAmtLbl = document.getElementById('return-excess-amount');
    
    if (cust && warningDiv && excessAmtLbl) {
      const currentDebt = parseFloat(cust.debt || 0);
      const debtAfter = currentDebt - totalRefund;
      if (debtAfter < 0) {
        warningDiv.style.display = 'block';
        excessAmtLbl.innerText = formatCurrency(Math.abs(debtAfter));
      } else {
        warningDiv.style.display = 'none';
      }
    }
  };

  document.querySelectorAll('.return-qty-input, .return-deduction-percent-input').forEach(el => {
    el.addEventListener('input', recalculateTotals);
    el.addEventListener('change', recalculateTotals);
  });

  recalculateTotals();
  modal.classList.add('active');
}

export async function processSalesReturnSubmit(e) {
  e.preventDefault();
  
  const orderId = document.getElementById('return-order-id').value;
  const reason = document.getElementById('return-reason-input').value.trim();
  
  const order = state.savedOrders.find(o => o.id === orderId);
  if (!order) {
    showToast('Không tìm thấy thông tin đơn hàng gốc!', 'danger');
    return;
  }

  if (!reason) {
    showToast('Vui lòng nhập lý do trả hàng!', 'warning');
    return;
  }

  const returnItems = [];
  let hasValidQty = false;
  let validationError = false;

  document.querySelectorAll('.return-item-row').forEach(row => {
    const qty = parseFloat(row.querySelector('.return-qty-input').value) || 0;
    const deductionPercent = parseFloat(row.querySelector('.return-deduction-percent-input')?.value) || 0;
    const maxReturnable = parseFloat(row.getAttribute('data-max-returnable')) || 0;
    const prodName = row.getAttribute('data-product-name');
    
    if (qty > maxReturnable) {
      showToast(`Sản phẩm "${prodName}" có số lượng trả (${qty}) vượt quá giới hạn cho phép (${maxReturnable})!`, 'danger');
      validationError = true;
      return;
    }
    if (deductionPercent < 0 || deductionPercent > 100) {
      showToast(`Khấu trừ của sản phẩm "${prodName}" phải nằm trong khoảng từ 0% đến 100%.`, 'danger');
      validationError = true;
      return;
    }

    if (qty > 0) {
      hasValidQty = true;
      returnItems.push({
        saleItemId: row.getAttribute('data-sale-item-id'),
        quantity: qty,
        deductionPercent
      });
    }
  });

  if (validationError) return;

  if (!hasValidQty) {
    showToast('Vui lòng chọn ít nhất 1 sản phẩm có số lượng trả > 0!', 'warning');
    return;
  }

  if (!pendingSalesReturnKey) pendingSalesReturnKey = globalThis.crypto.randomUUID();
  const returnObj = {
    saleId: order.id,
    reason: reason,
    paymentMethod: document.getElementById('return-refund-method').value,
    idempotencyKey: pendingSalesReturnKey
  };
  const returnResult = await dbRecordSalesReturn(returnObj, returnItems);
  if (!returnResult?.return) return;
  const persistedReturn = {
    ...returnResult.return,
    customerName: order.customerName,
    creatorName: state.currentUser?.displayName || returnResult.return.createdBy
  };
  const existingIndex = state.salesReturns.findIndex(item => item.id === persistedReturn.id);
  if (existingIndex === -1) state.salesReturns.unshift(persistedReturn);
  else state.salesReturns[existingIndex] = persistedReturn;
  order.status = returnResult.order_status;
  order.returnedAmount = Number(returnResult.order_returned_amount || 0);
  order.netRevenue = Number(returnResult.order_net_revenue || 0);
  localStorage.setItem('billing_system_sales_returns', JSON.stringify(state.salesReturns));
  cacheOrdersLocally(state.savedOrders);

  // 4. Update Customer Debt, Total Return & Net Revenue
  if (order.customerId) {
    const cust = state.customers.find(c => c.id === order.customerId);
    if (cust) {
      cust.debt = Number(returnResult.new_debt);
      cust.totalReturn = Number(returnResult.new_total_return);
      cust.netRevenue = Number(returnResult.new_net_revenue);

      const localLedgerId = returnResult.debt_ledger_id || `return-${persistedReturn.id}`;
      if (!cust.debtHistory) cust.debtHistory = [];
      if (!returnResult.already_recorded && !cust.debtHistory.some(item => item.id === localLedgerId)) {
        cust.debtHistory.push({
          date: new Date().toISOString(),
          type: 'return',
          id: localLedgerId,
          amount: Number(returnResult.debt_reduction || 0),
          debtAfter: cust.debt,
          note: `Phiếu trả hàng ${persistedReturn.id} cho đơn ${order.id}: ${reason}`
        });
      }
    }
  }
  localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));

  document.getElementById('sales-return-modal').classList.remove('active');
  pendingSalesReturnKey = '';
  renderAll();
  showToast(`Đã tạo thành công phiếu trả hàng ${persistedReturn.id}!`, 'success');
}

export async function cancelSalesReturn(returnId) {
  const ret = (state.salesReturns || []).find(r => r.id === returnId);
  if (!ret || ret.status === 'cancelled') {
    showToast('Phiếu trả hàng không tồn tại hoặc đã được hủy trước đó!', 'danger');
    return;
  }

  const cancellationReason = prompt(`Nhập lý do hủy phiếu trả hàng [${returnId}]:`, 'Hủy theo yêu cầu nghiệp vụ');
  if (cancellationReason === null) return;
  if (cancellationReason.trim().length < 3) {
    showToast('Lý do hủy phải có ít nhất 3 ký tự.', 'warning');
    return;
  }
  if (!confirm(`Xác nhận hủy phiếu [${returnId}]? Database sẽ đảo công nợ, tiền hoàn, doanh số và hoa hồng.`)) return;

  const order = state.savedOrders.find(o => o.id === ret.saleId);
  const cancelResult = await dbCancelSalesReturn(ret.id, cancellationReason.trim());
  if (!cancelResult) return;

  ret.status = 'cancelled';
  ret.cancelledAt = cancelResult.cancelled_at || new Date().toISOString();
  ret.cancellationReason = cancelResult.cancellation_reason || cancellationReason.trim();

  if (ret.customerId) {
    const cust = state.customers.find(c => c.id === ret.customerId);
    if (cust) {
      cust.debt = Number(cancelResult.new_debt);
      cust.totalReturn = Number(cancelResult.new_total_return);
      cust.netRevenue = Number(cancelResult.new_net_revenue);

      if (!cancelResult.already_cancelled) {
        if (!cust.debtHistory) cust.debtHistory = [];
        cust.debtHistory.push({
          id: `return-cancel-${ret.id}`,
          date: new Date().toISOString(),
          type: 'return_cancel',
          amount: Number(ret.debtReductionAmount || 0),
          debtAfter: cust.debt,
          note: `Hủy phiếu trả hàng ${ret.id} của đơn ${ret.saleId}`
        });
      }
    }
  }

  if (order) {
    order.status = cancelResult.order_status;
    order.returnedAmount = Number(cancelResult.order_returned_amount || 0);
    order.netRevenue = Number(cancelResult.order_net_revenue || 0);
  }
  localStorage.setItem('billing_system_sales_returns', JSON.stringify(state.salesReturns));
  cacheOrdersLocally(state.savedOrders);
  localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
  renderAll();
  showToast(`Đã hủy phiếu trả hàng ${returnId} thành công!`, 'warning');
}

export function printReturnSlip(ret) {
  if (!ret) return;

  document.getElementById('print-return-id').innerText = ret.id;
  document.getElementById('print-return-sale-id').innerText = ret.saleId;
  document.getElementById('print-return-customer-name').innerText = ret.customerName;
  document.getElementById('print-return-date').innerText = formatDateTime(ret.createdAt);
  document.getElementById('print-return-creator').innerText = ret.creatorName || ret.createdBy;
  document.getElementById('print-return-reason').innerText = ret.reason || 'N/A';
  document.getElementById('print-return-total-refund').innerText = formatCurrency(ret.totalRefund);

  const tbody = document.getElementById('print-return-items-body');
  if (tbody) {
    tbody.innerHTML = (ret.items || []).map((item, idx) => `
      <tr>
        <td style="border: 1px solid #000; padding: 6px; text-align: center;">${idx + 1}</td>
        <td style="border: 1px solid #000; padding: 6px;">${item.productName}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: center;">${item.packageType || ''}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: center; font-weight: bold;">${item.quantity}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: right;">${formatCurrency(item.importPrice)}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: right;">${formatCurrency(item.refundPrice)}</td>
        <td style="border: 1px solid #000; padding: 6px; text-align: right; font-weight: bold;">${formatCurrency(item.subtotal)}</td>
      </tr>
    `).join('');
  }

  document.body.classList.add('printing-return');
  window.print();
  document.body.classList.remove('printing-return');
}

// Attach to window for inline HTML handlers
window.openSalesReturnModal = openSalesReturnModal;
window.cancelSalesReturn = cancelSalesReturn;
window.printReturnSlip = printReturnSlip;
