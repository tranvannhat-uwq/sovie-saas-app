import { state } from '../state.js';
import { formatCurrency, formatDateTime, safeCreateIcons, showToast } from '../utils.js';
import {
  dbCancelPurchase,
  dbCancelSupplierPayment,
  dbCreatePurchase,
  dbRecordSupplierPayment,
  getCloudReadHealth
} from '../services/supabase.js';
import { ensurePanelCloudData, switchTab } from '../main.js';
import { filterPurchasesForExport, parsePurchaseImportRows } from '../domain/purchase-excel.js';

let pendingPurchaseKey = '';
const pendingSupplierPaymentKeys = new Map();
let purchaseExcelImportData = [];
let activePurchasePanel = null;
let supplierSavedListenerInstalled = false;
let purchaseSupplierSelectionPending = false;

function getXLSX() {
  const library = globalThis.XLSX;
  if (!library?.utils || !library.writeFile) {
    showToast('Không tải được thư viện Excel. Hãy tải lại trang rồi thử lại.', 'danger');
    return null;
  }
  return library;
}

function financeRole() {
  return state.currentUser?.role === 'admin' || state.currentUser?.role === 'accounting';
}

function newKey(prefix) {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `${prefix}:${value}`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

function requestPurchaseCancellationReason(title) {
  return new Promise(resolve => {
    const previousFocus = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay active purchase-reason-overlay';
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'purchase-reason-title');
    overlay.setAttribute('aria-describedby', 'purchase-reason-help');
    overlay.innerHTML = `
      <div class="modal-content purchase-reason-dialog" tabindex="-1">
        <div class="modal-header"><h3 class="modal-title" id="purchase-reason-title">${escapeHtml(title)}</h3></div>
        <div class="modal-body">
          <label for="purchase-cancellation-reason">Lý do hủy <span aria-hidden="true">*</span></label>
          <textarea id="purchase-cancellation-reason" class="form-control" rows="3" maxlength="500" required aria-describedby="purchase-reason-help"></textarea>
          <small id="purchase-reason-help">Lý do được lưu trong lịch sử nghiệp vụ.</small>
          <div class="purchase-reason-error" role="alert" aria-live="polite"></div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" data-purchase-reason-cancel>Để sau</button>
          <button type="button" class="btn btn-danger" data-purchase-reason-submit>Xác nhận hủy</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const reasonInput = overlay.querySelector('#purchase-cancellation-reason');
    const errorLabel = overlay.querySelector('.purchase-reason-error');
    const cancelButton = overlay.querySelector('[data-purchase-reason-cancel]');
    const submitButton = overlay.querySelector('[data-purchase-reason-submit]');
    const finish = reason => {
      overlay.removeEventListener('keydown', onKeyDown);
      overlay.remove();
      if (previousFocus?.isConnected) previousFocus.focus();
      resolve(reason);
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(null);
      } else if (event.key === 'Tab') {
        const focusable = [reasonInput, cancelButton, submitButton];
        const currentIndex = focusable.indexOf(document.activeElement);
        const nextIndex = event.shiftKey
          ? (currentIndex <= 0 ? focusable.length - 1 : currentIndex - 1)
          : (currentIndex < 0 || currentIndex === focusable.length - 1 ? 0 : currentIndex + 1);
        event.preventDefault();
        focusable[nextIndex].focus();
      }
    };
    overlay.addEventListener('keydown', onKeyDown);
    overlay.addEventListener('click', event => {
      if (event.target === overlay) finish(null);
    });
    cancelButton.addEventListener('click', () => finish(null));
    submitButton.addEventListener('click', () => {
      const reason = reasonInput.value.trim();
      if (!reason) {
        errorLabel.textContent = 'Vui lòng nhập lý do hủy.';
        reasonInput.focus();
        return;
      }
      finish(reason);
    });
    reasonInput.addEventListener('input', () => { errorLabel.textContent = ''; });
    reasonInput.focus();
  });
}

function purchaseTotal(purchase) {
  return Number(purchase.totalAmount ?? purchase.totalPayable ?? 0);
}

function purchaseDate(purchase) {
  const value = purchase.purchaseDate || purchase.date;
  return value ? formatDateTime(value) : '-';
}

function statusLabel(status) {
  if (status === 'cancelled') return 'Đã hủy';
  if (status === 'draft') return 'Phiếu tạm';
  return 'Hoàn thành';
}

function purchaseEntrySuggestions() {
  const suggestions = new Map();
  (state.purchases || []).forEach(purchase => {
    if (!['completed', 'draft'].includes(String(purchase.status || 'completed'))) return;
    (purchase.items || []).forEach(item => {
      const code = String(item.code || '').trim();
      if (!code) return;
      const key = code.toLocaleLowerCase('vi');
      if (!suggestions.has(key)) suggestions.set(key, {
        code,
        name: String(item.name || '').trim(),
        unit: String(item.unit || '').trim()
      });
    });
  });
  return [...suggestions.values()].sort((left, right) => left.code.localeCompare(right.code, 'vi'));
}

function itemRow(item = {}) {
  return `
    <tr class="purchase-entry-item-row">
      <td><input type="text" class="purchase-entry-code" value="${escapeHtml(item.code || '')}" required list="purchase-entry-code-list" autocomplete="off" placeholder="Mã hàng/dịch vụ"></td>
      <td><input type="text" class="purchase-entry-name" value="${escapeHtml(item.name || '')}" required list="purchase-entry-name-list" autocomplete="off" placeholder="Tên hàng hóa/dịch vụ"></td>
      <td><input type="text" class="purchase-entry-unit" value="${escapeHtml(item.unit || '')}" placeholder="ĐVT"></td>
      <td><input type="number" class="purchase-entry-qty" min="0.0001" step="any" value="${item.quantity || 1}" required></td>
      <td><input type="number" class="purchase-entry-price" min="0" step="1" value="${item.unitPrice || 0}" required></td>
      <td class="purchase-entry-line-total">0 ₫</td>
      <td><button type="button" class="purchase-entry-remove-row" title="Xóa dòng">×</button></td>
    </tr>`;
}

function purchaseExcelImportModal() {
  return `
    <div class="modal-overlay purchase-excel-modal" id="purchase-excel-modal">
      <div class="modal-content purchase-excel-dialog">
        <div class="modal-header">
          <div><h3 class="modal-title">Nhập phiếu mua từ Excel</h3><small>Mỗi mã nhóm phiếu sẽ tạo một phiếu mua; nhiều dòng cùng mã được gom thành một phiếu.</small></div>
          <button type="button" class="modal-close" id="btn-close-purchase-excel">×</button>
        </div>
        <div class="modal-body">
          <div class="upload-dropzone" id="purchase-excel-dropzone">
            <div class="upload-icon"><i data-lucide="file-up"></i></div>
            <p class="upload-text">Kéo thả tệp Excel (.xlsx, .xls) hoặc CSV vào đây</p>
            <input type="file" id="purchase-excel-file-input" accept=".xlsx,.xls,.csv" hidden>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-browse-purchase-excel">Chọn tệp</button>
          </div>
          <div class="purchase-excel-warning">
            Khi xác nhận, mỗi mã nhóm sẽ tạo phiếu mua thực tế và cập nhật công nợ; khoản thanh toán ngay sẽ tạo phiếu chi. Mã nhóm được dùng để chống tạo trùng khi nhập lại cùng dữ liệu.
          </div>
          <div id="purchase-excel-preview-container" hidden>
            <div class="table-responsive">
              <table class="table purchase-excel-preview-table">
                <thead><tr><th>Mã nhóm</th><th>Nhà cung cấp</th><th>Số hóa đơn</th><th>Số dòng</th><th>Tổng tiền</th><th>Trả ngay</th></tr></thead>
                <tbody id="purchase-excel-preview-body"></tbody>
              </table>
            </div>
            <p id="purchase-excel-preview-summary" role="status" aria-live="polite"></p>
            <ul id="purchase-excel-errors" class="purchase-excel-errors" role="alert"></ul>
          </div>
        </div>
        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" id="btn-cancel-purchase-excel">Đóng</button>
          <button type="button" class="btn btn-primary" id="btn-save-purchase-excel" disabled>Tạo phiếu mua</button>
        </div>
      </div>
    </div>`;
}

function populatePurchaseSupplierSelect(panel, preferredId = '') {
  const select = panel?.querySelector('#purchase-supplier-select');
  if (!select) return;
  const selectedId = preferredId || select.value;
  select.innerHTML = `<option value="">-- Chọn nhà cung cấp --</option>${(state.suppliers || [])
    .filter(supplier => supplier?.isActive !== false)
    .map(supplier => `<option value="${escapeHtml(supplier.id)}">${escapeHtml(supplier.name)} (${escapeHtml(supplier.code)})</option>`).join('')}`;
  if (selectedId && [...select.options].some(option => option.value === String(selectedId))) select.value = String(selectedId);
}

function installSupplierSavedListener() {
  if (supplierSavedListenerInstalled || typeof document === 'undefined') return;
  supplierSavedListenerInstalled = true;
  for (const id of ['btn-cancel-supplier-modal', 'btn-close-supplier-modal']) {
    document.getElementById(id)?.addEventListener('click', () => { purchaseSupplierSelectionPending = false; });
  }
  document.addEventListener('sovie:supplier-saved', event => {
    const panel = activePurchasePanel;
    if (!purchaseSupplierSelectionPending || !panel?.querySelector('#purchase-supplier-select')) return;
    purchaseSupplierSelectionPending = false;
    const saved = (state.suppliers || []).find(supplier =>
      (event.detail?.id && String(supplier.id) === String(event.detail.id)) ||
      (event.detail?.code && String(supplier.code).trim().toLocaleUpperCase('vi') === String(event.detail.code).trim().toLocaleUpperCase('vi'))
    );
    populatePurchaseSupplierSelect(panel, saved?.id || '');
    const createButton = panel.querySelector('#btn-open-purchase-modal');
    const failedDomains = getCloudReadHealth().failedDomains;
    if (createButton) {
      createButton.disabled = failedDomains.includes('purchases') || failedDomains.includes('suppliers') ||
        !(state.suppliers || []).some(supplier => supplier?.isActive !== false);
    }
    if (saved) showToast('Đã thêm nhà cung cấp vào danh sách của phiếu mua.', 'success');
  });
}

function getFilteredPurchases(panel) {
  return filterPurchasesForExport(
    state.purchases,
    panel?.dataset.purchaseSearch || '',
    panel?.dataset.purchaseStatus || 'all'
  );
}

export function downloadPurchaseExcelTemplate() {
  const XLSX = getXLSX();
  if (!XLSX) return;
  const workbook = XLSX.utils.book_new();
  const headers = [
    'Mã nhóm phiếu', 'Mã nhà cung cấp', 'Số hóa đơn đầu vào', 'Ngày mua',
    'Mã hàng hóa/dịch vụ', 'Tên hàng hóa/dịch vụ', 'Đơn vị tính', 'Số lượng',
    'Đơn giá', 'Thanh toán ngay (đ)', 'Phương thức chi', 'Ghi chú'
  ];
  const worksheet = XLSX.utils.aoa_to_sheet([headers]);
  worksheet['!cols'] = [{ wch: 20 }, { wch: 20 }, { wch: 24 }, { wch: 18 }, { wch: 24 }, { wch: 34 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 20 }, { wch: 35 }];
  worksheet['!autofilter'] = { ref: 'A1:L1' };
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Nhap Phieu Mua');
  const guide = XLSX.utils.aoa_to_sheet([
    ['HƯỚNG DẪN NHẬP PHIẾU MUA'],
    ['Mỗi dòng là một mặt hàng/dịch vụ. Lặp lại Mã nhóm phiếu cho các dòng thuộc cùng một phiếu.'],
    ['Mã nhóm phiếu phải ổn định và duy nhất cho mỗi phiếu nguồn; dùng lại mã cùng dữ liệu sẽ không tạo phiếu trùng.'],
    ['Mã nhà cung cấp phải khớp nhà cung cấp đang hoạt động trong workspace. Có thể thêm nhà cung cấp ở màn hình Phiếu mua.'],
    ['Ngày mua chấp nhận dd/mm/yyyy hoặc yyyy-mm-dd. Số lượng phải lớn hơn 0; đơn giá và thanh toán ngay không âm.'],
    ['Phương thức chi: Tiền mặt, Ngân hàng hoặc Ví điện tử. Để trống thì mặc định Tiền mặt.'],
    ['Các trường thông tin phiếu nên lặp lại trên mọi dòng của cùng mã nhóm. Tổng tối đa 100 dòng hàng cho mỗi phiếu.'],
    ['Lưu file sẽ tạo phiếu mua, ghi công nợ và tạo phiếu chi nếu có thanh toán ngay. Mã phiếu trên hệ thống được tự sinh.']
  ]);
  guide['!cols'] = [{ wch: 120 }];
  XLSX.utils.book_append_sheet(workbook, guide, 'Huong Dan');
  XLSX.writeFile(workbook, 'Mau_Nhap_Phieu_Mua.xlsx');
  showToast('Đã tải file Excel mẫu phiếu mua.');
}

export function exportPurchasesExcel(panel = activePurchasePanel) {
  if (getCloudReadHealth().failedDomains.includes('purchases')) {
    showToast('Danh sách phiếu mua chưa tải được từ Cloud; hãy tải lại trước khi xuất.', 'danger');
    return;
  }
  const XLSX = getXLSX();
  if (!XLSX) return;
  const purchases = getFilteredPurchases(panel);
  if (!purchases.length) {
    showToast('Không có phiếu mua nào phù hợp để xuất.', 'warning');
    return;
  }
  const workbook = XLSX.utils.book_new();
  const summaryHeaders = ['Mã phiếu mua', 'Ngày mua', 'Số hóa đơn đầu vào', 'Mã nhà cung cấp', 'Tên nhà cung cấp', 'Tổng tiền (đ)', 'Đã thanh toán (đ)', 'Còn nợ (đ)', 'Trạng thái', 'Người tạo', 'Ghi chú'];
  const summaryRows = purchases.map(purchase => [
    purchase.code || '', purchase.purchaseDate || purchase.date || '', purchase.invoiceNumber || '',
    purchase.supplierCode || '', purchase.supplierName || '', purchaseTotal(purchase),
    Number(purchase.paidAmount || 0), Number(purchase.balanceDue || 0), statusLabel(purchase.status),
    purchase.createdBy || '', purchase.notes || ''
  ]);
  const summarySheet = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryRows]);
  summarySheet['!cols'] = [{ wch: 26 }, { wch: 24 }, { wch: 26 }, { wch: 20 }, { wch: 36 }, { wch: 20 }, { wch: 22 }, { wch: 20 }, { wch: 18 }, { wch: 24 }, { wch: 42 }];
  summarySheet['!autofilter'] = { ref: 'A1:K' + (summaryRows.length + 1) };
  for (let row = 2; row <= summaryRows.length + 1; row += 1) {
    for (const column of ['F', 'G', 'H']) {
      const cell = summarySheet[column + row];
      if (cell) cell.z = '#,##0';
    }
  }
  XLSX.utils.book_append_sheet(workbook, summarySheet, 'Phieu Mua');

  const itemHeaders = ['Mã phiếu mua', 'Mã nhóm phiếu trên hệ thống', 'Mã nhà cung cấp', 'Tên nhà cung cấp', 'Số hóa đơn đầu vào', 'Mã hàng hóa/dịch vụ', 'Tên hàng hóa/dịch vụ', 'Đơn vị tính', 'Số lượng', 'Đơn giá (đ)', 'Thành tiền (đ)'];
  const itemRows = purchases.flatMap(purchase => (purchase.items || []).map(item => [
    purchase.code || '', purchase.code || '', purchase.supplierCode || '', purchase.supplierName || '',
    purchase.invoiceNumber || '', item.code || '', item.name || '', item.unit || '',
    Number(item.quantity || 0), Number(item.unitPrice || 0), Number(item.lineTotal ?? (Number(item.quantity || 0) * Number(item.unitPrice || 0)))
  ]));
  const itemSheet = XLSX.utils.aoa_to_sheet([itemHeaders, ...itemRows]);
  itemSheet['!cols'] = [{ wch: 26 }, { wch: 26 }, { wch: 20 }, { wch: 36 }, { wch: 26 }, { wch: 24 }, { wch: 34 }, { wch: 16 }, { wch: 14 }, { wch: 18 }, { wch: 20 }];
  itemSheet['!autofilter'] = { ref: 'A1:K' + (itemRows.length + 1) };
  for (let row = 2; row <= itemRows.length + 1; row += 1) {
    for (const column of ['I', 'J', 'K']) {
      const cell = itemSheet[column + row];
      if (cell) cell.z = '#,##0.##';
    }
  }
  XLSX.utils.book_append_sheet(workbook, itemSheet, 'Chi Tiet Hang');
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  XLSX.writeFile(workbook, 'DanhSachPhieuMua_' + stamp + '.xlsx');
  showToast('Đã xuất ' + purchases.length + ' phiếu mua và ' + itemRows.length + ' dòng hàng theo bộ lọc hiện tại.');
}

function openPurchaseExcelModal(panel) {
  const modal = panel.querySelector('#purchase-excel-modal');
  if (!modal) return;
  purchaseExcelImportData = [];
  panel.querySelector('#purchase-excel-file-input').value = '';
  panel.querySelector('#purchase-excel-preview-container').hidden = true;
  panel.querySelector('#purchase-excel-preview-body').innerHTML = '';
  panel.querySelector('#purchase-excel-preview-summary').textContent = '';
  panel.querySelector('#purchase-excel-errors').innerHTML = '';
  panel.querySelector('#btn-save-purchase-excel').disabled = true;
  panel.querySelector('#purchase-excel-dropzone').className = 'upload-dropzone';
  modal.classList.add('active');
  safeCreateIcons();
}

function closePurchaseExcelModal(panel) {
  panel.querySelector('#purchase-excel-modal')?.classList.remove('active');
}

function renderPurchaseExcelPreview(panel, parsed) {
  const container = panel.querySelector('#purchase-excel-preview-container');
  const body = panel.querySelector('#purchase-excel-preview-body');
  const summary = panel.querySelector('#purchase-excel-preview-summary');
  const errors = panel.querySelector('#purchase-excel-errors');
  if (!container || !body || !summary || !errors) return;
  container.hidden = false;
  body.innerHTML = parsed.purchases.slice(0, 12).map(purchase => `
    <tr><td>${escapeHtml(purchase.groupCode)}</td><td>${escapeHtml(purchase.supplierName)} (${escapeHtml(purchase.supplierCode)})</td>
      <td>${escapeHtml(purchase.invoiceNumber || '-')}</td><td>${purchase.items.length}</td>
      <td>${formatCurrency(purchase.totalAmount)}</td><td>${formatCurrency(purchase.paidAmount)}</td></tr>`).join('');
  summary.textContent = parsed.purchases.length
    ? 'Đọc được ' + parsed.purchases.length + ' phiếu; xem trước tối đa 12 phiếu. ' + (parsed.errors.length ? 'Cần sửa lỗi trước khi lưu.' : 'Kiểm tra dữ liệu rồi chọn Tạo phiếu mua.')
    : 'Chưa có phiếu mua hợp lệ để xem trước.';
  errors.innerHTML = parsed.errors.slice(0, 30).map(error => '<li>' + escapeHtml(error) + '</li>').join('');
  if (parsed.errors.length > 30) errors.innerHTML += '<li>Và ' + (parsed.errors.length - 30) + ' lỗi khác. Hãy sửa file rồi tải lại.</li>';
  panel.querySelector('#btn-save-purchase-excel').disabled = Boolean(parsed.errors.length || !parsed.purchases.length);
}

function handlePurchaseExcelFile(panel, file) {
  if (!file) return;
  purchaseExcelImportData = [];
  const XLSX = getXLSX();
  if (!XLSX) return;
  const reader = new FileReader();
  reader.onload = event => {
    try {
      const workbook = XLSX.read(new Uint8Array(event.target.result), { type: 'array', cellDates: false });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(firstSheet, { header: 1, defval: '', raw: true, blankrows: false });
      const parsed = parsePurchaseImportRows(rows, state.suppliers);
      purchaseExcelImportData = parsed.errors.length ? [] : parsed.purchases;
      renderPurchaseExcelPreview(panel, parsed);
      panel.querySelector('#purchase-excel-dropzone').classList.toggle('success-uploaded', parsed.purchases.length > 0 && !parsed.errors.length);
      showToast(parsed.errors.length ? 'Tệp có lỗi; chưa thể lưu phiếu mua.' : 'Đã đọc được ' + parsed.purchases.length + ' phiếu mua.', parsed.errors.length ? 'danger' : 'success');
    } catch (error) {
      console.error('Read purchase Excel failed:', error);
      purchaseExcelImportData = [];
      renderPurchaseExcelPreview(panel, { purchases: [], errors: ['Không đọc được tệp Excel: ' + (error.message || 'tệp không hợp lệ') + '.'] });
      showToast('Không đọc được tệp Excel phiếu mua.', 'danger');
    } finally {
      panel.querySelector('#purchase-excel-file-input').value = '';
    }
  };
  reader.readAsArrayBuffer(file);
}

async function processPurchaseExcelImport(panel) {
  if (!purchaseExcelImportData.length) return;
  const failedDomains = getCloudReadHealth().failedDomains;
  if (failedDomains.includes('purchases') || failedDomains.includes('suppliers')) {
    showToast('Phiếu mua hoặc nhà cung cấp chưa tải được từ Cloud; hãy tải lại trước khi nhập.', 'danger');
    return;
  }
  const button = panel.querySelector('#btn-save-purchase-excel');
  if (button) button.disabled = true;
  let saved = 0;
  let alreadyRecorded = 0;
  try {
    for (const purchase of purchaseExcelImportData) {
      const result = await dbCreatePurchase({
        supplierId: purchase.supplierId,
        invoiceNumber: purchase.invoiceNumber,
        purchaseDate: purchase.purchaseDate,
        paidAmount: purchase.paidAmount,
        paymentMethod: purchase.paymentMethod,
        notes: purchase.notes,
        idempotencyKey: 'purchase-excel:' + (state.saasContext?.organizationId || 'default') + ':' + purchase.groupCode,
        items: purchase.items
      });
      if (!result) break;
      saved += 1;
      if (result.already_recorded) alreadyRecorded += 1;
    }
    if (saved === purchaseExcelImportData.length) {
      closePurchaseExcelModal(panel);
      showToast('Đã xử lý ' + saved + ' phiếu mua (' + (saved - alreadyRecorded) + ' tạo mới, ' + alreadyRecorded + ' đã được ghi nhận trước đó).', 'success');
    } else if (saved > 0) {
      showToast('Đã xử lý ' + saved + '/' + purchaseExcelImportData.length + ' phiếu trước khi gặp lỗi. Có thể nhập lại cùng tệp; mã nhóm giúp tránh tạo trùng.', 'warning');
    }
    renderPurchasesPanel(panel);
  } catch (error) {
    console.error('Import purchase Excel failed:', error);
    showToast('Lỗi khi nhập phiếu mua: ' + (error.message || 'không xác định') + '. Có thể nhập lại tệp để tiếp tục an toàn.', 'danger');
  } finally {
    if (button?.isConnected) button.disabled = !purchaseExcelImportData.length;
  }
}

function purchaseModal() {
  return `
    <div class="modal-overlay" id="purchase-entry-modal">
      <div class="modal-content purchase-entry-modal-content">
        <div class="modal-header">
          <h3 class="modal-title">Tạo phiếu mua hàng</h3>
          <button class="modal-close" id="btn-close-purchase-entry">×</button>
        </div>
        <form id="purchase-entry-form">
          <div class="modal-body purchase-entry-modal-body">
            <div class="form-group">
              <label class="form-label">Nhà cung cấp *</label>
              <div class="purchase-supplier-select-wrap">
                <select class="form-control" id="purchase-supplier-select" required>
                  <option value="">-- Chọn nhà cung cấp --</option>
                  ${state.suppliers.filter(supplier => supplier?.isActive !== false).map(supplier => `<option value="${escapeHtml(supplier.id)}">${escapeHtml(supplier.name)} (${escapeHtml(supplier.code)})</option>`).join('')}
                </select>
                <button type="button" class="btn btn-secondary btn-sm" id="btn-add-purchase-supplier-inline"><i data-lucide="user-plus"></i> Thêm NCC</button>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">Số hóa đơn đầu vào</label>
              <input class="form-control" id="purchase-invoice-number" maxlength="100">
            </div>
            <div class="form-group">
              <label class="form-label">Ngày mua *</label>
              <input type="datetime-local" class="form-control" id="purchase-date-input" required>
            </div>
            <div class="form-group">
              <label class="form-label">Thanh toán ngay</label>
              <input type="number" class="form-control" id="purchase-paid-input" min="0" step="1" value="0">
            </div>
            <div class="form-group">
              <label class="form-label">Phương thức chi</label>
              <select class="form-control" id="purchase-payment-method">
                <option value="cash">Tiền mặt</option><option value="bank">Ngân hàng</option><option value="wallet">Ví điện tử</option>
              </select>
            </div>
            <div class="form-group purchase-form-wide">
              <div class="purchase-entry-heading">
                <label class="form-label">Hàng hóa/dịch vụ *</label>
                <button type="button" class="btn btn-secondary btn-sm" id="btn-add-purchase-item-row">Thêm dòng</button>
              </div>
              <div class="purchase-entry-items-wrap">
                <table class="purchase-entry-items-table">
                  <thead><tr><th>Mã</th><th>Tên hàng hóa/dịch vụ</th><th>ĐVT</th><th>SL</th><th>Đơn giá</th><th>Thành tiền dự kiến</th><th></th></tr></thead>
                  <tbody id="purchase-entry-items-body">${itemRow()}</tbody>
                </table>
              </div>
              <datalist id="purchase-entry-code-list">${purchaseEntrySuggestions().map(item => `<option value="${escapeHtml(item.code)}" label="${escapeHtml([item.name, item.unit].filter(Boolean).join(' · '))}"></option>`).join('')}</datalist>
              <datalist id="purchase-entry-name-list">${purchaseEntrySuggestions().filter(item => item.name).map(item => `<option value="${escapeHtml(item.name)}" label="${escapeHtml([item.code, item.unit].filter(Boolean).join(' · '))}"></option>`).join('')}</datalist>
              <div class="purchase-entry-total"><span>Tổng dự kiến</span><strong id="purchase-entry-total">0 ₫</strong></div>
              <div class="purchase-entry-total"><span>Còn phải trả dự kiến</span><strong id="purchase-entry-debt-total">0 ₫</strong></div>
              <small>Chọn mã hoặc tên từng nhập để tự điền. Mã mới nhập trực tiếp sẽ có trong gợi ý sau khi lưu phiếu. Database sẽ tự tính lại toàn bộ thành tiền và công nợ.</small>
            </div>
            <div class="form-group purchase-form-wide"><label class="form-label">Ghi chú</label><textarea class="form-control" id="purchase-note-input" rows="2"></textarea></div>
          </div>
          <div class="modal-footer"><button type="button" class="btn btn-secondary" id="btn-cancel-purchase-entry">Đóng</button><button type="submit" class="btn btn-primary">Hoàn thành phiếu mua</button></div>
        </form>
      </div>
    </div>`;
}

function purchaseDetail(purchase) {
  const activePayments = (purchase.payments || []).filter(payment => payment.status === 'completed');
  return `
    <tr class="purchase-detail-row"><td colspan="10">
      <div class="purchase-detail purchase-template-detail">
        <div class="purchase-detail-head">
          <div class="purchase-template-heading">
            <strong class="purchase-template-code">${escapeHtml(purchase.code)}</strong>
            <span class="purchase-status ${escapeHtml(purchase.status)}">${statusLabel(purchase.status)}</span>
          </div>
          <div class="purchase-detail-actions purchase-template-actions">
            <button class="btn btn-secondary btn-sm purchase-print-btn" data-id="${escapeHtml(purchase.id)}"><i data-lucide="printer"></i> In phiếu mua</button>
            ${purchase.status === 'completed' ? `<button class="btn btn-danger btn-sm purchase-cancel-btn" data-id="${escapeHtml(purchase.id)}"><i data-lucide="trash-2"></i> Hủy phiếu mua</button>` : ''}
          </div>
        </div>
        <div class="purchase-detail-meta purchase-template-meta">
          <div><span class="purchase-template-meta-label">Hóa đơn đầu vào:</span><strong>${escapeHtml(purchase.invoiceNumber || '-')}</strong></div>
          <div><span class="purchase-template-meta-label">Ngày mua:</span><strong>${escapeHtml(purchaseDate(purchase))}</strong></div>
          <div><span class="purchase-template-meta-label">Người thực hiện:</span><strong>${escapeHtml(purchase.createdBy || '-')}</strong></div>
          <div><span class="purchase-template-meta-label">Nhà cung cấp:</span><strong class="purchase-template-supplier">${escapeHtml(purchase.supplierName || purchase.supplierCode || '-')}</strong></div>
        </div>
        <div class="table-responsive purchase-template-items-wrap">
          <table class="table purchase-items-table purchase-template-items-table"><thead><tr><th>Mã</th><th>Tên</th><th>ĐVT</th><th class="purchase-template-numeric">SL</th><th class="purchase-template-numeric">Đơn giá</th><th class="purchase-template-numeric">Thành tiền</th></tr></thead><tbody>
            ${(purchase.items || []).map(item => `<tr><td><span class="purchase-template-item-code">${escapeHtml(item.code)}</span></td><td>${escapeHtml(item.name)}</td><td>${escapeHtml(item.unit || '-')}</td><td class="purchase-template-numeric">${Number(item.quantity).toLocaleString('vi-VN')}</td><td class="purchase-template-numeric">${formatCurrency(item.unitPrice)}</td><td class="purchase-template-numeric purchase-template-item-total">${formatCurrency(item.lineTotal)}</td></tr>`).join('')}
          </tbody></table>
        </div>
        <div class="purchase-summary purchase-template-summary">
          <div><span class="purchase-template-summary-label">Tổng mua</span><strong class="purchase-template-total">${formatCurrency(purchaseTotal(purchase))}</strong></div>
          <div><span class="purchase-template-summary-label">Đã thanh toán</span><strong class="purchase-template-paid">${formatCurrency(purchase.paidAmount)}</strong></div>
          <div><span class="purchase-template-summary-label">Còn phải trả</span><strong class="purchase-template-balance ${Number(purchase.balanceDue) > 0 ? 'is-due' : 'is-settled'}">${formatCurrency(purchase.balanceDue)}</strong></div>
        </div>
        ${purchase.status === 'completed' && Number(purchase.balanceDue || 0) > 0 ? `<div class="purchase-payment-box purchase-template-payment-box"><span class="purchase-template-payment-label"><i class="purchase-template-icon" data-lucide="credit-card"></i> Thanh toán nợ:</span><input type="number" class="form-control purchase-pay-amount" min="1" max="${Number(purchase.balanceDue)}" value="${Number(purchase.balanceDue)}"><select class="form-control purchase-pay-method"><option value="cash">Tiền mặt</option><option value="bank">Ngân hàng</option><option value="wallet">Ví điện tử</option></select><button class="btn btn-primary btn-sm purchase-pay-btn" data-id="${escapeHtml(purchase.id)}"><i data-lucide="plus"></i> Tạo phiếu chi</button></div>` : ''}
        ${activePayments.length ? `<div class="purchase-payment-history purchase-template-payment-history"><strong class="purchase-template-payment-history-title"><i class="purchase-template-icon" data-lucide="history"></i> Phiếu chi:</strong><div class="purchase-template-payment-list">${activePayments.map(payment => `<div class="purchase-template-payment-row"><span>${formatCurrency(payment.amount)} · ${escapeHtml(payment.paymentMethod)}</span> <button class="btn btn-danger btn-sm purchase-cancel-payment-btn" data-id="${escapeHtml(payment.id)}"><i data-lucide="rotate-ccw"></i> Hủy phiếu chi</button></div>`).join('')}</div></div>` : ''}
      </div>
    </td></tr>`;
}

function updateTotals(panel) {
  let total = 0;
  panel.querySelectorAll('.purchase-entry-item-row').forEach(row => {
    const quantity = Number(row.querySelector('.purchase-entry-qty')?.value || 0);
    const price = Number(row.querySelector('.purchase-entry-price')?.value || 0);
    const lineTotal = Math.max(0, quantity * price);
    total += lineTotal;
    const cell = row.querySelector('.purchase-entry-line-total');
    if (cell) cell.textContent = formatCurrency(lineTotal);
  });
  const paid = Math.max(0, Number(panel.querySelector('#purchase-paid-input')?.value || 0));
  panel.querySelector('#purchase-entry-total').textContent = formatCurrency(total);
  panel.querySelector('#purchase-entry-debt-total').textContent = formatCurrency(Math.max(0, total - paid));
}

function printPurchase(purchase) {
  const popup = window.open('', '_blank', 'width=900,height=700');
  if (!popup) return showToast('Trình duyệt đang chặn cửa sổ in.', 'warning');
  popup.document.write(`<!doctype html><html><head><title>${escapeHtml(purchase.code)}</title><style>body{font-family:Arial;padding:24px}table{width:100%;border-collapse:collapse}th,td{border:1px solid #222;padding:7px;text-align:left}.right{text-align:right}</style></head><body><h2>PHIẾU MUA HÀNG</h2><p>Mã: <b>${escapeHtml(purchase.code)}</b></p><p>Nhà cung cấp: <b>${escapeHtml(purchase.supplierName)}</b></p><p>Ngày mua: ${escapeHtml(purchaseDate(purchase))}</p><table><thead><tr><th>Mã</th><th>Tên</th><th>SL</th><th>Đơn giá</th><th>Thành tiền</th></tr></thead><tbody>${(purchase.items || []).map(item => `<tr><td>${escapeHtml(item.code)}</td><td>${escapeHtml(item.name)}</td><td class="right">${Number(item.quantity).toLocaleString('vi-VN')}</td><td class="right">${formatCurrency(item.unitPrice)}</td><td class="right">${formatCurrency(item.lineTotal)}</td></tr>`).join('')}</tbody></table><h3 class="right">Tổng: ${formatCurrency(purchaseTotal(purchase))}</h3><p class="right">Đã trả: ${formatCurrency(purchase.paidAmount)} · Còn phải trả: ${formatCurrency(purchase.balanceDue)}</p></body></html>`);
  popup.document.close();
  popup.focus();
  popup.print();
}

function renderPurchaseRows(purchases, activeId, { readFailed = false, supplierReadFailed = false, filtered = false } = {}) {
  if (readFailed) {
    return '<tr><td colspan="10" role="alert" class="purchase-empty">Không thể hiển thị danh sách vì lần đọc Cloud thất bại. Hãy dùng nút tải lại phía trên.</td></tr>';
  }
  if (!purchases.length) {
    if (filtered) {
      return '<tr><td colspan="10" class="purchase-empty">Không có phiếu mua phù hợp với từ khóa hoặc trạng thái đã chọn.</td></tr>';
    }
    if (supplierReadFailed) {
      return '<tr><td colspan="10" class="purchase-empty">Chưa thể xác định nhà cung cấp hiện có. Hãy tải lại danh sách nhà cung cấp trước khi tạo phiếu mua.</td></tr>';
    }
    const hasSuppliers = (state.suppliers || []).some(supplier => supplier?.isActive !== false);
    return `<tr><td colspan="10" class="purchase-empty">
      <div class="purchase-empty-state">
        <div class="purchase-empty-icon"><i data-lucide="shopping-bag"></i></div>
        <h4>Chưa có phiếu mua hàng trên database.</h4>
        <p>Ghi nhận giá trị mua và công nợ nhà cung cấp khi nhập hàng hóa, dịch vụ vào hệ thống.</p>
        ${hasSuppliers
          ? `<button type="button" class="btn btn-primary btn-sm purchase-empty-btn" id="btn-empty-create-purchase"><i data-lucide="plus"></i> Tạo phiếu mua ngay</button>`
          : `<p>Hãy thêm nhà cung cấp trước để lập phiếu mua.</p><button type="button" class="btn btn-secondary btn-sm" id="btn-empty-add-supplier"><i data-lucide="user-plus"></i> Thêm nhà cung cấp</button>`}
      </div>
    </td></tr>`;
  }
  return purchases.map(purchase => `
    <tr class="purchase-row ${String(activeId) === String(purchase.id) ? 'active' : ''}" data-id="${escapeHtml(purchase.id)}">
      <td><strong class="purchase-row-code">${escapeHtml(purchase.code)}</strong></td>
      <td>${escapeHtml(purchaseDate(purchase))}</td>
      <td>${escapeHtml(purchase.invoiceNumber || '-')}</td>
      <td><span class="purchase-row-supplier">${escapeHtml(purchase.supplierName || purchase.supplierCode || '-')}</span></td>
      <td class="purchase-template-numeric purchase-row-total">${formatCurrency(purchaseTotal(purchase))}</td>
      <td class="purchase-template-numeric purchase-row-paid">${formatCurrency(purchase.paidAmount)}</td>
      <td class="purchase-template-numeric purchase-row-balance ${Number(purchase.balanceDue) > 0 ? 'is-due' : 'is-settled'}">${formatCurrency(purchase.balanceDue)}</td>
      <td><span class="purchase-status ${escapeHtml(purchase.status)}">${statusLabel(purchase.status)}</span></td>
      <td><span class="purchase-row-creator">${escapeHtml(purchase.createdBy || '-')}</span></td>
      <td><button type="button" class="purchase-row-toggle" aria-label="Xem phiếu ${escapeHtml(purchase.code)}">Xem</button></td>
    </tr>
    ${String(activeId) === String(purchase.id) ? purchaseDetail(purchase) : ''}
  `).join('');
}

function attachRowEvents(panel) {
  panel.querySelectorAll('.purchase-row').forEach(row => row.addEventListener('click', event => {
    if (event.target.closest('input,select')) return;
    if (event.target.closest('button') && !event.target.closest('.purchase-row-toggle')) return;
    panel.dataset.activePurchaseId = panel.dataset.activePurchaseId === row.dataset.id ? '' : row.dataset.id;
    renderPurchasesPanel(panel);
  }));
  panel.querySelectorAll('.purchase-pay-btn').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation();
    const purchase = state.purchases.find(item => String(item.id) === String(button.dataset.id));
    const box = button.closest('.purchase-payment-box');
    const amount = Number(box.querySelector('.purchase-pay-amount').value || 0);
    const method = box.querySelector('.purchase-pay-method').value;
    const paymentKey = pendingSupplierPaymentKeys.get(purchase.id) || newKey(`supplier-payment:${purchase.id}`);
    pendingSupplierPaymentKeys.set(purchase.id, paymentKey);
    button.disabled = true;
    const result = await dbRecordSupplierPayment({ supplierId: purchase.supplierId, purchaseId: purchase.id, amount, paymentMethod: method, notes: `Thanh toán ${purchase.code}`, idempotencyKey: paymentKey });
    button.disabled = false;
    if (result) {
      pendingSupplierPaymentKeys.delete(purchase.id);
      showToast('Đã tạo phiếu chi và giảm công nợ nhà cung cấp.', 'success');
      renderPurchasesPanel(panel);
    }
  }));
  panel.querySelectorAll('.purchase-cancel-payment-btn').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation(); const reason = await requestPurchaseCancellationReason('Hủy phiếu chi nhà cung cấp'); if (!reason) return;
    const result = await dbCancelSupplierPayment(button.dataset.id, reason);
    if (result) { showToast('Đã hủy phiếu chi và ghi giao dịch đảo.', 'success'); renderPurchasesPanel(panel); }
  }));
  panel.querySelectorAll('.purchase-cancel-btn').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation(); const reason = await requestPurchaseCancellationReason('Hủy phiếu mua hàng'); if (!reason) return;
    const result = await dbCancelPurchase(button.dataset.id, reason);
    if (result) { showToast('Đã hủy phiếu mua và đảo công nợ/phiếu chi.', 'success'); renderPurchasesPanel(panel); }
  }));
  panel.querySelectorAll('.purchase-print-btn').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation(); const purchase = state.purchases.find(item => String(item.id) === String(button.dataset.id)); if (purchase) printPurchase(purchase);
  }));
  panel.querySelector('#btn-empty-create-purchase')?.addEventListener('click', () => {
    panel.querySelector('#btn-open-purchase-modal')?.click();
  });
  panel.querySelector('#btn-empty-add-supplier')?.addEventListener('click', () => {
    purchaseSupplierSelectionPending = true;
    document.getElementById('btn-open-add-supplier-modal')?.click();
  });
}

