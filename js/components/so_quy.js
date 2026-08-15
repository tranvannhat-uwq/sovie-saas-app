import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatDateTime } from '../utils.js';
import { renderAll } from '../main.js?v=20260814-invoice-discount-label-v19';
import { dbSaveCashbookTransaction, dbSaveStartingBalances, dbRecordCustomerPayment, dbCancelCashbookEntry, dbSetCashbookStarred, dbAmendCashbookTransaction, dbReconcileLegacyCustomerReceipt, dbRefreshCustomerFinancialState, dbFetchCashbookTransactionById, dbLoadCashbookForRange, upsertCashbookTransactionSnapshot } from '../services/supabase.js?v=20260814-invoice-discount-label-v19';
import { getCanonicalCashbookId, isEffectiveCashbookTransaction } from '../domain/cashbook.js?v=20260814-invoice-discount-label-v19';

// Seed transactions (empty to start clean)
const seedTransactions = [];
let pendingReceiptIdempotencyKey = '';
let expandedCashbookTransactionId = '';
let cashbookCurrentPage = 1;
let cashbookPageSize = 20;
let cashbookTotalPages = 1;
let cashbookLastFilterSignature = '';
let cashbookRangeRequestId = 0;
let cashbookRangeReloadTimer = null;

function escapeCashbookHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[char]);
}

function getTransactionPartnerAddress(transaction = {}) {
  const directAddress = transaction.partnerAddress || transaction.partner_address;
  if (directAddress) return String(directAddress).trim();

  const customer = transaction.customerId
    ? (state.customers || []).find(item => String(item.id) === String(transaction.customerId))
    : (transaction.type === 'thu' ? findCustomerByInput(transaction.partner) : null);
  if (customer) return String(customer.address || customer.invoiceAddress || '').trim();

  const supplier = transaction.supplierId
    ? (state.suppliers || []).find(item => String(item.id) === String(transaction.supplierId))
    : findSupplierByInput(transaction.partner);
  return String(supplier?.address || '').trim();
}

function canEditCashbookTransaction(transaction = {}) {
  const transactionType = String(transaction.transactionType || '').toLowerCase();
  return ['admin', 'accounting'].includes(String(state.currentUser?.role || '').toLowerCase())
    && !isCancelledStatus(transaction.status)
    && !transaction.reversalOfId
    && !transactionType.includes('reversal');
}

function getCashbookEditRoute(transaction = {}) {
  const transactionType = String(transaction.transactionType || '').toLowerCase();
  const operationType = String(transaction.operationType || '').toLowerCase();
  if (transactionType === 'sales_return_refund' || transaction.salesReturnId) return 'return_refund';
  if (transactionType === 'supplier_payment' || transaction.purchasePaymentId) return 'supplier_payment';
  if (transactionType === 'customer_payment' || transaction.debtImpact) return 'customer_receipt';
  if (operationType === 'sale_receipt' || (transaction.type === 'thu' && transaction.orderId)) return 'sale_receipt';
  return 'standalone';
}

function getCashbookCounterpartyType(transaction = {}) {
  const route = getCashbookEditRoute(transaction);
  if (route === 'supplier_payment') return 'supplier';
  if (route === 'customer_receipt' || route === 'sale_receipt' || route === 'return_refund') return 'customer';
  return transaction.counterpartyType || (transaction.customerId ? 'customer' : (transaction.supplierId ? 'supplier' : 'other'));
}

function populateCashbookCounterpartyOptions(type, selectedId = '', selectedLabel = '') {
  const select = document.getElementById('cashbook-edit-counterparty');
  const group = document.getElementById('cashbook-edit-counterparty-group');
  const partnerInput = document.getElementById('cashbook-edit-partner');
  if (!select || !group || !partnerInput) return;
  const normalizedType = String(type || 'other');
  const rows = normalizedType === 'customer'
    ? (state.customers || []).filter(item => item.status !== 'inactive')
    : normalizedType === 'supplier'
      ? (state.suppliers || []).filter(item => item.isActive !== false)
      : normalizedType === 'employee'
        ? (state.users || []).filter(item => item.isActive !== false)
        : [];
  group.style.display = normalizedType === 'other' ? 'none' : 'block';
  partnerInput.readOnly = normalizedType !== 'other';
  select.required = normalizedType !== 'other';
  select.innerHTML = rows.map(item => {
    const id = item.id || item.authUserId || item.username || '';
    const label = item.name || item.displayName || item.username || id;
    const code = item.code ? ` — ${item.code}` : '';
    return `<option value="${escapeCashbookHtml(id)}">${escapeCashbookHtml(label + code)}</option>`;
  }).join('');
  const hasSelectedId = selectedId
    && rows.some(item => String(item.id || item.authUserId || item.username) === String(selectedId));
  if (selectedId && !hasSelectedId && normalizedType !== 'other') {
    const fallbackLabel = selectedLabel || `Đối tượng ${selectedId}`;
    select.insertAdjacentHTML(
      'afterbegin',
      `<option value="${escapeCashbookHtml(selectedId)}">${escapeCashbookHtml(fallbackLabel)}</option>`
    );
  }
  if (selectedId && [...select.options].some(option => option.value === String(selectedId))) {
    select.value = String(selectedId);
  }
  const selected = select.options[select.selectedIndex];
  if (normalizedType !== 'other' && selected) {
    partnerInput.value = selected.textContent.split(' — ')[0];
  }
}

function toLocalDateTimeInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function setCashbookDateTimeValue(targetId, value) {
  const target = document.getElementById(targetId);
  const picker = document.querySelector(`[data-cashbook-datetime-target="${targetId}"]`);
  if (!target || !picker) return;

  const normalized = String(value || '').slice(0, 16);
  const [date = '', time = ''] = normalized.split('T');
  const [hour = '00', minute = '00'] = time.split(':');
  target.value = normalized;
  picker.querySelector('[data-cashbook-date]').value = date;
  picker.querySelector('[data-cashbook-hour]').value = hour;
  picker.querySelector('[data-cashbook-minute]').value = minute;
}

function setupCashbook24HourPicker(targetId) {
  const target = document.getElementById(targetId);
  const picker = document.querySelector(`[data-cashbook-datetime-target="${targetId}"]`);
  if (!target || !picker || picker.dataset.ready === 'true') return;

  const dateInput = picker.querySelector('[data-cashbook-date]');
  const hourSelect = picker.querySelector('[data-cashbook-hour]');
  const minuteSelect = picker.querySelector('[data-cashbook-minute]');
  if (!dateInput || !hourSelect || !minuteSelect) return;

  hourSelect.innerHTML = Array.from({ length: 24 }, (_, hour) => {
    const value = String(hour).padStart(2, '0');
    return `<option value="${value}">${value}</option>`;
  }).join('');
  minuteSelect.innerHTML = Array.from({ length: 60 }, (_, minute) => {
    const value = String(minute).padStart(2, '0');
    return `<option value="${value}">${value}</option>`;
  }).join('');

  const syncTarget = () => {
    target.value = dateInput.value
      ? `${dateInput.value}T${hourSelect.value}:${minuteSelect.value}`
      : '';
  };
  dateInput.addEventListener('change', syncTarget);
  hourSelect.addEventListener('change', syncTarget);
  minuteSelect.addEventListener('change', syncTarget);
  picker.dataset.ready = 'true';
  setCashbookDateTimeValue(targetId, target.value);
}

// Helper: load/save transactions from LocalStorage
export function getCashbookTransactions() {
  const stored = localStorage.getItem('billing_system_cashbook_transactions');
  if (stored) {
    let txs = JSON.parse(stored).map(t => {
      const rawNote = t.note || '';
      const supplierMeta = rawNote.match(/__supplierId=([^\s]+)/);
      return {
        ...t,
        supplierId: t.supplierId || (supplierMeta ? supplierMeta[1] : null),
        note: rawNote.replace(/\s*__supplierId=[^\s]+/g, '').trim()
      };
    });
    // Filter out old seed transaction IDs and auto-generated order receipts from storage
    const seedIds = ["TTM001686", "TTM001685", "TTM001684", "TTM001683", "TTM001682", "TTM001681", "TTM001680", "TTM001678", "TTM001679", "TTM001600"];
    const filtered = txs.filter(t => {
      if (seedIds.includes(t.id)) return false;
      const isAutoOrderReceipt = t.note && t.note.startsWith('Thu tiền hàng cho hóa đơn');
      return !isAutoOrderReceipt;
    });
    if (filtered.length !== txs.length) {
      localStorage.setItem('billing_system_cashbook_transactions', JSON.stringify(filtered));
      return filtered;
    }
    return txs;
  }
  localStorage.setItem('billing_system_cashbook_transactions', JSON.stringify([]));
  return [];
}

export function saveCashbookTransactions(txs) {
  localStorage.setItem('billing_system_cashbook_transactions', JSON.stringify(txs));
}

function normalizeText(value) {
  return String(value || '').trim().toLowerCase();
}

function isPaidStatus(status) {
  const clean = normalizeText(status || 'Đã thanh toán');
  return clean === 'completed' || clean === 'paid' || clean.includes('thanh');
}

function isCancelledStatus(status) {
  const clean = normalizeText(status);
  return clean === 'cancelled' || clean === 'canceled' || clean.includes('hủy') || clean.includes('huy') || clean.includes('cancel');
}

function findCustomerByInput(input) {
  const clean = normalizeText(input);
  if (!clean) return null;
  return (state.customers || []).find(customer => {
    const name = normalizeText(customer.name);
    const code = normalizeText(customer.code);
    return clean === name
      || (code && clean === code)
      || (name && code && (clean === `${name} — ${code}` || clean === `${name} - ${code}`));
  }) || null;
}

