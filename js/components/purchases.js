import { state } from '../state.js';
import { formatCurrency, formatDateTime, safeCreateIcons, showToast } from '../utils.js';
import {
  dbCancelPurchase,
  dbCancelSupplierPayment,
  dbCreatePurchase,
  dbRecordSupplierPayment
} from '../services/supabase.js';

let pendingPurchaseKey = '';
const pendingSupplierPaymentKeys = new Map();

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

function itemRow(item = {}) {
  return `
    <tr class="purchase-entry-item-row">
      <td><input type="text" class="purchase-entry-code" value="${escapeHtml(item.code || '')}" required placeholder="Mã hàng/dịch vụ"></td>
      <td><input type="text" class="purchase-entry-name" value="${escapeHtml(item.name || '')}" required placeholder="Tên hàng hóa/dịch vụ"></td>
      <td><input type="text" class="purchase-entry-unit" value="${escapeHtml(item.unit || '')}" placeholder="ĐVT"></td>
      <td><input type="number" class="purchase-entry-qty" min="0.0001" step="any" value="${item.quantity || 1}" required></td>
      <td><input type="number" class="purchase-entry-price" min="0" step="1" value="${item.unitPrice || 0}" required></td>
      <td class="purchase-entry-line-total">0 ₫</td>
      <td><button type="button" class="purchase-entry-remove-row" title="Xóa dòng">×</button></td>
    </tr>`;
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
              <select class="form-control" id="purchase-supplier-select" required>
                <option value="">-- Chọn nhà cung cấp --</option>
                ${state.suppliers.map(supplier => `<option value="${escapeHtml(supplier.id)}">${escapeHtml(supplier.name)} (${escapeHtml(supplier.code)})</option>`).join('')}
              </select>
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
              <div class="purchase-entry-total"><span>Tổng dự kiến</span><strong id="purchase-entry-total">0 ₫</strong></div>
              <div class="purchase-entry-total"><span>Còn phải trả dự kiến</span><strong id="purchase-entry-debt-total">0 ₫</strong></div>
              <small>Database sẽ tự tính lại toàn bộ thành tiền và công nợ.</small>
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

function renderPurchaseRows(purchases, activeId) {
  if (!purchases.length) {
    return `<tr><td colspan="10" class="purchase-empty">
      <div class="purchase-empty-state">
        <div class="purchase-empty-icon"><i data-lucide="shopping-bag"></i></div>
        <h4>Chưa có phiếu mua hàng trên database.</h4>
        <p>Ghi nhận giá trị mua và công nợ nhà cung cấp khi nhập hàng hóa, dịch vụ vào hệ thống.</p>
        <button type="button" class="btn btn-primary btn-sm purchase-empty-btn" id="btn-empty-create-purchase">
          <i data-lucide="plus"></i> Tạo phiếu mua ngay
        </button>
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
    event.stopPropagation(); const reason = prompt('Nhập lý do hủy phiếu chi:'); if (!reason?.trim()) return;
    const result = await dbCancelSupplierPayment(button.dataset.id, reason.trim());
    if (result) { showToast('Đã hủy phiếu chi và ghi giao dịch đảo.', 'success'); renderPurchasesPanel(panel); }
  }));
  panel.querySelectorAll('.purchase-cancel-btn').forEach(button => button.addEventListener('click', async event => {
    event.stopPropagation(); const reason = prompt('Nhập lý do hủy phiếu mua:'); if (!reason?.trim()) return;
    const result = await dbCancelPurchase(button.dataset.id, reason.trim());
    if (result) { showToast('Đã hủy phiếu mua và đảo công nợ/phiếu chi.', 'success'); renderPurchasesPanel(panel); }
  }));
  panel.querySelectorAll('.purchase-print-btn').forEach(button => button.addEventListener('click', event => {
    event.stopPropagation(); const purchase = state.purchases.find(item => String(item.id) === String(button.dataset.id)); if (purchase) printPurchase(purchase);
  }));
  panel.querySelector('#btn-empty-create-purchase')?.addEventListener('click', () => {
    panel.querySelector('#btn-open-purchase-modal')?.click();
  });
}

function attachEvents(panel) {
  attachRowEvents(panel);
  const modal = panel.querySelector('#purchase-entry-modal');
  const close = () => modal?.classList.remove('active');
  panel.querySelector('#btn-open-purchase-modal')?.addEventListener('click', () => {
    const date = new Date(); date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
    panel.querySelector('#purchase-date-input').value = date.toISOString().slice(0, 16);
    pendingPurchaseKey ||= newKey('purchase');
    updateTotals(panel); modal?.classList.add('active');
    safeCreateIcons();
  });
  panel.querySelector('#btn-close-purchase-entry')?.addEventListener('click', close);
  panel.querySelector('#btn-cancel-purchase-entry')?.addEventListener('click', close);
  panel.querySelector('#btn-add-purchase-item-row')?.addEventListener('click', () => {
    panel.querySelector('#purchase-entry-items-body').insertAdjacentHTML('beforeend', itemRow()); updateTotals(panel);
  });
  panel.querySelector('#purchase-entry-items-body')?.addEventListener('input', () => updateTotals(panel));
  panel.querySelector('#purchase-paid-input')?.addEventListener('input', () => updateTotals(panel));
  panel.querySelector('#purchase-entry-items-body')?.addEventListener('click', event => {
    const button = event.target.closest('.purchase-entry-remove-row'); if (!button) return;
    if (panel.querySelectorAll('.purchase-entry-item-row').length <= 1) return showToast('Phiếu mua phải có ít nhất một dòng.', 'warning');
    button.closest('tr').remove(); updateTotals(panel);
  });
  panel.querySelector('#purchase-entry-form')?.addEventListener('submit', async event => {
    event.preventDefault();
    const items = Array.from(panel.querySelectorAll('.purchase-entry-item-row')).map(row => ({
      code: row.querySelector('.purchase-entry-code').value.trim(),
      name: row.querySelector('.purchase-entry-name').value.trim(),
      unit: row.querySelector('.purchase-entry-unit').value.trim(),
      quantity: Number(row.querySelector('.purchase-entry-qty').value),
      unitPrice: Number(row.querySelector('.purchase-entry-price').value)
    }));
    const submit = event.submitter; if (submit) submit.disabled = true;
    const result = await dbCreatePurchase({
      supplierId: panel.querySelector('#purchase-supplier-select').value,
      invoiceNumber: panel.querySelector('#purchase-invoice-number').value.trim(),
      purchaseDate: new Date(panel.querySelector('#purchase-date-input').value).toISOString(),
      paidAmount: Number(panel.querySelector('#purchase-paid-input').value || 0),
      paymentMethod: panel.querySelector('#purchase-payment-method').value,
      notes: panel.querySelector('#purchase-note-input').value.trim(),
      idempotencyKey: pendingPurchaseKey || newKey('purchase'), items
    });
    if (submit) submit.disabled = false;
    if (!result) return;
    pendingPurchaseKey = '';
    panel.dataset.activePurchaseId = result.purchase?.id || '';
    showToast(result.already_recorded ? 'Phiếu mua đã được ghi nhận trước đó.' : 'Đã tạo phiếu mua và cập nhật công nợ.', 'success');
    renderPurchasesPanel(panel);
  });

  const updateFilteredTable = () => {
    const query = (panel.dataset.purchaseSearch || '').trim().toLowerCase();
    const statusFilter = panel.dataset.purchaseStatus || 'all';
    const activeId = panel.dataset.activePurchaseId || '';
    const purchases = state.purchases || [];
    const filtered = purchases.filter(p => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (query) {
        const haystack = `${p.code || ''} ${p.invoiceNumber || ''} ${p.supplierName || ''} ${p.supplierCode || ''} ${p.createdBy || ''}`.toLowerCase();
        if (!haystack.includes(query)) return false;
      }
      return true;
    });
    const tbody = panel.querySelector('#purchases-table-body');
    if (tbody) {
      tbody.innerHTML = renderPurchaseRows(filtered, activeId);
      safeCreateIcons();
      attachRowEvents(panel);
    }
    const countEl = panel.querySelector('#purchase-stat-count');
    if (countEl) {
      countEl.textContent = (query || statusFilter !== 'all')
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
}

export function renderPurchasesPanel(panel) {
  if (!panel) return;
  if (!financeRole()) {
    panel.innerHTML = '<div class="empty-state">Bạn không có quyền truy cập phân hệ mua hàng.</div>';
    return;
  }
  const activeId = panel.dataset.activePurchaseId || '';
  const purchases = state.purchases || [];
  const query = (panel.dataset.purchaseSearch || '').trim().toLowerCase();
  const statusFilter = panel.dataset.purchaseStatus || 'all';

  const totalCount = purchases.length;
  const activePurchases = purchases.filter(p => p.status !== 'cancelled');
  const totalAmount = activePurchases.reduce((sum, p) => sum + purchaseTotal(p), 0);
  const totalPaid = activePurchases.reduce((sum, p) => sum + Number(p.paidAmount || 0), 0);
  const totalDebt = activePurchases.reduce((sum, p) => sum + Number(p.balanceDue || 0), 0);

  const filteredPurchases = purchases.filter(p => {
    if (statusFilter !== 'all' && p.status !== statusFilter) return false;
    if (query) {
      const haystack = `${p.code || ''} ${p.invoiceNumber || ''} ${p.supplierName || ''} ${p.supplierCode || ''} ${p.createdBy || ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  panel.innerHTML = `
    <div class="purchase-page">
      <div class="glass-panel purchase-panel-card">
        <div class="panel-header purchase-toolbar">
          <div class="purchase-heading stitch-panel-heading">
            <h2 class="panel-title"><i data-lucide="shopping-cart"></i> Phiếu mua hàng</h2>
            <small class="panel-subtitle">Ghi nhận giá trị mua và công nợ nhà cung cấp</small>
          </div>
          <div class="purchase-actions">
            <button class="purchase-primary-btn btn btn-primary" id="btn-open-purchase-modal">
              <i data-lucide="plus"></i> Tạo phiếu mua
            </button>
          </div>
        </div>

        <div class="purchase-summary-bar">
          <div class="purchase-summary-item">
            <span class="purchase-summary-label">Tổng số phiếu</span>
            <strong id="purchase-stat-count">${totalCount} phiếu</strong>
          </div>
          <div class="purchase-summary-item total-amount">
            <span class="purchase-summary-label">Tổng tiền mua</span>
            <strong>${formatCurrency(totalAmount)}</strong>
          </div>
          <div class="purchase-summary-item total-paid">
            <span class="purchase-summary-label">Đã thanh toán</span>
            <strong>${formatCurrency(totalPaid)}</strong>
          </div>
          <div class="purchase-summary-item total-debt">
            <span class="purchase-summary-label">Còn nợ NCC</span>
            <strong>${formatCurrency(totalDebt)}</strong>
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
              ${renderPurchaseRows(filteredPurchases, activeId)}
            </tbody>
          </table>
        </div>
      </div>
    </div>
    ${purchaseModal()}`;
  attachEvents(panel);
  safeCreateIcons();
}