function attachEvents(panel) {
  attachRowEvents(panel);
  const modal = panel.querySelector('#purchase-entry-modal');
  const close = () => modal?.classList.remove('active');
  panel.querySelector('#btn-add-purchase-supplier')?.addEventListener('click', () => {
    purchaseSupplierSelectionPending = true;
    document.getElementById('btn-open-add-supplier-modal')?.click();
  });
  panel.querySelector('#btn-add-purchase-supplier-inline')?.addEventListener('click', () => {
    purchaseSupplierSelectionPending = true;
    document.getElementById('btn-open-add-supplier-modal')?.click();
  });
  panel.querySelector('#btn-open-purchase-modal')?.addEventListener('click', () => {
    const failedDomains = getCloudReadHealth().failedDomains;
    if (failedDomains.includes('purchases') || failedDomains.includes('suppliers')) {
      showToast('Chưa thể tạo phiếu mua khi dữ liệu nhà cung cấp hoặc phiếu mua chưa tải được.', 'warning');
      return;
    }
    if (!(state.suppliers || []).some(supplier => supplier?.isActive !== false)) {
      showToast('Hãy thêm nhà cung cấp trước khi lập phiếu mua.', 'warning');
      switchTab('suppliers-panel');
      document.getElementById('btn-open-add-supplier-modal')?.click();
      return;
    }
    const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    panel.querySelector('#purchase-date-input').value = date.toISOString().slice(0, 16);
    pendingPurchaseKey ||= newKey('purchase');
    updateTotals(panel); modal?.classList.add('active');
    safeCreateIcons();
  });
  panel.querySelector('#btn-close-purchase-entry')?.addEventListener('click', close);
  panel.querySelector('#btn-cancel-purchase-entry')?.addEventListener('click', close);
  panel.querySelector('#btn-download-purchase-excel-template')?.addEventListener('click', downloadPurchaseExcelTemplate);
  panel.querySelector('#btn-export-purchases-excel')?.addEventListener('click', () => exportPurchasesExcel(panel));
  panel.querySelector('#btn-open-purchase-excel-import')?.addEventListener('click', () => {
    const failedDomains = getCloudReadHealth().failedDomains;
    if (failedDomains.includes('purchases') || failedDomains.includes('suppliers')) {
      showToast('Phiếu mua hoặc nhà cung cấp chưa tải được từ Cloud; hãy tải lại trước khi nhập.', 'warning');
      return;
    }
    openPurchaseExcelModal(panel);
  });
  const excelModal = panel.querySelector('#purchase-excel-modal');
  const excelInput = panel.querySelector('#purchase-excel-file-input');
  const excelDropzone = panel.querySelector('#purchase-excel-dropzone');
  const browseExcelButton = panel.querySelector('#btn-browse-purchase-excel');
  const closeExcel = () => closePurchaseExcelModal(panel);
  panel.querySelector('#btn-close-purchase-excel')?.addEventListener('click', closeExcel);
  panel.querySelector('#btn-cancel-purchase-excel')?.addEventListener('click', closeExcel);
  panel.querySelector('#btn-save-purchase-excel')?.addEventListener('click', () => processPurchaseExcelImport(panel));
  browseExcelButton?.addEventListener('click', event => {
    event.stopPropagation();
    excelInput?.click();
  });
  excelDropzone?.addEventListener('click', event => {
    if (event.target.closest('button')) return;
    excelInput?.click();
  });
  excelInput?.addEventListener('change', event => handlePurchaseExcelFile(panel, event.target.files?.[0]));
  excelDropzone?.addEventListener('dragover', event => {
    event.preventDefault();
    excelDropzone.classList.add('dragover');
  });
  excelDropzone?.addEventListener('dragleave', () => excelDropzone.classList.remove('dragover'));
  excelDropzone?.addEventListener('drop', event => {
    event.preventDefault();
    excelDropzone.classList.remove('dragover');
    handlePurchaseExcelFile(panel, event.dataTransfer?.files?.[0]);
  });
  excelModal?.addEventListener('click', event => {
    if (event.target === excelModal) closeExcel();
  });
  excelModal?.addEventListener('keydown', event => {
    if (event.key === 'Escape') closeExcel();
  });
  panel.querySelector('#btn-add-purchase-item-row')?.addEventListener('click', () => {
    panel.querySelector('#purchase-entry-items-body').insertAdjacentHTML('beforeend', itemRow()); updateTotals(panel);
  });
  panel.querySelector('#purchase-entry-items-body')?.addEventListener('input', () => updateTotals(panel));
  panel.querySelector('#purchase-entry-items-body')?.addEventListener('change', event => {
    const row = event.target.closest('.purchase-entry-item-row');
    if (!row) return;
    const codeInput = row.querySelector('.purchase-entry-code');
    const nameInput = row.querySelector('.purchase-entry-name');
    const changedValue = String(event.target.value || '').trim().toLocaleLowerCase('vi');
    let matches = [];
    if (event.target === codeInput) {
      matches = purchaseEntrySuggestions().filter(item => item.code.toLocaleLowerCase('vi') === changedValue);
    } else if (event.target === nameInput) {
      matches = purchaseEntrySuggestions().filter(item => item.name.toLocaleLowerCase('vi') === changedValue);
    }
    if (matches.length !== 1) return;
    codeInput.value = matches[0].code;
    nameInput.value = matches[0].name;
    row.querySelector('.purchase-entry-unit').value = matches[0].unit;
  });
  panel.querySelector('#purchase-paid-input')?.addEventListener('input', () => updateTotals(panel));
  panel.querySelector('#purchase-entry-items-body')?.addEventListener('click', event => {
    const button = event.target.closest('.purchase-entry-remove-row'); if (!button) return;
    if (panel.querySelectorAll('.purchase-entry-item-row').length <= 1) return showToast('Phiếu mua phải có ít nhất một dòng.', 'warning');
    button.closest('tr').remove(); updateTotals(panel);
  });
  panel.querySelector('#purchase-entry-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const formButtons = Array.from(panel.querySelectorAll('#purchase-entry-form button'));
    formButtons.forEach(button => { button.disabled = true; });
    let result;
    try {
      const items = Array.from(panel.querySelectorAll('.purchase-entry-item-row')).map(row => ({
        code: row.querySelector('.purchase-entry-code').value.trim(),
        name: row.querySelector('.purchase-entry-name').value.trim(),
        unit: row.querySelector('.purchase-entry-unit').value.trim(),
        quantity: Number(row.querySelector('.purchase-entry-qty').value),
        unitPrice: Number(row.querySelector('.purchase-entry-price').value)
      }));
      const purchaseDate = new Date(panel.querySelector('#purchase-date-input').value);
      if (!Number.isFinite(purchaseDate.getTime())) {
        showToast('Ngày mua chưa hợp lệ. Hãy kiểm tra ngày rồi lưu lại.', 'warning');
        return;
      }
      result = await dbCreatePurchase({
        supplierId: panel.querySelector('#purchase-supplier-select').value,
        invoiceNumber: panel.querySelector('#purchase-invoice-number').value.trim(),
        purchaseDate: purchaseDate.toISOString(),
        paidAmount: Number(panel.querySelector('#purchase-paid-input').value || 0),
        paymentMethod: panel.querySelector('#purchase-payment-method').value,
        notes: panel.querySelector('#purchase-note-input').value.trim(),
        idempotencyKey: pendingPurchaseKey || newKey('purchase'), items
      });
    } catch (error) {
      console.error('Create purchase failed before a database response:', error);
      showToast('Không lưu được phiếu mua. Dữ liệu vẫn còn trên màn hình; hãy kiểm tra ngày hoặc kết nối rồi thử lại.', 'danger');
      return;
    } finally {
      formButtons.forEach(button => { button.disabled = false; });
    }
    if (!result) return;
    pendingPurchaseKey = '';
    panel.dataset.activePurchaseId = result.purchase?.id || '';
    showToast(result.already_recorded ? 'Phiếu mua đã được ghi nhận trước đó.' : 'Đã tạo phiếu mua và cập nhật công nợ.', 'success');
    renderPurchasesPanel(panel);
  });

  const updateFilteredTable = () => {
    const query = (panel.dataset.purchaseSearch || '').trim().toLowerCase();
    const activeId = panel.dataset.activePurchaseId || '';
    const purchases = state.purchases || [];
    const failedDomains = getCloudReadHealth().failedDomains;
    const purchasesReadFailed = failedDomains.includes('purchases');
    const suppliersReadFailed = failedDomains.includes('suppliers');
    const filtered = getFilteredPurchases(panel);
    const tbody = panel.querySelector('#purchases-table-body');
    if (tbody) {
      tbody.innerHTML = renderPurchaseRows(filtered, activeId, {
        readFailed: purchasesReadFailed,
        supplierReadFailed: suppliersReadFailed,
        filtered: Boolean(query || statusFilter !== 'all')
      });
      safeCreateIcons();
      attachRowEvents(panel);
    }
    const countEl = panel.querySelector('#purchase-stat-count');
    if (countEl) {
      countEl.textContent = purchasesReadFailed
        ? '—'
        : ((panel.dataset.purchaseSearch || '').trim() || (panel.dataset.purchaseStatus || 'all') !== 'all')
        ? `${filtered.length} / ${purchases.length} phiếu`
        : `${purchases.length} phiếu`;
    }
  };

  panel.querySelector('#purchase-search-input')?.addEventListener('input', event => {
    panel.dataset.purchaseSearch = event.target.value;
    updateFilteredTable();
  });

  panel.querySelector('#purchase-status-filter')?.addEventListener('change', event => {
    panel.dataset.purchaseStatus = event.target.value;
    updateFilteredTable();
  });

  panel.querySelectorAll('[data-retry-cloud-domain]').forEach(button => button.addEventListener('click', async event => {
    const retryButton = event.currentTarget;
    const domain = retryButton.dataset.retryCloudDomain;
    retryButton.disabled = true;
    await ensurePanelCloudData('goods-panel', { force: true, domains: [domain] });
  }));
}