function getLegacyReceiptCustomer(transaction = {}) {
  const transactionType = normalizeText(transaction.transactionType);
  const supportedLegacyTypes = ['', 'manual_thu', 'thu nợ khách hàng', 'thu tiền khách hàng'];
  if (!['admin', 'accounting'].includes(state.currentUser?.role)
      || transaction.type !== 'thu'
      || isCancelledStatus(transaction.status)
      || transaction.debtImpact
      || !supportedLegacyTypes.includes(transactionType)) {
    return null;
  }
  const category = normalizeText(`${transaction.category || ''} ${transaction.note || ''}`);
  if (!category.includes('nợ')
      && !category.includes('tiền hàng')
      && !category.includes('tiền khách hàng')
      && !category.includes('trả trước')) {
    return null;
  }
  if (transaction.customerId) {
    return (state.customers || []).find(customer => String(customer.id) === String(transaction.customerId)) || null;
  }
  const clean = normalizeText(transaction.partner);
  const matches = (state.customers || []).filter(customer => {
    const name = normalizeText(customer.name);
    const code = normalizeText(customer.code);
    return clean === name
      || (code && clean === code)
      || (name && code && (clean === `${name} — ${code}` || clean === `${name} - ${code}`));
  });
  return matches.length === 1 ? matches[0] : null;
}

function findSupplierByInput(input) {
  const raw = String(input || '').trim();
  const clean = normalizeText(raw);
  if (!clean) return null;
  return (state.suppliers || []).find(s => {
    const name = normalizeText(s.name);
    const code = normalizeText(s.code);
    return clean === name ||
      clean === code ||
      clean === `${name} — ${code}` ||
      clean === `${name} - ${code}` ||
      clean.includes(code) ||
      clean.includes(name);
  }) || null;
}

function populatePaymentRecipientDatalist() {
  const datalist = document.getElementById('payment-recipient-list');
  if (!datalist) return;
  datalist.innerHTML = (state.suppliers || []).map(s => {
    return `<option value="${s.name} — ${s.code}" data-supplier-id="${s.id}">${s.phone || 'N/A'}</option>`;
  }).join('');
}

// Helper: load/save starting balances
export function getStartingBalances() {
  const defaults = {
    cash: 0,
    bank: 0,
    wallet: 0
  };
  const stored = localStorage.getItem('billing_system_cashbook_start_balances');
  if (stored) {
    const parsed = JSON.parse(stored);
    // If the storage contains the large KiotViet sample initial balance, reset it to 0
    if (parsed.cash === 7620470195) {
      localStorage.setItem('billing_system_cashbook_start_balances', JSON.stringify(defaults));
      return defaults;
    }
    return parsed;
  }
  localStorage.setItem('billing_system_cashbook_start_balances', JSON.stringify(defaults));
  return defaults;
}

export async function saveStartingBalances(balances) {
  const saved = await dbSaveStartingBalances(balances);
  if (!saved) return false;
  localStorage.setItem('billing_system_cashbook_start_balances', JSON.stringify(balances));
  return true;
}

// Global active filters in this view
let activeFilters = {
  accountType: 'cash', // 'cash', 'bank', 'wallet', 'all'
  timeMode: 'week',    // 'week', 'month', 'custom'
  startDate: '',       // YYYY-MM-DD
  endDate: '',         // YYYY-MM-DD
  showThu: true,
  showChi: true,
  category: 'all',
  statusPaid: true,
  accounting: 'all',   // 'all', 'yes', 'no'
  creator: 'all',
  searchQuery: '',
  employee: 'all',
  partnerType: 'all',
  partnerSearch: '',
  partnerPhone: '',
  debtImpactYes: true,
  debtImpactNo: true,
  debtImpactNone: true
};

function getCashbookDateWindow() {
  const now = new Date();
  let start;
  let endExclusive;

  if (activeFilters.timeMode === 'week') {
    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const dayFromMonday = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - dayFromMonday);
    endExclusive = new Date(start);
    endExclusive.setDate(endExclusive.getDate() + 7);
  } else if (activeFilters.timeMode === 'month') {
    start = new Date(now.getFullYear(), now.getMonth(), 1);
    endExclusive = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  } else {
    start = activeFilters.startDate ? new Date(`${activeFilters.startDate}T00:00:00`) : null;
    endExclusive = activeFilters.endDate ? new Date(`${activeFilters.endDate}T00:00:00`) : null;
    if (endExclusive) endExclusive.setDate(endExclusive.getDate() + 1);
  }

  const isValidDate = value => value instanceof Date && Number.isFinite(value.getTime());
  if (!isValidDate(start) || !isValidDate(endExclusive) || start >= endExclusive) return null;
  return {
    start,
    endExclusive,
    startIso: start.toISOString(),
    endExclusiveIso: endExclusive.toISOString()
  };
}

async function reloadCashbookDateWindow() {
  const range = getCashbookDateWindow();
  if (!range) {
    renderSoQuyTable();
    return;
  }

  const requestId = ++cashbookRangeRequestId;
  const tableBody = document.getElementById('so-quy-table-body');
  if (tableBody) {
    tableBody.innerHTML = '<tr><td colspan="8" class="text-center py-4">Đang tải dữ liệu sổ quỹ...</td></tr>';
  }
  await dbLoadCashbookForRange(range.startIso, range.endExclusiveIso);
  if (requestId !== cashbookRangeRequestId) return;
  cashbookCurrentPage = 1;
  expandedCashbookTransactionId = '';
  renderSoQuyTable();
}

function scheduleCashbookDateReload() {
  clearTimeout(cashbookRangeReloadTimer);
  cashbookRangeReloadTimer = setTimeout(() => void reloadCashbookDateWindow(), 180);
}

// setup listeners
export function setupSoQuyPanel() {
  ['receipt-time', 'payment-time', 'cashbook-edit-time'].forEach(setupCashbook24HourPicker);
  // 1. Account type selection (Quỹ tiền)
  document.querySelectorAll('input[name="so-quy-acc-type"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      activeFilters.accountType = e.target.value;
      const titleDisplay = document.getElementById('so-quy-title-display');
      if (titleDisplay) {
        if (activeFilters.accountType === 'cash') titleDisplay.innerText = 'Sổ quỹ tiền mặt';
        else if (activeFilters.accountType === 'bank') titleDisplay.innerText = 'Sổ quỹ ngân hàng';
        else if (activeFilters.accountType === 'wallet') titleDisplay.innerText = 'Sổ quỹ ví điện tử';
        else titleDisplay.innerText = 'Tổng sổ quỹ';
      }
      renderSoQuyTable();
    });
  });

  // 2. Time filter selection
  document.querySelectorAll('input[name="so-quy-time"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      activeFilters.timeMode = e.target.value;
      const rangeInputs = document.getElementById('so-quy-sidebar-range-inputs');
      if (rangeInputs) {
        rangeInputs.style.display = activeFilters.timeMode === 'custom' ? 'flex' : 'none';
      }
      void reloadCashbookDateWindow();
    });
  });

  // Start & End dates for custom range
  const dateFromInput = document.getElementById('so-quy-sidebar-from');
  const dateToInput = document.getElementById('so-quy-sidebar-to');
  
  // Set defaults for custom range (current month)
  const today = new Date();
  const yyyy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  if (dateFromInput) {
    dateFromInput.value = `${yyyy}-${mm}-01`;
    activeFilters.startDate = dateFromInput.value;
    dateFromInput.addEventListener('input', (e) => {
      activeFilters.startDate = e.target.value;
      scheduleCashbookDateReload();
    });
  }
  if (dateToInput) {
    const lastDay = new Date(yyyy, today.getMonth() + 1, 0).getDate();
    dateToInput.value = `${yyyy}-${mm}-${String(lastDay).padStart(2, '0')}`;
    activeFilters.endDate = dateToInput.value;
    dateToInput.addEventListener('input', (e) => {
      activeFilters.endDate = e.target.value;
      scheduleCashbookDateReload();
    });
  }

  // 3. Document types
  const typeThuCb = document.getElementById('so-quy-type-thu');
  const typeChiCb = document.getElementById('so-quy-type-chi');
  if (typeThuCb) {
    typeThuCb.addEventListener('change', (e) => {
      activeFilters.showThu = e.target.checked;
      renderSoQuyTable();
    });
  }
  if (typeChiCb) {
    typeChiCb.addEventListener('change', (e) => {
      activeFilters.showChi = e.target.checked;
      renderSoQuyTable();
    });
  }

  // 4. Categories select (filled dynamically)
  const catSelect = document.getElementById('so-quy-category-select');
  if (catSelect) {
    catSelect.addEventListener('change', (e) => {
      activeFilters.category = e.target.value;
      renderSoQuyTable();
    });
  }

  // 5. Status
  const statusPaidCb = document.getElementById('so-quy-status-paid');
  if (statusPaidCb) {
    statusPaidCb.addEventListener('change', (e) => {
      activeFilters.statusPaid = e.target.checked;
      renderSoQuyTable();
    });
  }

  // 6. Business Results Accounting (Hạch toán kết quả kinh doanh) - Pill Group
  document.querySelectorAll('.kiot-pill-group .kiot-pill-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const parent = btn.closest('.kiot-pill-group');
      parent.querySelectorAll('.kiot-pill-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilters.accounting = btn.getAttribute('data-value');
      renderSoQuyTable();
    });
  });

  // 7. Creator select (filled dynamically)
  const creatorSelect = document.getElementById('so-quy-creator-select');
  if (creatorSelect) {
    creatorSelect.addEventListener('change', (e) => {
      activeFilters.creator = e.target.value;
      renderSoQuyTable();
    });
  }

  // 8. Employee select (filled dynamically)
  const employeeSelect = document.getElementById('so-quy-employee-select');
  if (employeeSelect) {
    employeeSelect.addEventListener('change', (e) => {
      activeFilters.employee = e.target.value;
      renderSoQuyTable();
    });
  }

  // 9. Partner type select
  const partnerTypeSelect = document.getElementById('so-quy-partner-type');
  if (partnerTypeSelect) {
    partnerTypeSelect.addEventListener('change', (e) => {
      activeFilters.partnerType = e.target.value;
      renderSoQuyTable();
    });
  }

  // 10. Partner name / code search
  const partnerSearchInput = document.getElementById('so-quy-partner-search');
  if (partnerSearchInput) {
    partnerSearchInput.addEventListener('input', (e) => {
      activeFilters.partnerSearch = e.target.value.toLowerCase().trim();
      renderSoQuyTable();
    });
  }

  // 11. Partner phone search
  const partnerPhoneInput = document.getElementById('so-quy-partner-phone');
  if (partnerPhoneInput) {
    partnerPhoneInput.addEventListener('input', (e) => {
      activeFilters.partnerPhone = e.target.value.trim();
      renderSoQuyTable();
    });
  }

  // 12. Partner debt impact checkboxes
  const debtImpactYesCb = document.getElementById('so-quy-debt-impact-yes');
  const debtImpactNoCb = document.getElementById('so-quy-debt-impact-no');
  const debtImpactNoneCb = document.getElementById('so-quy-debt-impact-none');

  if (debtImpactYesCb) {
    debtImpactYesCb.addEventListener('change', (e) => {
      activeFilters.debtImpactYes = e.target.checked;
      renderSoQuyTable();
    });
  }
  if (debtImpactNoCb) {
    debtImpactNoCb.addEventListener('change', (e) => {
      activeFilters.debtImpactNo = e.target.checked;
      renderSoQuyTable();
    });
  }
  if (debtImpactNoneCb) {
    debtImpactNoneCb.addEventListener('change', (e) => {
      activeFilters.debtImpactNone = e.target.checked;
      renderSoQuyTable();
    });
  }

  // 13. Search query input (Mã phiếu, v.v.)
  const searchInput = document.getElementById('so-quy-search');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      activeFilters.searchQuery = e.target.value.toLowerCase().trim();
      renderSoQuyTable();
    });
  }

  // 14. Table select-all checkbox
  const selectAllCb = document.getElementById('so-quy-select-all');
  if (selectAllCb) {
    selectAllCb.addEventListener('change', (e) => {
      const checkVal = e.target.checked;
      document.querySelectorAll('.so-quy-row-checkbox').forEach(cb => {
        cb.checked = checkVal;
      });
    });
  }

  const pageSizeSelect = document.getElementById('so-quy-page-size');
  if (pageSizeSelect) {
    pageSizeSelect.value = String(cashbookPageSize);
    pageSizeSelect.addEventListener('change', (event) => {
      const nextPageSize = Number(event.target.value);
      cashbookPageSize = [20, 50, 100].includes(nextPageSize) ? nextPageSize : 20;
      cashbookCurrentPage = 1;
      expandedCashbookTransactionId = '';
      renderSoQuyTable();
    });
  }

  const changeCashbookPage = (nextPage) => {
    const safePage = Math.min(Math.max(1, nextPage), cashbookTotalPages);
    if (safePage === cashbookCurrentPage) return;
    cashbookCurrentPage = safePage;
    expandedCashbookTransactionId = '';
    renderSoQuyTable();
  };

  document.getElementById('so-quy-first-page')?.addEventListener('click', () => changeCashbookPage(1));
  document.getElementById('so-quy-prev-page')?.addEventListener('click', () => changeCashbookPage(cashbookCurrentPage - 1));
  document.getElementById('so-quy-next-page')?.addEventListener('click', () => changeCashbookPage(cashbookCurrentPage + 1));
  document.getElementById('so-quy-last-page')?.addEventListener('click', () => changeCashbookPage(cashbookTotalPages));

  // 15. Manual edit starting balance (Double click balance value)
  const startBalEl = document.getElementById('so-quy-stat-start');
  if (startBalEl) {
    startBalEl.style.cursor = 'pointer';
    startBalEl.title = 'Kích đúp để thay đổi Quỹ đầu kỳ';
    startBalEl.addEventListener('dblclick', async () => {
      const type = activeFilters.accountType;
      if (type === 'all') {
        showToast('Vui lòng chọn cụ thể một loại Quỹ (Tiền mặt, Ngân hàng, Ví điện tử) để thay đổi quỹ đầu kỳ.', 'warning');
        return;
      }
      const balances = getStartingBalances();
      const currentVal = balances[type] || 0;
      const newValStr = prompt(`Nhập số tiền quỹ đầu kỳ mới cho quỹ [${type === 'cash' ? 'Tiền mặt' : type === 'bank' ? 'Ngân hàng' : 'Ví điện tử'}]:`, currentVal);
      if (newValStr !== null) {
        const newVal = parseFloat(newValStr.replace(/,/g, ''));
        if (!isNaN(newVal)) {
          const nextBalances = { ...balances, [type]: newVal };
          if (await saveStartingBalances(nextBalances)) {
            showToast('Đã cập nhật Quỹ đầu kỳ thành công!', 'success');
            renderSoQuyTable();
          }
        } else {
          showToast('Giá trị nhập vào không hợp lệ!', 'danger');
        }
      }
    });
  }

  const parseCashbookCurrencyInput = (input) => {
    const digits = String(input?.value || '').replace(/\D/g, '');
    return digits ? Number(digits) : 0;
  };

  const setupCashbookCurrencyInput = (input) => {
    if (!input || input.dataset.currencyFormattingReady === 'true') return;
    input.dataset.currencyFormattingReady = 'true';
    input.addEventListener('input', () => {
      const digits = input.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
      input.value = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    });
  };

  // 16. Modal actions: + Phiếu thu
  const addThuBtn = document.getElementById('so-quy-btn-add-thu');
  const receiptModal = document.getElementById('so-quy-receipt-modal');
  const receiptForm = document.getElementById('so-quy-receipt-form');
  const receiptTimeInput = document.getElementById('receipt-time');
  const receiptValueInput = document.getElementById('receipt-value');
  setupCashbookCurrencyInput(receiptValueInput);
  
  if (addThuBtn && receiptModal) {
    addThuBtn.addEventListener('click', () => {
      // One stable key per modal attempt: retrying the same form is safe, while
      // a newly opened receipt can never reuse an older display-code key.
      pendingReceiptIdempotencyKey = globalThis.crypto.randomUUID();
      // Set time default to now in local format
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      if (receiptTimeInput) {
        setCashbookDateTimeValue('receipt-time', now.toISOString().slice(0, 16));
      }
      // Set method select to match current view filter
      const rMethod = document.getElementById('receipt-method');
      if (rMethod && ['cash','bank','wallet'].includes(activeFilters.accountType)) {
        rMethod.value = activeFilters.accountType;
      }
      receiptModal.classList.add('active');
    });
  }
  
  const closeReceiptBtn = document.getElementById('btn-close-receipt-modal');
  const cancelReceiptBtn = document.getElementById('btn-cancel-receipt-modal');
  
  const hideReceiptModal = () => {
    if (receiptModal) receiptModal.classList.remove('active');
    if (receiptForm) receiptForm.reset();
    pendingReceiptIdempotencyKey = '';
  };
  
  if (closeReceiptBtn) closeReceiptBtn.addEventListener('click', hideReceiptModal);
  if (cancelReceiptBtn) cancelReceiptBtn.addEventListener('click', hideReceiptModal);

  if (receiptForm) {
    receiptForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const code = document.getElementById('receipt-code').value.trim();
      const time = document.getElementById('receipt-time').value;
      const category = document.getElementById('receipt-category').value;
      const payer = document.getElementById('receipt-payer').value.trim();
      const value = parseCashbookCurrencyInput(receiptValueInput);
      const method = document.getElementById('receipt-method').value;
      const accounting = document.getElementById('receipt-accounting').checked;
      const note = document.getElementById('receipt-note').value.trim();
      if (!pendingReceiptIdempotencyKey) {
        pendingReceiptIdempotencyKey = globalThis.crypto.randomUUID();
      }
      
      // Auto-generate code if empty
      let finalCode = code;
      const txs = getCashbookTransactions();
      if (!finalCode) {
        let maxSeq = 0;
        txs.forEach(t => {
          if (t.id.startsWith('TTM')) {
            const num = parseInt(t.id.slice(3));
            if (!isNaN(num) && num > maxSeq) maxSeq = num;
          }
        });
        finalCode = `TTM${String(maxSeq + 1).padStart(6, '0')}`;
      } else {
        // Verify unique code
        if (txs.some(t => t.id.toLowerCase() === finalCode.toLowerCase())) {
          showToast(`Mã phiếu ${finalCode} đã tồn tại! Vui lòng nhập mã khác.`, 'danger');
          return;
        }
      }
      
      const newTx = {
        id: finalCode,
        date: new Date(time).toISOString(),
        type: 'thu',
        category,
        partner: payer,
        value,
        method,
        accounting,
        status: 'Đã thanh toán',
        creator: state.currentUser ? state.currentUser.displayName : 'Administrator',
        note,
        starred: false,
        idempotencyKey: pendingReceiptIdempotencyKey
      };
      
      const selectedOption = Array.from(
        document.getElementById('receipt-payer-list')?.options || []
      ).find(option => option.value === payer);
      const selectedCustomerId = selectedOption?.dataset.customerId || '';
      const customerMatches = state.customers.filter(c =>
        String(c.name || '').trim().toLowerCase() === payer.toLowerCase()
      );
      let matchedCustomer = selectedCustomerId
        ? state.customers.find(c => String(c.id) === selectedCustomerId)
        : (customerMatches.length === 1 ? customerMatches[0] : null);

      const normalizedCategory = category.toLowerCase();
      const isSalaryDeductionReceipt = normalizedCategory === 'thu tiền hàng trừ vào lương';
      // Every receipt whose payer resolves to a customer is a customer receipt,
      // regardless of its category (shipping support, penalties, other income,
      // etc.). Free-text payers remain standalone cashbook receipts. Salary
      // deductions are standalone unless the payer explicitly resolves to a customer.
      const affectsCustomerDebt = Boolean(matchedCustomer)
        || normalizedCategory.includes('nợ')
        || (!isSalaryDeductionReceipt && normalizedCategory.includes('tiền hàng'))
        || normalizedCategory.includes('tiền khách hàng')
        || normalizedCategory.includes('trả trước');
      let paymentResult = null;

      if (affectsCustomerDebt) {
        if (!matchedCustomer) {
          showToast('Phiếu thu công nợ phải chọn đúng một khách hàng trong danh sách!', 'danger');
          return;
        }

        newTx.partner = matchedCustomer.name;
        if (value <= 0) {
          showToast('Số tiền thu phải lớn hơn 0!', 'danger');
          return;
        }

        paymentResult = await dbRecordCustomerPayment(
          matchedCustomer.id,
          value,
          note || `${category} - ${finalCode}`,
          method,
          pendingReceiptIdempotencyKey
        );
        if (!paymentResult) return;

        const newDebt = Number(paymentResult.new_debt);
        if (!Number.isFinite(newDebt)) {
          showToast('Database không trả về số công nợ mới. Phiếu thu chưa được ghi nhận trên giao diện.', 'danger');
          return;
        }

        // Re-read the authoritative balance after the transaction. Realtime can
        // replace the customer object while the RPC is in flight, so mutating
        // matchedCustomer here may otherwise update a detached, stale object.
        const refreshedCustomer = await dbRefreshCustomerFinancialState(matchedCustomer.id, { includeHistory: false });
        const currentCustomer = refreshedCustomer
          || state.customers.find(customer => String(customer.id) === String(matchedCustomer.id))
          || matchedCustomer;

        if (!refreshedCustomer) {
          currentCustomer.debt = newDebt;
          currentCustomer.lastPaymentAt = new Date().toISOString();
        }
        if (!refreshedCustomer && !paymentResult.already_recorded) {
          if (!currentCustomer.debtHistory) currentCustomer.debtHistory = [];
          currentCustomer.debtHistory.push({
            id: paymentResult.ledger_id || `pay-${finalCode}`,
            date: new Date().toISOString(),
            type: 'payment',
            amount: value,
            notes: note || `${category} - ${finalCode}`,
            debtAfter: newDebt
          });
        }
        localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));

        newTx.customerId = currentCustomer.id;
        newTx.cloudId = paymentResult.cashbook_id || null;
        newTx.debtImpact = true;
      } else {
        const savedToCloud = await dbSaveCashbookTransaction(newTx);
        if (!savedToCloud) {
          showToast('Không thể lưu phiếu thu lên Cloud. Dữ liệu trên form được giữ nguyên.', 'danger');
          return;
        }
        newTx.debtImpact = false;
      }

      txs.unshift(newTx);
      saveCashbookTransactions(txs);
      
      // Update customer debt (subtract debt balance)
      
      showToast(`Đã tạo phiếu thu ${finalCode} thành công!`, 'success');
      hideReceiptModal();
      renderAll();
    });
  }

  // 17. Modal actions: + Phiếu chi
  const addChiBtn = document.getElementById('so-quy-btn-add-chi');
  const paymentModal = document.getElementById('so-quy-payment-modal');
  const paymentForm = document.getElementById('so-quy-payment-form');
  const paymentTimeInput = document.getElementById('payment-time');
  const paymentValueInput = document.getElementById('payment-value');
  setupCashbookCurrencyInput(paymentValueInput);
  
  if (addChiBtn && paymentModal) {
    addChiBtn.addEventListener('click', () => {
      populatePaymentRecipientDatalist();
      // Set time default to now
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      if (paymentTimeInput) {
        setCashbookDateTimeValue('payment-time', now.toISOString().slice(0, 16));
      }
      // Set method select to match current view filter
      const pMethod = document.getElementById('payment-method');
      if (pMethod && ['cash','bank','wallet'].includes(activeFilters.accountType)) {
        pMethod.value = activeFilters.accountType;
      }
      paymentModal.classList.add('active');
    });
  }
  
  const closePaymentBtn = document.getElementById('btn-close-payment-modal');
  const cancelPaymentBtn = document.getElementById('btn-cancel-payment-modal');
  
  const hidePaymentModal = () => {
    if (paymentModal) paymentModal.classList.remove('active');
    if (paymentForm) paymentForm.reset();
  };
  
  if (closePaymentBtn) closePaymentBtn.addEventListener('click', hidePaymentModal);
  if (cancelPaymentBtn) cancelPaymentBtn.addEventListener('click', hidePaymentModal);

  if (paymentForm) {
    paymentForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const code = document.getElementById('payment-code').value.trim();
      const time = document.getElementById('payment-time').value;
      const category = document.getElementById('payment-category').value;
      const recipient = document.getElementById('payment-recipient').value.trim();
      const value = parseCashbookCurrencyInput(paymentValueInput);
      const method = document.getElementById('payment-method').value;
      const accounting = document.getElementById('payment-accounting').checked;
      const note = document.getElementById('payment-note').value.trim();
      const matchedSupplier = findSupplierByInput(recipient);
      
      // Auto-generate code if empty
      let finalCode = code;
      const txs = getCashbookTransactions();
      if (!finalCode) {
        let maxSeq = 0;
        txs.forEach(t => {
          if (t.id.startsWith('TCM')) {
            const num = parseInt(t.id.slice(3));
            if (!isNaN(num) && num > maxSeq) maxSeq = num;
          }
        });
        finalCode = `TCM${String(maxSeq + 1).padStart(6, '0')}`;
      } else {
        // Verify unique code
        if (txs.some(t => t.id.toLowerCase() === finalCode.toLowerCase())) {
          showToast(`Mã phiếu ${finalCode} đã tồn tại! Vui lòng nhập mã khác.`, 'danger');
          return;
        }
      }
      
      const newTx = {
        id: finalCode,
        date: new Date(time).toISOString(),
        type: 'chi',
        category,
        partner: matchedSupplier ? matchedSupplier.name : recipient,
        supplierId: matchedSupplier ? matchedSupplier.id : null,
        value,
        method,
        accounting,
        status: 'Đã thanh toán',
        creator: state.currentUser ? state.currentUser.displayName : 'Administrator',
        note,
        starred: false
      };
      
      const savedToCloud = await dbSaveCashbookTransaction(newTx);
      if (!savedToCloud) {
        showToast('Không thể lưu phiếu chi vào Sổ quỹ Cloud. Dữ liệu trên form được giữ nguyên.', 'danger');
        return;
      }

      txs.unshift(newTx);
      saveCashbookTransactions(txs);
      
      showToast(`Đã tạo phiếu chi ${finalCode} thành công!`, 'success');
      hidePaymentModal();
      renderAll();
    });
  }

  // 18. Export file report
  const exportBtn = document.getElementById('so-quy-btn-export');
  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      const data = getFilteredTransactionsForExport();
      if (data.length === 0) {
        showToast('Không có dữ liệu trong khoảng thời gian được lọc để xuất báo cáo!', 'warning');
        return;
      }
      exportSoQuyToExcel(data);
    });
  }

  const editModal = document.getElementById('so-quy-edit-modal');
  const editForm = document.getElementById('so-quy-edit-form');
  const hideEditModal = () => {
    editModal?.classList.remove('active');
    editForm?.reset();
    const editId = document.getElementById('cashbook-edit-id');
    if (editId) editId.value = '';
  };
  document.getElementById('btn-close-cashbook-edit')?.addEventListener('click', hideEditModal);
  document.getElementById('btn-cancel-cashbook-edit')?.addEventListener('click', hideEditModal);
  document.getElementById('cashbook-edit-counterparty-type')?.addEventListener('change', event => {
    populateCashbookCounterpartyOptions(event.target.value);
  });
  document.getElementById('cashbook-edit-counterparty')?.addEventListener('change', event => {
    const selected = event.target.options[event.target.selectedIndex];
    const partnerInput = document.getElementById('cashbook-edit-partner');
    if (partnerInput && selected) partnerInput.value = selected.textContent.split(' — ')[0];
  });

  editForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const txId = document.getElementById('cashbook-edit-id')?.value || '';
    const transaction = getCashbookTransactions().find(item => String(item.id) === String(txId));
    if (!transaction || !canEditCashbookTransaction(transaction)) {
      showToast('Phiếu đã hủy hoặc phiếu đảo không được phép sửa.', 'warning');
      return;
    }

    const value = Number(document.getElementById('cashbook-edit-value')?.value || 0);
    const localDate = document.getElementById('cashbook-edit-time')?.value || '';
    const parsedDate = new Date(localDate);
    if (!Number.isFinite(value) || value <= 0 || Number.isNaN(parsedDate.getTime())) {
      showToast('Vui lòng nhập thời gian và giá trị phiếu hợp lệ.', 'danger');
      return;
    }

    const saveButton = document.getElementById('btn-save-cashbook-edit');
    if (saveButton) saveButton.disabled = true;
    try {
      const counterpartyType = document.getElementById('cashbook-edit-counterparty-type')?.value || 'other';
      const counterpartySelect = document.getElementById('cashbook-edit-counterparty');
      const collectorSelect = document.getElementById('cashbook-edit-collector');
      const updated = await dbAmendCashbookTransaction(getCanonicalCashbookId(transaction), {
        transactionDate: parsedDate.toISOString(),
        category: document.getElementById('cashbook-edit-category')?.value.trim() || '',
        partner: document.getElementById('cashbook-edit-partner')?.value.trim() || '',
        counterpartyType,
        counterpartyId: counterpartyType === 'other' ? '' : (counterpartySelect?.value || ''),
        collectorId: collectorSelect?.value || '',
        collectorName: collectorSelect?.options[collectorSelect.selectedIndex]?.textContent || '',
        value,
        method: document.getElementById('cashbook-edit-method')?.value || 'cash',
        accounting: document.getElementById('cashbook-edit-accounting')?.checked === true,
        note: document.getElementById('cashbook-edit-note')?.value.trim() || '',
        reason: `Sửa ${transaction.type === 'thu' ? 'phiếu thu' : 'phiếu chi'} ${transaction.id}`
      });
      if (!updated) return;

      const refreshed = updated.transaction
        ? upsertCashbookTransactionSnapshot({
            ...updated.transaction,
            collectorId: updated.collector_id,
            collectorName: updated.collector_name,
            counterpartyType: updated.counterparty_type,
            counterpartyId: updated.counterparty_id
          })
        : await dbFetchCashbookTransactionById(getCanonicalCashbookId(transaction));
      if (!refreshed) {
        showToast('Phiếu đã sửa trên Cloud nhưng giao diện chưa tải lại được. Vui lòng tải lại trang.', 'warning');
      } else {
        showToast(`Đã cập nhật phiếu ${transaction.id}.`, 'success');
      }
      hideEditModal();
      expandedCashbookTransactionId = '';
      await reloadCashbookDateWindow();
      renderAll();
    } finally {
      if (saveButton) saveButton.disabled = false;
    }
  });
}