export function renderPurchasesPanel(panel) {
  if (!panel) return;
  activePurchasePanel = panel;
  installSupplierSavedListener();
  if (!financeRole()) {
    panel.innerHTML = '<div class="empty-state">Bạn không có quyền truy cập phân hệ mua hàng.</div>';
    return;
  }
  const activeId = panel.dataset.activePurchaseId || '';
  const failedDomains = getCloudReadHealth().failedDomains;
  const purchasesReadFailed = failedDomains.includes('purchases');
  const suppliersReadFailed = failedDomains.includes('suppliers');
  const hasSuppliers = (state.suppliers || []).some(supplier => supplier?.isActive !== false);
  const purchases = state.purchases || [];
  const query = (panel.dataset.purchaseSearch || '').trim().toLowerCase();
  const statusFilter = panel.dataset.purchaseStatus || 'all';

  const totalCount = purchases.length;
  const activePurchases = purchases.filter(p => p.status !== 'cancelled');
  const totalAmount = activePurchases.reduce((sum, p) => sum + purchaseTotal(p), 0);
  const totalPaid = activePurchases.reduce((sum, p) => sum + Number(p.paidAmount || 0), 0);
  const totalDebt = activePurchases.reduce((sum, p) => sum + Number(p.balanceDue || 0), 0);

  const filteredPurchases = getFilteredPurchases(panel);

  panel.innerHTML = `
    <div class="purchase-page">
      <div class="glass-panel purchase-panel-card">
        <div class="panel-header purchase-toolbar">
          <div class="purchase-heading stitch-panel-heading">
            <h2 class="panel-title"><i data-lucide="shopping-cart"></i> Phiếu mua hàng</h2>
            <small class="panel-subtitle">Ghi nhận giá trị mua và công nợ nhà cung cấp</small>
          </div>
          <div class="purchase-actions">
            <button type="button" class="btn btn-secondary btn-sm" id="btn-download-purchase-excel-template">
              <i data-lucide="download"></i> Tải file mẫu
            </button>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-export-purchases-excel" ${purchasesReadFailed ? 'disabled title="Tải lại danh sách phiếu mua trước khi xuất."' : ''}>
              <i data-lucide="file-down"></i> Xuất Excel
            </button>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-open-purchase-excel-import" ${purchasesReadFailed || suppliersReadFailed ? 'disabled title="Tải lại dữ liệu Cloud trước khi nhập."' : ''}>
              <i data-lucide="file-up"></i> Nhập Excel
            </button>
            <button type="button" class="btn btn-secondary btn-sm" id="btn-add-purchase-supplier" ${suppliersReadFailed ? 'disabled title="Tải lại danh sách nhà cung cấp trước."' : ''}>
              <i data-lucide="user-plus"></i> Thêm nhà cung cấp
            </button>
            <button class="purchase-primary-btn btn btn-primary" id="btn-open-purchase-modal" ${purchasesReadFailed || suppliersReadFailed || !hasSuppliers ? 'disabled' : ''}>
              <i data-lucide="plus"></i> Tạo phiếu mua
            </button>
          </div>
        </div>

        ${(purchasesReadFailed || suppliersReadFailed) ? `<div class="purchase-cloud-read-error" role="alert">
          <span>Không tải được ${[purchasesReadFailed ? 'danh sách phiếu mua' : '', suppliersReadFailed ? 'nhà cung cấp' : ''].filter(Boolean).join(' và ')} từ Cloud. Dữ liệu hiện có thể chưa cập nhật.</span>
          ${purchasesReadFailed ? '<button type="button" class="btn btn-secondary btn-sm" data-retry-cloud-domain="purchases">Tải lại phiếu mua</button>' : ''}
          ${suppliersReadFailed ? '<button type="button" class="btn btn-secondary btn-sm" data-retry-cloud-domain="suppliers">Tải lại nhà cung cấp</button>' : ''}
        </div>` : (!hasSuppliers ? '<div class="purchase-cloud-read-error" role="status">Workspace chưa có nhà cung cấp. Hãy thêm nhà cung cấp trước khi tạo phiếu mua.</div>' : '')}

        <div class="purchase-summary-bar">
          <div class="purchase-summary-item">
            <span class="purchase-summary-label">Tổng số phiếu</span>
            <strong id="purchase-stat-count">${purchasesReadFailed ? '—' : `${totalCount} phiếu`}</strong>
          </div>
          <div class="purchase-summary-item total-amount">
            <span class="purchase-summary-label">Tổng tiền mua</span>
            <strong>${purchasesReadFailed ? '—' : formatCurrency(totalAmount)}</strong>
          </div>
          <div class="purchase-summary-item total-paid">
            <span class="purchase-summary-label">Đã thanh toán</span>
            <strong>${purchasesReadFailed ? '—' : formatCurrency(totalPaid)}</strong>
          </div>
          <div class="purchase-summary-item total-debt">
            <span class="purchase-summary-label">Còn nợ NCC</span>
            <strong>${purchasesReadFailed ? '—' : formatCurrency(totalDebt)}</strong>
          </div>
        </div>

        <div class="controls-row">
          <div class="search-wrapper">
            <i data-lucide="search" class="search-icon"></i>
            <input type="text" class="form-control-search" id="purchase-search-input" placeholder="Tìm kiếm theo mã phiếu, số hóa đơn, nhà cung cấp..." value="${escapeHtml(panel.dataset.purchaseSearch || '')}">
          </div>
          <div class="purchase-status-filter-wrap">
            <select class="form-control purchase-status-filter" id="purchase-status-filter">
              <option value="all" ${statusFilter === 'all' ? 'selected' : ''}>Tất cả trạng thái</option>
              <option value="completed" ${statusFilter === 'completed' ? 'selected' : ''}>Hoàn thành</option>
              <option value="draft" ${statusFilter === 'draft' ? 'selected' : ''}>Phiếu tạm</option>
              <option value="cancelled" ${statusFilter === 'cancelled' ? 'selected' : ''}>Đã hủy</option>
            </select>
          </div>
        </div>

        <div class="purchase-table-wrap table-responsive">
          <table class="purchase-table table">
            <thead>
              <tr>
                <th>Mã phiếu</th>
                <th>Ngày mua</th>
                <th>Số hóa đơn</th>
                <th>Nhà cung cấp</th>
                <th class="purchase-template-numeric">Tổng tiền</th>
                <th class="purchase-template-numeric">Đã thanh toán</th>
                <th class="purchase-template-numeric">Còn nợ</th>
                <th>Trạng thái</th>
                <th>Người tạo</th>
                <th>Thao tác</th>
              </tr>
            </thead>
            <tbody id="purchases-table-body">
              ${purchasesReadFailed
                ? '<tr><td colspan="10" role="alert" class="purchase-empty">Không thể hiển thị danh sách vì lần đọc Cloud thất bại. Hãy dùng nút tải lại phía trên.</td></tr>'
                : renderPurchaseRows(filteredPurchases, activeId, {
                  supplierReadFailed: suppliersReadFailed,
                  filtered: Boolean(query || statusFilter !== 'all')
                })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    ${purchaseModal()}
    ${purchaseExcelImportModal()}`;
  attachEvents(panel);
  safeCreateIcons();
}