// External helper to add automated transactions from Sales / Payments
export function addCashbookTransaction({
  id = '',
  type,
  category,
  partner,
  value,
  method,
  accounting = true,
  note = '',
  creator = '',
  customerId = null,
  supplierId = null,
  cloudId = null,
  debtImpact = false,
  syncToCloud = false
}) {
  const txs = getCashbookTransactions();
  
  const prefix = type === 'thu' ? 'TTM' : 'TCM';
  let maxSeq = 0;
  txs.forEach(t => {
    if (t.id.startsWith(prefix)) {
      const num = parseInt(t.id.slice(3));
      if (!isNaN(num) && num > maxSeq) maxSeq = num;
    }
  });
  
  const finalCode = id || `${prefix}${String(maxSeq + 1).padStart(6, '0')}`;
  const existing = txs.find(t => String(t.id).toLowerCase() === String(finalCode).toLowerCase());
  if (existing) return existing;
  
  const newTx = {
    id: finalCode,
    date: new Date().toISOString(),
    type,
    category,
    partner,
    value: parseFloat(value) || 0,
    method: method || 'cash', // 'cash', 'bank', 'wallet'
    accounting,
    status: 'Đã thanh toán',
    creator: creator || (state.currentUser ? state.currentUser.displayName : 'Administrator'),
    note,
    starred: false,
    customerId,
    supplierId,
    cloudId,
    debtImpact
  };
  
  txs.unshift(newTx);
  saveCashbookTransactions(txs);
  
  // Sync to Supabase in background
  if (syncToCloud) dbSaveCashbookTransaction(newTx);
  
  // Re-render when added dynamically
  setTimeout(() => renderAll(), 100);
  return newTx;
}

// Retrieve currently filtered transactions for display/calculations
function getProcessedData() {
  const txs = getCashbookTransactions();
  const effectiveTxs = txs.filter(isEffectiveCashbookTransaction);
  const balances = getStartingBalances();
  
  // Define time range boundaries
  const activeRange = getCashbookDateWindow();
  const rangeStart = activeRange?.start || null;
  const rangeEndExclusive = activeRange?.endExclusive || null;

  // 1. Calculate Quỹ đầu kỳ dynamically (transactions before rangeStart)
  // Quỹ đầu kỳ base for the selected account type
  let baseStartVal = 0;
  if (activeFilters.accountType === 'all') {
    baseStartVal = (balances.cash || 0) + (balances.bank || 0) + (balances.wallet || 0);
  } else {
    baseStartVal = balances[activeFilters.accountType] || 0;
  }
  
  let preRangeNet = 0;
  const openingSnapshotMatches = rangeStart
    && state.cashbookOpeningNetByMethod
    && state.cashbookOpeningStartIso === rangeStart.toISOString();

  if (openingSnapshotMatches) {
    if (activeFilters.accountType === 'all') {
      preRangeNet = ['cash', 'bank', 'wallet']
        .reduce((sum, method) => sum + Number(state.cashbookOpeningNetByMethod[method] || 0), 0);
    } else {
      preRangeNet = Number(state.cashbookOpeningNetByMethod[activeFilters.accountType] || 0);
    }
  } else if (rangeStart) {
    effectiveTxs.forEach(t => {
      // Must be settled, match account type, and occur BEFORE the rangeStart
      if (!isPaidStatus(t.status)) return;
      
      if (activeFilters.accountType !== 'all' && t.method !== activeFilters.accountType) return;
      
      const tDate = new Date(t.date);
      if (tDate < rangeStart) {
        if (t.type === 'thu') preRangeNet += Number(t.value || 0);
        else if (t.type === 'chi') preRangeNet -= Number(t.value || 0);
      }
    });
  }
  
  const calculatedStartBalance = baseStartVal + preRangeNet;

  // 2. Filter transactions that are within the current date range
  let filtered = effectiveTxs.filter(t => {
    // Account type
    if (activeFilters.accountType !== 'all' && t.method !== activeFilters.accountType) return false;
    
    // Time filter
    if (rangeStart || rangeEndExclusive) {
      const tDate = new Date(t.date);
      if (rangeStart && tDate < rangeStart) return false;
      if (rangeEndExclusive && tDate >= rangeEndExclusive) return false;
    }
    
    // Document type (Phiếu thu / Phiếu chi)
    if (t.type === 'thu' && !activeFilters.showThu) return false;
    if (t.type === 'chi' && !activeFilters.showChi) return false;
    
    // Category (Loại thu chi)
    if (activeFilters.category !== 'all' && t.category !== activeFilters.category) return false;
    
    // Status (Trạng thái)
    if (isPaidStatus(t.status) && !activeFilters.statusPaid) return false;
    
    // Business Accounting (Hạch toán KQKD)
    if (activeFilters.accounting === 'yes' && !t.accounting) return false;
    if (activeFilters.accounting === 'no' && t.accounting) return false;
    
    // Creator (Người tạo)
    if (activeFilters.creator !== 'all' && t.creator !== activeFilters.creator) return false;

    // Filter by Employee (Nhân viên)
    if (activeFilters.employee !== 'all') {
      let matchesEmployee = false;
      const selectedUser = state.users.find(u => u.username === activeFilters.employee);
      if (selectedUser) {
        if (t.creator === selectedUser.displayName || t.creator === selectedUser.username) {
          matchesEmployee = true;
        }
      }
      
      const cust = state.customers.find(c => c.name === t.partner);
      if (cust && cust.managedBy === activeFilters.employee) {
        matchesEmployee = true;
      }
      
      if (!matchesEmployee) return false;
    }

    // Filter by Partner Type
    const linkedSupplier = t.supplierId
      ? state.suppliers.find(s => String(s.id) === String(t.supplierId))
      : findSupplierByInput(t.partner);
    const isCustomer = state.customers.some(c => c.name === t.partner) ||
                       t.category.toLowerCase().includes('khÃ¡ch hÃ ng') ||
                       t.category.toLowerCase().includes('tiá»n hÃ ng') ||
                       t.id.startsWith('TTM');
    const isSupplier = !!linkedSupplier ||
                       t.category.toLowerCase().includes('nháº­p hÃ ng') ||
                       t.category.toLowerCase().includes('nhÃ  cung cáº¥p') ||
                       t.id.startsWith('TCM');

    if (activeFilters.partnerType === 'customer') {
      if (!isCustomer) return false;
    } else if (activeFilters.partnerType === 'supplier') {
      if (!isSupplier) return false;
    } else if (activeFilters.partnerType === 'other') {
      if (isCustomer || isSupplier) return false;
    }
    // Filter by Partner Search Query (Tên, mã người nộp/nhận)
    if (activeFilters.partnerSearch) {
      const q = activeFilters.partnerSearch;
      let matchesPartner = t.partner.toLowerCase().includes(q);
      if (!matchesPartner) {
        const cust = state.customers.find(c => c.name === t.partner);
        if (cust && cust.code.toLowerCase().includes(q)) {
          matchesPartner = true;
        }
      }
      if (!matchesPartner && linkedSupplier) {
        matchesPartner = String(linkedSupplier.code || '').toLowerCase().includes(q) ||
          String(linkedSupplier.name || '').toLowerCase().includes(q);
      }
      if (!matchesPartner) return false;
    }

    // Filter by Partner Phone (Số điện thoại)
    if (activeFilters.partnerPhone) {
      const q = activeFilters.partnerPhone;
      const cust = state.customers.find(c => c.name === t.partner);
      const supplierPhoneMatch = linkedSupplier && linkedSupplier.phone && linkedSupplier.phone.includes(q);
      if ((!cust || !cust.phone || !cust.phone.includes(q)) && !supplierPhoneMatch) {
        return false;
      }
    }

    // Filter by Partner Debt Impact (Công nợ đối tác)
    // Classify transaction's debt impact:
    // 'yes' = affects customer debt (Thu nợ, Chi nợ v.v.)
    // 'none' = no partner / general accumulator
    // 'no' = other partner transactions (Thu tiền hàng v.v.)
    let debtImpact = 'no';
    if (t.category.toLowerCase().includes('nợ')) {
      debtImpact = 'yes';
    } else if (!t.partner || t.partner === 'Khách bán lẻ tích lũy đầu tháng' || t.partner === 'Hệ thống') {
      debtImpact = 'none';
    }

    if (debtImpact === 'yes' && !activeFilters.debtImpactYes) return false;
    if (debtImpact === 'no' && !activeFilters.debtImpactNo) return false;
    if (debtImpact === 'none' && !activeFilters.debtImpactNone) return false;
    
    // Search input (Mã phiếu, người nộp/nhận, ghi chú)
    if (activeFilters.searchQuery) {
      const idMatch = t.id.toLowerCase().includes(activeFilters.searchQuery);
      const partnerMatch = t.partner.toLowerCase().includes(activeFilters.searchQuery);
      const noteMatch = (t.note || '').toLowerCase().includes(activeFilters.searchQuery);
      if (!idMatch && !partnerMatch && !noteMatch) return false;
    }
    
    return true;
  });

  // 3. Calculate statistics for the CURRENT range
  let totalIncome = 0;
  let totalExpense = 0;
  
  filtered.forEach(t => {
    // Only count active (paid) transactions for statistics
    if (!isPaidStatus(t.status)) return;
    
    if (t.type === 'thu') totalIncome += t.value;
    else if (t.type === 'chi') totalExpense += t.value;
  });
  
  const finalBalance = calculatedStartBalance + totalIncome - totalExpense;

  return {
    filteredTransactions: filtered,
    stats: {
      startBalance: calculatedStartBalance,
      income: totalIncome,
      expense: totalExpense,
      balance: finalBalance
    }
  };
}

// Get filtered list for exporting without UI constraints
function getFilteredTransactionsForExport() {
  return getProcessedData().filteredTransactions;
}

// Populates dropdown filters dynamically based on current transaction properties
function refreshDynamicFilters(txs) {
  // 1. Categories filter
  const catSelect = document.getElementById('so-quy-category-select');
  if (catSelect) {
    const currentVal = catSelect.value;
    const cats = new Set();
    txs.forEach(t => {
      if (t.category) cats.add(t.category);
    });
    
    catSelect.innerHTML = '<option value="all">-- Chọn loại thu chi --</option>';
    Array.from(cats).sort().forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      catSelect.appendChild(opt);
    });
    // Keep selection if still valid
    if (cats.has(currentVal)) {
      catSelect.value = currentVal;
      activeFilters.category = currentVal;
    } else {
      activeFilters.category = 'all';
    }
  }

  // 2. Creator filter
  const creatorSelect = document.getElementById('so-quy-creator-select');
  if (creatorSelect) {
    const currentVal = creatorSelect.value;
    const creators = new Set();
    txs.forEach(t => {
      if (t.creator) creators.add(t.creator);
    });
    
    creatorSelect.innerHTML = '<option value="all">Chọn người tạo</option>';
    Array.from(creators).sort().forEach(c => {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = c;
      creatorSelect.appendChild(opt);
    });
    
    if (creators.has(currentVal)) {
      creatorSelect.value = currentVal;
      activeFilters.creator = currentVal;
    } else {
      activeFilters.creator = 'all';
    }
  }

  // 3. Employee filter (from system users in state)
  const employeeSelect = document.getElementById('so-quy-employee-select');
  if (employeeSelect) {
    const currentVal = employeeSelect.value;
    employeeSelect.innerHTML = '<option value="all">Chọn nhân viên</option>';
    state.users.forEach(u => {
      const opt = document.createElement('option');
      opt.value = u.username;
      opt.textContent = u.displayName;
      employeeSelect.appendChild(opt);
    });
    
    if (state.users.some(u => u.username === currentVal)) {
      employeeSelect.value = currentVal;
      activeFilters.employee = currentVal;
    } else {
      activeFilters.employee = 'all';
    }
  }

  // 4. Receipt payer suggestions (danh sách khách hàng)
  const payerList = document.getElementById('receipt-payer-list');
  if (payerList) {
    payerList.innerHTML = '';
    state.customers.forEach(c => {
      const opt = document.createElement('option');
      const uniqueRef = c.code || c.phone || c.id;
      opt.value = `${c.name} — ${uniqueRef}`;
      opt.dataset.customerId = String(c.id);
      const subText = (c.code && c.code !== c.name) ? `${c.code} ${c.phone ? `• SĐT: ${c.phone}` : ''}` : (c.phone ? `SĐT: ${c.phone}` : '');
      opt.textContent = subText;
      payerList.appendChild(opt);
    });
  }
}

function getCashbookMethodLabel(method) {
  if (method === 'cash') return 'Tiền mặt';
  if (method === 'bank') return 'Ngân hàng';
  return 'Ví điện tử';
}

function renderCashbookInlineDetail(t) {
  const isReceipt = t.type === 'thu';
  const isCancelled = isCancelledStatus(t.status);
  const legacyCustomer = getLegacyReceiptCustomer(t);
  const counterpartyType = t.customerId
    ? 'Khách hàng'
    : (t.supplierId ? 'Nhà cung cấp' : 'Đối tượng khác');
  const amountClass = isCancelled ? 'is-cancelled' : (isReceipt ? 'is-receipt' : 'is-payment');
  const accountingLabel = t.accounting ? 'Có hạch toán' : 'Không hạch toán';

  return `
    <tr class="so-quy-inline-detail-row" data-id="${escapeCashbookHtml(t.id)}">
      <td colspan="8">
        <section class="so-quy-inline-detail" aria-label="Chi tiết ${isReceipt ? 'phiếu thu' : 'phiếu chi'} ${escapeCashbookHtml(t.id)}">
          <div class="so-quy-inline-tab">Thông tin</div>
          <div class="so-quy-inline-heading">
            <div class="so-quy-inline-title">
              <strong>${isReceipt ? 'Phiếu thu' : 'Phiếu chi'} <span>${escapeCashbookHtml(t.id)}</span></strong>
              <span class="badge-status ${isPaidStatus(t.status) ? 'badge-status-paid' : 'badge-status-cancelled'}">${escapeCashbookHtml(t.status)}</span>
              <span class="so-quy-accounting-badge ${t.accounting ? 'is-accounting' : ''}">${accountingLabel}</span>
            </div>
          </div>
          <div class="so-quy-inline-meta">
            <span>Người tạo: <strong>${escapeCashbookHtml(t.creator || 'Hệ thống')}</strong></span>
            <span>${isReceipt ? 'Người thu' : 'Người chi'}: <strong>${escapeCashbookHtml(t.collectorName || t.creator || 'Hệ thống')}</strong></span>
            <span>Thời gian: <strong>${escapeCashbookHtml(formatDateTime(t.date))}</strong></span>
          </div>
          <div class="so-quy-inline-grid">
            <div class="so-quy-inline-field">
              <span>Số tiền</span>
              <strong class="so-quy-inline-amount ${amountClass}">${isReceipt ? '+' : '-'} ${escapeCashbookHtml(formatCurrency(t.value))}</strong>
            </div>
            <div class="so-quy-inline-field"><span>Loại thu chi</span><strong>${escapeCashbookHtml(t.category || '-')}</strong></div>
            <div class="so-quy-inline-field"><span>Đối tượng ${isReceipt ? 'nộp' : 'nhận'}</span><strong>${counterpartyType}</strong></div>
            <div class="so-quy-inline-field"><span>Phương thức thanh toán</span><strong>${getCashbookMethodLabel(t.method)}</strong></div>
          </div>
          <div class="so-quy-inline-wide-field">
            <span>${isReceipt ? 'Người nộp' : 'Người nhận'}</span>
            <strong>${escapeCashbookHtml(t.partner || '-')}</strong>
            <small>${escapeCashbookHtml(getTransactionPartnerAddress(t) || 'Chưa có địa chỉ')}</small>
          </div>
          <div class="so-quy-inline-note">
            <i data-lucide="file-text"></i>
            <span>${escapeCashbookHtml(t.note || 'Chưa có ghi chú')}</span>
          </div>
          <div class="so-quy-inline-actions">
            <div>
              ${!isCancelled ? `<button type="button" class="btn btn-danger btn-sm js-cashbook-inline-cancel"><i data-lucide="trash-2"></i> Hủy phiếu</button>` : ''}
              ${legacyCustomer ? `<button type="button" class="btn btn-primary btn-sm js-cashbook-inline-reconcile"><i data-lucide="badge-check"></i> Ghi vào công nợ</button>` : ''}
            </div>
            <div>
              ${canEditCashbookTransaction(t) ? `<button type="button" class="btn btn-primary btn-sm js-cashbook-inline-edit"><i data-lucide="pencil"></i> Chỉnh sửa</button>` : ''}
              <button type="button" class="btn btn-secondary btn-sm js-cashbook-inline-close">Thu gọn</button>
            </div>
          </div>
        </section>
      </td>
    </tr>
  `;
}

function renderCashbookPagination(totalItems) {
  cashbookTotalPages = Math.max(1, Math.ceil(totalItems / cashbookPageSize));
  cashbookCurrentPage = Math.min(Math.max(1, cashbookCurrentPage), cashbookTotalPages);

  const firstItem = totalItems === 0 ? 0 : ((cashbookCurrentPage - 1) * cashbookPageSize) + 1;
  const lastItem = Math.min(cashbookCurrentPage * cashbookPageSize, totalItems);
  const summary = document.getElementById('so-quy-pagination-summary');
  const pageInfo = document.getElementById('so-quy-page-info');
  const firstButton = document.getElementById('so-quy-first-page');
  const previousButton = document.getElementById('so-quy-prev-page');
  const nextButton = document.getElementById('so-quy-next-page');
  const lastButton = document.getElementById('so-quy-last-page');

  if (summary) {
    summary.textContent = totalItems === 0
      ? 'Không có giao dịch'
      : `Hiển thị ${firstItem}–${lastItem} / ${totalItems} giao dịch`;
  }
  if (pageInfo) pageInfo.textContent = `Trang ${cashbookCurrentPage} / ${cashbookTotalPages}`;

  const isFirstPage = cashbookCurrentPage === 1;
  const isLastPage = cashbookCurrentPage === cashbookTotalPages;
  if (firstButton) firstButton.disabled = isFirstPage;
  if (previousButton) previousButton.disabled = isFirstPage;
  if (nextButton) nextButton.disabled = isLastPage;
  if (lastButton) lastButton.disabled = isLastPage;
}

// Render cashbook table and update stats in UI
export function renderSoQuyTable() {
  const tableBody = document.getElementById('so-quy-table-body');
  if (!tableBody) return;

  const allTxs = getCashbookTransactions();
  // Refresh dynamic dropdown options
  refreshDynamicFilters(allTxs.filter(isEffectiveCashbookTransaction));

  // Get processed transactions and statistics
  const { filteredTransactions, stats } = getProcessedData();

  const filterSignature = JSON.stringify(activeFilters);
  if (filterSignature !== cashbookLastFilterSignature) {
    cashbookCurrentPage = 1;
    expandedCashbookTransactionId = '';
    cashbookLastFilterSignature = filterSignature;
  }
  renderCashbookPagination(filteredTransactions.length);
  const pageStart = (cashbookCurrentPage - 1) * cashbookPageSize;
  const paginatedTransactions = filteredTransactions.slice(pageStart, pageStart + cashbookPageSize);

  // Update Statistics in UI (with integers rounding for clean display)
  const statStartEl = document.getElementById('so-quy-stat-start');
  const statIncomeEl = document.getElementById('so-quy-stat-income');
  const statExpenseEl = document.getElementById('so-quy-stat-expense');
  const statBalanceEl = document.getElementById('so-quy-stat-balance');
  
  if (statStartEl) statStartEl.innerText = formatCurrency(Math.round(stats.startBalance));
  if (statIncomeEl) statIncomeEl.innerText = formatCurrency(Math.round(stats.income));
  if (statExpenseEl) statExpenseEl.innerText = formatCurrency(Math.round(stats.expense));
  if (statBalanceEl) statBalanceEl.innerText = formatCurrency(Math.round(stats.balance));

  // Render Table rows
  if (filteredTransactions.length === 0) {
    expandedCashbookTransactionId = '';
    tableBody.innerHTML = `
      <tr>
        <td colspan="8" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Không có giao dịch sổ quỹ nào phù hợp với bộ lọc hiện tại
        </td>
      </tr>
    `;
    const selectAll = document.getElementById('so-quy-select-all');
    if (selectAll) selectAll.checked = false;
    safeCreateIcons();
    return;
  }

  if (!paginatedTransactions.some(t => String(t.id) === String(expandedCashbookTransactionId))) {
    expandedCashbookTransactionId = '';
  }

  tableBody.innerHTML = paginatedTransactions.map(t => {
    const partnerAddress = getTransactionPartnerAddress(t);
    const valText = t.type === 'thu' ? formatCurrency(t.value) : `-${formatCurrency(t.value)}`;
    const valStyle = t.type === 'thu'
      ? 'color: #0070d2; font-weight: 700;'
      : 'color: var(--color-danger); font-weight: 700;';

    const isExpanded = String(t.id) === String(expandedCashbookTransactionId);
    return `
      <tr class="so-quy-transaction-row ${isExpanded ? 'is-expanded' : ''}" data-id="${escapeCashbookHtml(t.id)}" tabindex="0" role="button" aria-expanded="${isExpanded}">
        <td style="text-align: center; padding: 0.5rem 0.25rem;">
          <input type="checkbox" class="so-quy-row-checkbox" data-id="${t.id}" style="cursor: pointer; width: 14px; height: 14px;">
        </td>
        <td style="text-align: center;">
          <button class="star-btn ${t.starred ? 'starred' : ''}" data-id="${t.id}" title="${t.starred ? 'Bỏ đánh dấu sao' : 'Đánh dấu sao'}">
            <i data-lucide="star" style="width: 14px; height: 14px;"></i>
          </button>
        </td>
        <td style="text-align: center;">
          <span style="font-weight: 700; color: #0070d2; cursor: pointer; text-decoration: underline;" class="so-quy-tx-code">
            ${escapeCashbookHtml(t.id)}
          </span>
        </td>
        <td style="text-align: center; color: var(--text-muted); font-size: 0.8rem;">
          ${formatDateTime(t.date)}
        </td>
        <td>
          <div style="font-weight: 500;">${escapeCashbookHtml(t.category)}</div>
          <span style="font-size: 0.75rem; color: var(--text-muted); font-style: italic;">
            ${t.method === 'cash' ? 'Tiền mặt' : (t.method === 'bank' ? 'Ngân hàng' : 'Ví điện tử')}
          </span>
        </td>
        <td>
          <div style="font-weight: 500;">${escapeCashbookHtml(t.partner)}</div>
          ${t.note ? `<div style="font-size: 0.75rem; color: var(--text-muted); word-break: break-all; margin-top: 0.15rem;">HD: ${escapeCashbookHtml(t.note)}</div>` : ''}
        </td>
        <td style="color: var(--text-secondary); font-size: 0.8rem; line-height: 1.4;">
          ${partnerAddress ? escapeCashbookHtml(partnerAddress) : '<span style="color: var(--text-muted);">-</span>'}
        </td>
        <td style="text-align: right; ${valStyle}">
          ${valText}
        </td>
      </tr>
      ${isExpanded ? renderCashbookInlineDetail(t) : ''}
    `;
  }).join('');

  // Wire up Star toggle event
  tableBody.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const txId = btn.getAttribute('data-id');
      const txs = getCashbookTransactions();
      const found = txs.find(t => t.id === txId);
      if (found) {
        const nextStarred = !found.starred;
        const saved = await dbSetCashbookStarred(found.cloudId || found.id, nextStarred);
        if (!saved) {
          showToast('Không thể cập nhật đánh dấu trên Cloud.', 'danger');
          return;
        }
        found.starred = nextStarred;
        saveCashbookTransactions(txs);
        btn.classList.toggle('starred');
        showToast(found.starred ? 'Đã thêm vào mục quan trọng' : 'Đã bỏ đánh dấu quan trọng', 'info');
      }
    });
  });

  // Expand/collapse one voucher directly below its table row.
  tableBody.querySelectorAll('.so-quy-transaction-row').forEach(row => {
    const toggleRow = () => {
      const txId = row.getAttribute('data-id') || '';
      expandedCashbookTransactionId = String(expandedCashbookTransactionId) === String(txId) ? '' : txId;
      renderSoQuyTable();
    };
    row.addEventListener('click', event => {
      if (event.target.closest('button, input, a, select, textarea')) return;
      toggleRow();
    });
    row.addEventListener('keydown', event => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      toggleRow();
    });
  });

  const selectAll = document.getElementById('so-quy-select-all');
  if (selectAll) selectAll.checked = false;

  const expandedTransaction = paginatedTransactions.find(t => String(t.id) === String(expandedCashbookTransactionId));
  if (expandedTransaction) wireCashbookInlineDetailActions(expandedTransaction, tableBody);

  safeCreateIcons();
}

function openCashbookEditModal(transaction) {
  if (!canEditCashbookTransaction(transaction)) {
    showToast('Phiếu đã hủy hoặc phiếu đảo không được phép sửa.', 'warning');
    return;
  }
  const editModal = document.getElementById('so-quy-edit-modal');
  if (!editModal) return;

  const isReceipt = transaction.type === 'thu';
  const route = getCashbookEditRoute(transaction);
  const title = document.getElementById('cashbook-edit-title');
  const categoryLabel = document.getElementById('cashbook-edit-category-label');
  const collectorLabel = document.getElementById('cashbook-edit-collector-label');
  const counterpartyTypeLabel = document.getElementById('cashbook-edit-counterparty-type-label');
  const partnerLabel = document.getElementById('cashbook-edit-partner-label');
  if (title) title.textContent = isReceipt ? 'Sửa phiếu thu' : 'Sửa phiếu chi';
  if (categoryLabel) categoryLabel.textContent = isReceipt ? 'Loại thu' : 'Loại chi';
  if (collectorLabel) collectorLabel.textContent = isReceipt ? 'Người thu' : 'Người chi';
  if (counterpartyTypeLabel) counterpartyTypeLabel.textContent = isReceipt ? 'Đối tượng nộp' : 'Đối tượng nhận';
  if (partnerLabel) partnerLabel.textContent = isReceipt ? 'Tên người nộp' : 'Tên người nhận';

  document.getElementById('cashbook-edit-id').value = transaction.id;
  document.getElementById('cashbook-edit-code').value = transaction.id;
  document.getElementById('cashbook-edit-type').value = transaction.type === 'thu' ? 'Phiếu thu' : 'Phiếu chi';
  setCashbookDateTimeValue('cashbook-edit-time', toLocalDateTimeInput(transaction.date));
  document.getElementById('cashbook-edit-category').value = transaction.category || '';
  document.getElementById('cashbook-edit-partner').value = transaction.partner || '';
  document.getElementById('cashbook-edit-value').value = Number(transaction.value || 0);
  document.getElementById('cashbook-edit-method').value = transaction.method || 'cash';
  document.getElementById('cashbook-edit-accounting').checked = transaction.accounting !== false;
  document.getElementById('cashbook-edit-note').value = transaction.note || '';

  const collectorSelect = document.getElementById('cashbook-edit-collector');
  if (collectorSelect) {
    collectorSelect.innerHTML = (state.users || [])
      .filter(user => user.isActive !== false)
      .map(user => {
        const id = user.id || user.authUserId || user.username || '';
        const label = user.displayName || user.name || user.username || id;
        return `<option value="${escapeCashbookHtml(id)}">${escapeCashbookHtml(label)}</option>`;
      }).join('');
    const collectorId = transaction.collectorId || state.currentUser?.id || state.currentUser?.authUserId || state.currentUser?.username;
    if (collectorId && ![...collectorSelect.options].some(option => option.value === String(collectorId))) {
      const collectorName = transaction.collectorName
        || state.currentUser?.displayName
        || state.currentUser?.name
        || state.currentUser?.username
        || `Nhân viên ${collectorId}`;
      collectorSelect.insertAdjacentHTML(
        'afterbegin',
        `<option value="${escapeCashbookHtml(collectorId)}">${escapeCashbookHtml(collectorName)}</option>`
      );
    }
    if (collectorId && [...collectorSelect.options].some(option => option.value === String(collectorId))) {
      collectorSelect.value = String(collectorId);
    }
  }

  const counterpartyType = getCashbookCounterpartyType(transaction);
  const counterpartyTypeSelect = document.getElementById('cashbook-edit-counterparty-type');
  if (counterpartyTypeSelect) {
    counterpartyTypeSelect.value = counterpartyType;
    counterpartyTypeSelect.disabled = route !== 'standalone';
  }
  populateCashbookCounterpartyOptions(
    counterpartyType,
    transaction.counterpartyId || transaction.customerId || transaction.supplierId || '',
    transaction.partner || ''
  );
  const counterpartySelect = document.getElementById('cashbook-edit-counterparty');
  if (counterpartySelect) {
    counterpartySelect.disabled = route === 'return_refund'
      || route === 'sale_receipt'
      || (route === 'customer_receipt' && Boolean(transaction.orderId))
      || (route === 'supplier_payment' && Boolean(transaction.purchaseId));
  }
  editModal.classList.add('active');
}

// Wire actions for the single inline voucher detail currently open.
function wireCashbookInlineDetailActions(t, tableBody) {
  const detailRow = Array.from(tableBody.querySelectorAll('.so-quy-inline-detail-row'))
    .find(row => String(row.dataset.id) === String(t.id));
  if (!detailRow) return;

  detailRow.querySelector('.js-cashbook-inline-close')?.addEventListener('click', () => {
    expandedCashbookTransactionId = '';
    renderSoQuyTable();
  });

  detailRow.querySelector('.js-cashbook-inline-edit')?.addEventListener('click', () => {
    expandedCashbookTransactionId = '';
    renderSoQuyTable();
    openCashbookEditModal(t);
  });

  const reconcileBtn = detailRow.querySelector('.js-cashbook-inline-reconcile');
  const legacyCustomer = getLegacyReceiptCustomer(t);
  if (reconcileBtn && legacyCustomer) {
    reconcileBtn.addEventListener('click', async () => {
      const cashbookId = getCanonicalCashbookId(t);
      if (!cashbookId) {
        showToast('Không xác định được mã phiếu Cloud. Dữ liệu chưa thay đổi.', 'danger');
        return;
      }
      if (!confirm(`Ghi phiếu ${t.id} vào công nợ của ${legacyCustomer.name}? Công nợ sẽ giảm ${formatCurrency(t.value)}.`)) return;

      reconcileBtn.disabled = true;
      try {
        const result = await dbReconcileLegacyCustomerReceipt(cashbookId, legacyCustomer.id);
        if (!result) return;
        await Promise.all([
          dbRefreshCustomerFinancialState(legacyCustomer.id, { includeHistory: false }),
          result.transaction
            ? Promise.resolve(upsertCashbookTransactionSnapshot(result.transaction))
            : dbFetchCashbookTransactionById(cashbookId)
        ]);
        expandedCashbookTransactionId = '';
        renderAll();
        showToast(result.already_reconciled
          ? 'Phiếu thu này đã có trong lịch sử công nợ.'
          : `Đã ghi phiếu ${t.id} vào lịch sử và cập nhật công nợ ${legacyCustomer.name}.`, 'success');
      } finally {
        reconcileBtn.disabled = false;
      }
    });
  }

  detailRow.querySelector('.js-cashbook-inline-cancel')?.addEventListener('click', async event => {
    const cancelBtn = event.currentTarget;
    if (!confirm(`Bạn có chắc chắn muốn hủy phiếu [${t.id}]? Số tiền giao dịch sẽ không còn được hạch toán vào Sổ quỹ và sẽ khôi phục lại công nợ đối tác nếu có.`)) return;

    const cashbookId = getCanonicalCashbookId(t);
    if (!cashbookId) {
      showToast('Không xác định được mã phiếu Cloud. Dữ liệu chưa thay đổi.', 'danger');
      return;
    }

    cancelBtn.disabled = true;
    try {
      const savedToCloud = await dbCancelCashbookEntry(cashbookId, `Hủy phiếu ${t.id}`);
      if (!savedToCloud) return;

      const customerRefreshed = savedToCloud.customer_id
        ? await dbRefreshCustomerFinancialState(savedToCloud.customer_id, { includeHistory: false })
        : true;
      const originalRefreshed = savedToCloud.transaction
        ? upsertCashbookTransactionSnapshot(savedToCloud.transaction)
        : await dbFetchCashbookTransactionById(cashbookId);
      const reversalRefreshed = savedToCloud.reversal_id
        ? await dbFetchCashbookTransactionById(savedToCloud.reversal_id)
        : true;
      const cashbookRefreshed = Boolean(originalRefreshed && reversalRefreshed);
      const supplierDebt = Number(savedToCloud.supplier_debt);
      if (savedToCloud.supplier_id && savedToCloud.supplier_debt != null && Number.isFinite(supplierDebt)) {
        const supplier = state.suppliers.find(s => String(s.id) === String(savedToCloud.supplier_id));
        if (supplier) supplier.debt = supplierDebt;
      }
      localStorage.setItem('billing_system_suppliers', JSON.stringify(state.suppliers));

      if (!customerRefreshed || !cashbookRefreshed) {
        showToast('Phiếu đã hủy trên Cloud nhưng giao diện chưa tải lại đầy đủ. Vui lòng tải lại trang.', 'warning');
      } else {
        showToast(`Đã hủy thành công phiếu ${t.id}`, 'warning');
      }
      expandedCashbookTransactionId = '';
      await reloadCashbookDateWindow();
      renderAll();
    } finally {
      cancelBtn.disabled = false;
    }
  });
}
// Excel Export Report using SheetJS (XLSX)
function exportSoQuyToExcel(filteredTxs) {
  const sheetData = [
    ["Mã phiếu", "Thời gian", "Loại phiếu", "Loại thu chi", "Người nộp/nhận", "Địa chỉ", "Phương thức thanh toán", "Giá trị (đ)", "Hạch toán kết quả KD", "Trạng thái", "Người tạo", "Ghi chú"]
  ];
  
  filteredTxs.forEach(t => {
    sheetData.push([
      t.id,
      formatDateTime(t.date),
      t.type === 'thu' ? 'Phiếu thu' : 'Phiếu chi',
      t.category,
      t.partner,
      getTransactionPartnerAddress(t),
      t.method === 'cash' ? 'Tiền mặt' : (t.method === 'bank' ? 'Ngân hàng' : 'Ví điện tử'),
      t.value,
      t.accounting ? 'Có' : 'Không',
      t.status,
      t.creator || 'Hệ thống',
      t.note || ''
    ]);
  });
  
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(sheetData);
  
  // Format column widths for export
  const wscols = [
    { wch: 15 }, // Code
    { wch: 18 }, // Time
    { wch: 12 }, // Type
    { wch: 25 }, // Category
    { wch: 35 }, // Partner
    { wch: 40 }, // Address
    { wch: 18 }, // Method
    { wch: 15 }, // Value
    { wch: 15 }, // Accounting
    { wch: 15 }, // Status
    { wch: 15 }, // Creator
    { wch: 30 }  // Note
  ];
  ws['!cols'] = wscols;

  XLSX.utils.book_append_sheet(wb, ws, "Báo Cáo Sổ Quỹ");
  
  const dateStr = new Date().toISOString().slice(0, 10);
  XLSX.writeFile(wb, `So_quy_bao_cao_${dateStr}.xlsx`);
  showToast('Xuất báo cáo Sổ quỹ Excel thành công!', 'success');
}
