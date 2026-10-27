import { state } from '../state.js';
import { showToast, formatCurrency, safeCreateIcons, formatPhoneNumber } from '../utils.js';
import { dbSaveSupplier, dbDeleteSupplier, getCloudReadHealth } from '../services/supabase.js';
import { ensurePanelCloudData, renderAll } from '../main.js';
import { tenantStorage } from '../services/tenant-storage.js';
import { filterSuppliersForExport, parseSupplierRows, suggestNextSupplierCode } from '../domain/supplier-excel.js';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

function getXLSX() {
  const library = globalThis.XLSX;
  if (!library?.utils || !library.writeFile) {
    showToast('Không tải được thư viện Excel. Hãy tải lại trang rồi thử lại.', 'danger');
    return null;
  }
  return library;
}

function getKnownSuppliers() {
  return [...(state.supplierDirectory || []), ...(state.suppliers || [])];
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  const normalized = typeof value === 'string' ? value.replace(/[^\d.-]/g, '') : value;
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

function getStoredArray(key) {
  try {
    const raw = tenantStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    return [];
  }
}

function isValidDoc(doc) {
  const status = String(doc?.status || doc?.state || 'completed').toLowerCase();
  return !['draft', 'nhap', 'cancelled', 'canceled', 'void', 'deleted', 'đã hủy', 'da huy'].includes(status) &&
    !doc.deletedAt && !doc.deleted_at && !doc.isDeleted;
}

function isPaidCashbookTx(tx) {
  const status = String(tx.status || 'Đã thanh toán').toLowerCase();
  return (status === 'completed' || status === 'paid' || status.includes('thanh')) &&
    !status.includes('hủy') &&
    !status.includes('huy') &&
    !status.includes('cancel');
}

function getDocSupplierId(doc) {
  return doc?.supplierId || doc?.supplier_id || doc?.vendorId || doc?.vendor_id || null;
}

function getDocId(doc) {
  return doc?.id || doc?.code || doc?.receiptId || doc?.purchaseId || '';
}

function getDocTotal(doc) {
  const explicit = doc?.totalPayable ?? doc?.total_payable ?? doc?.grandTotal ?? doc?.grand_total ?? doc?.totalAmount ?? doc?.total_amount ?? doc?.total;
  if (explicit !== undefined && explicit !== null && explicit !== '') return toNumber(explicit);
  const items = Array.isArray(doc?.items) ? doc.items : [];
  const subtotal = items.reduce((sum, item) => {
    const qty = toNumber(item.quantity ?? item.qty);
    const price = toNumber(item.price ?? item.unitPrice ?? item.importPrice ?? item.import_price);
    const discountPercent = toNumber(item.discountPercent ?? item.discount_percent);
    return sum + Math.max(0, qty * price * (1 - discountPercent / 100));
  }, 0);
  const discount = toNumber(doc?.discountAmount ?? doc?.discount_amount);
  return Math.max(0, subtotal - discount);
}

function getSupplierPurchaseDocs() {
  return [
    ...getStoredArray('billing_system_purchase_orders'),
    ...getStoredArray('billing_system_purchases'),
    ...getStoredArray('billing_system_purchase_receipts'),
    ...getStoredArray('billing_system_goods_receipts'),
    ...getStoredArray('billing_system_supplier_imports')
  ].filter(isValidDoc);
}

function getSupplierReturnDocs() {
  return [
    ...getStoredArray('billing_system_supplier_returns'),
    ...getStoredArray('billing_system_purchase_returns'),
    ...getStoredArray('billing_system_goods_return_to_suppliers')
  ].filter(isValidDoc);
}

function getCashbookDocs() {
  return getStoredArray('billing_system_cashbook_transactions');
}

function cashbookTxMatchesSupplier(tx, supplier, purchaseIds) {
  const supplierId = String(supplier.id);
  if (String(tx.supplierId || tx.supplier_id || '') === supplierId) return true;
  if (tx.purchaseId && purchaseIds.has(String(tx.purchaseId))) return true;
  if (tx.orderId && purchaseIds.has(String(tx.orderId))) return true;
  return false;
}

function calculateSupplierMetrics(supplier) {
  return {
    totalPurchase: toNumber(supplier.totalPurchase),
    payableDebt: toNumber(supplier.debt)
  };
  /* Legacy local calculations are intentionally unreachable. Supplier totals
     now come only from the database transaction aggregates. */
  const supplierId = String(supplier.id);
  const purchases = getSupplierPurchaseDocs().filter(doc => String(getDocSupplierId(doc)) === supplierId);
  const purchaseIds = new Set(purchases.map(getDocId).filter(Boolean).map(String));
  const totalPurchaseGross = purchases.reduce((sum, doc) => sum + getDocTotal(doc), 0);
  const totalReturns = getSupplierReturnDocs()
    .filter(doc => String(getDocSupplierId(doc)) === supplierId || (doc.purchaseId && purchaseIds.has(String(doc.purchaseId))))
    .reduce((sum, doc) => sum + getDocTotal(doc), 0);
  const totalPurchase = Math.max(0, totalPurchaseGross - totalReturns);

  const paid = getCashbookDocs()
    .filter(tx => {
      if (tx.type !== 'chi' || !isPaidCashbookTx(tx)) return false;
      return cashbookTxMatchesSupplier(tx, supplier, purchaseIds);
    })
    .reduce((sum, tx) => sum + toNumber(tx.value), 0);

  return {
    totalPurchase,
    payableDebt: Math.max(0, toNumber(supplier.debt) + totalPurchase - paid)
  };
}

export function renderSuppliersTable() {
  const tableBody = document.getElementById('suppliers-table-body');
  if (!tableBody) return;

  if (getCloudReadHealth().failedDomains.includes('suppliers')) {
    const addButton = document.getElementById('btn-open-add-supplier-modal');
    const importButton = document.getElementById('btn-open-supplier-excel-modal');
    const exportButton = document.getElementById('btn-export-suppliers-excel');
    for (const button of [addButton, importButton, exportButton]) {
      if (!button) continue;
      button.disabled = true;
      button.title = 'Tải lại danh sách nhà cung cấp từ Cloud trước khi tiếp tục.';
    }
    tableBody.innerHTML = `
      <tr><td colspan="6" role="alert" class="text-center py-4">
        Không tải được danh sách nhà cung cấp từ Cloud. Dữ liệu có thể đang cũ.
        <button type="button" class="btn btn-secondary btn-sm" id="btn-retry-suppliers-load">Thử tải lại</button>
      </td></tr>`;
    document.getElementById('btn-retry-suppliers-load')?.addEventListener('click', async event => {
      event.currentTarget.disabled = true;
      await ensurePanelCloudData('suppliers-panel', { force: true });
    });
    return;
  }
  const addButton = document.getElementById('btn-open-add-supplier-modal');
  for (const button of [addButton, document.getElementById('btn-open-supplier-excel-modal'), document.getElementById('btn-export-suppliers-excel')]) {
    if (!button) continue;
    button.disabled = false;
    button.removeAttribute('title');
  }
  
  console.log("[SUPPLIERS] RENDER INPUT:", state.suppliers?.length || 0);

  const searchInput = document.getElementById('supplier-search-input');
  const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
  
  const filtered = filterSuppliersForExport(state.suppliers, searchVal);
  
  const ITEMS_PER_PAGE = 20;
  const totalItems = filtered.length;
  const totalPages = Math.ceil(totalItems / ITEMS_PER_PAGE) || 1;
  
  if (state.suppliersPage > totalPages) state.suppliersPage = totalPages;
  if (state.suppliersPage < 1) state.suppliersPage = 1;
  
  const startIndex = (state.suppliersPage - 1) * ITEMS_PER_PAGE;
  const paginatedSuppliers = filtered.slice(startIndex, startIndex + ITEMS_PER_PAGE);
  
  // Vẽ các nút phân trang
  const paginationContainer = document.getElementById('suppliers-pagination');
  if (paginationContainer) {
    paginationContainer.innerHTML = `
      <div class="pagination-controls" style="display: flex; justify-content: center; align-items: center; gap: 1rem; margin-top: 1.5rem; padding-top: 1rem; border-top: 1px solid var(--border-color); width: 100%;">
        <button class="btn btn-secondary btn-sm" id="suppliers-prev-page" ${state.suppliersPage === 1 ? 'disabled' : ''}>
          <i data-lucide="chevron-left" style="width: 16px; height: 16px;"></i> Trước
        </button>
        <span style="font-size: 0.9rem; color: var(--text-secondary); font-weight: 500;">
          Trang <strong>${state.suppliersPage}</strong> / ${totalPages} (${totalItems} nhà cung cấp)
        </span>
        <button class="btn btn-secondary btn-sm" id="suppliers-next-page" ${state.suppliersPage === totalPages ? 'disabled' : ''}>
          Sau <i data-lucide="chevron-right" style="width: 16px; height: 16px;"></i>
        </button>
      </div>
    `;

    const prevPageBtn = document.getElementById('suppliers-prev-page');
    if (prevPageBtn) {
      prevPageBtn.addEventListener('click', () => {
        state.suppliersPage--;
        renderSuppliersTable();
        document.getElementById('suppliers-panel').scrollIntoView({ behavior: 'smooth' });
      });
    }

    const nextPageBtn = document.getElementById('suppliers-next-page');
    if (nextPageBtn) {
      nextPageBtn.addEventListener('click', () => {
        state.suppliersPage++;
        renderSuppliersTable();
        document.getElementById('suppliers-panel').scrollIntoView({ behavior: 'smooth' });
      });
    }
  }

  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="6" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          ${searchVal ? 'Không tìm thấy nhà cung cấp nào phù hợp.' : 'Chưa có nhà cung cấp trong workspace này.'}
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = paginatedSuppliers.map((s) => {
    const actualIndex = state.suppliers.findIndex(supp => supp.id === s.id);
    const metrics = calculateSupplierMetrics(s);
    
    return `
      <tr>
        <td style="font-weight: 600; color: #fff;">${s.code}</td>
        <td style="font-weight: bold; color: #22c55e;">${s.name}</td>
        <td>${s.phone || '<span style="color: var(--text-muted);">N/A</span>'}</td>
        <td style="text-align: right; font-weight: 700; color: ${metrics.payableDebt > 0 ? 'var(--color-danger)' : 'var(--color-success)'};">${formatCurrency(metrics.payableDebt)}</td>
        <td style="text-align: right; font-weight: 700; color: var(--color-primary);">${formatCurrency(metrics.totalPurchase)}</td>
        <td style="text-align: center;">
          <div class="actions-cell" style="justify-content: center; gap: 0.35rem;">
            <button class="btn btn-secondary btn-sm btn-circle edit-supplier-btn" data-index="${actualIndex}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-supplier-btn" data-index="${actualIndex}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  // Gán sự kiện click cho các nút hành động
  document.querySelectorAll('.edit-supplier-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      openEditSupplierModal(idx);
    });
  });

  document.querySelectorAll('.delete-supplier-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.getAttribute('data-index'));
      handleDeleteSupplier(idx);
    });
  });

  safeCreateIcons();
}

export function populateSupplierDatalist() {
  const datalist = document.getElementById('payment-recipient-list');
  if (!datalist) return;

  datalist.innerHTML = state.suppliers.map(s => {
    return `<option value="${s.name} — ${s.code}" data-supplier-id="${s.id}">${s.phone || 'N/A'}</option>`;
  }).join('');
}

export function setupSupplierManagement() {
  const btnOpenAdd = document.getElementById('btn-open-add-supplier-modal');
  const modal = document.getElementById('supplier-modal');
  const form = document.getElementById('supplier-form');
  const btnClose = document.getElementById('btn-close-supplier-modal');
  const btnCancel = document.getElementById('btn-cancel-supplier-modal');
  const searchInput = document.getElementById('supplier-search-input');

  if (btnOpenAdd && modal) {
    btnOpenAdd.addEventListener('click', () => {
      document.getElementById('supplier-modal-title').innerText = 'Thêm nhà cung cấp';
      form.reset();
      document.getElementById('supplier-id').value = '';
      document.getElementById('supplier-debt').disabled = false;
      
      // Auto-generate code if empty
      document.getElementById('supplier-code').value = suggestNextSupplierCode(getKnownSuppliers());
      
      modal.classList.add('active');
    });
  }

  const closeModal = () => {
    if (modal) modal.classList.remove('active');
  };

  if (btnClose) btnClose.addEventListener('click', closeModal);
  if (btnCancel) btnCancel.addEventListener('click', closeModal);

  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      
      const id = document.getElementById('supplier-id').value;
      const code = document.getElementById('supplier-code').value.trim().toUpperCase();
      const name = document.getElementById('supplier-name').value.trim();
      const phone = document.getElementById('supplier-phone').value.trim();
      const address = document.getElementById('supplier-address').value.trim();
      const debt = Number(document.getElementById('supplier-debt').value || 0);
      const notes = document.getElementById('supplier-notes').value.trim();

      if (!code || !name) {
        showToast('Vui lòng nhập mã và tên nhà cung cấp.', 'warning');
        return;
      }
      if (!Number.isFinite(debt) || debt < 0) {
        showToast('Công nợ ban đầu phải là số không âm.', 'warning');
        return;
      }

      const sameCode = getKnownSuppliers().find(s => String(s.code || '').trim().toUpperCase() === code && String(s.id) !== String(id));
      if (sameCode && sameCode.isActive !== false) {
        showToast('Mã nhà cung cấp đã tồn tại!', 'danger');
        return;
      }

      const wasInactive = Boolean(sameCode && sameCode.isActive === false && !id);

      const supplierData = {
        id: id || sameCode?.id || null,
        code,
        name,
        phone,
        address,
        openingDebt: debt,
        notes
      };

      const saved = await dbSaveSupplier(supplierData);
      if (!saved) return;
      closeModal();
      renderSuppliersTable();
      populateSupplierDatalist();
      showToast(id ? 'Cập nhật nhà cung cấp thành công!' : wasInactive ? 'Đã kích hoạt lại nhà cung cấp!' : 'Thêm nhà cung cấp thành công!');
    });
  }

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      state.suppliersPage = 1;
      renderSuppliersTable();
    });
  }

  // Khởi tạo datalist cho phiếu chi ban đầu
  populateSupplierDatalist();

  // Excel Import for Suppliers
  const openImportBtn = document.getElementById('btn-open-supplier-excel-modal');
  if (openImportBtn) openImportBtn.onclick = openSupplierExcelModal;
  
  const closeImportBtn = document.getElementById('btn-close-supplier-excel-modal');
  if (closeImportBtn) closeImportBtn.onclick = closeSupplierExcelModal;
  
  const cancelImportBtn = document.getElementById('btn-cancel-supplier-excel');
  if (cancelImportBtn) cancelImportBtn.onclick = closeSupplierExcelModal;
  
  const fileInput = document.getElementById('supplier-excel-file-input');
  const browseBtn = document.getElementById('btn-browse-supplier-excel');
  const dropzone = document.getElementById('supplier-excel-dropzone');
  
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
      if (e.target === browseBtn || browseBtn?.contains(e.target) || e.target === fileInput) {
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
        handleSupplierExcelFile(e.target.files[0]);
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
        handleSupplierExcelFile(e.dataTransfer.files[0]);
      }
    };
  }
  
  const submitImportBtn = document.getElementById('btn-save-supplier-excel-submit');
  if (submitImportBtn) {
    submitImportBtn.onclick = processSupplierExcelImport;
  }
  
  const downloadTemplateBtn = document.getElementById('btn-download-supplier-excel-template');
  if (downloadTemplateBtn) {
    downloadTemplateBtn.addEventListener('click', downloadSupplierExcelTemplate);
  }
  const exportBtn = document.getElementById('btn-export-suppliers-excel');
  if (exportBtn) exportBtn.addEventListener('click', exportSuppliersExcel);
}

function openEditSupplierModal(idx) {
  const s = state.suppliers[idx];
  if (!s) return;

  const modal = document.getElementById('supplier-modal');
  if (!modal) return;

  document.getElementById('supplier-modal-title').innerText = 'Sửa nhà cung cấp';
  document.getElementById('supplier-id').value = s.id;
  document.getElementById('supplier-code').value = s.code;
  document.getElementById('supplier-name').value = s.name;
  document.getElementById('supplier-phone').value = s.phone || '';
  document.getElementById('supplier-address').value = s.address || '';
  document.getElementById('supplier-debt').value = s.debt || 0;
  document.getElementById('supplier-debt').disabled = true;
  document.getElementById('supplier-notes').value = s.notes || '';

  modal.classList.add('active');
}

async function handleDeleteSupplier(idx) {
  const s = state.suppliers[idx];
  if (!s) return;

  if (!confirm(`Ngừng sử dụng nhà cung cấp "${s.name}"? Dữ liệu cũ sẽ được giữ nguyên.`)) return;
  const deactivated = await dbDeleteSupplier(s.id, 'Ngừng sử dụng từ danh sách nhà cung cấp');
  if (!deactivated) return;
  showToast('Đã ngừng sử dụng nhà cung cấp.', 'warning');
  renderSuppliersTable();
  populateSupplierDatalist();
  return;

  if (confirm(`Bạn có chắc chắn muốn xóa nhà cung cấp "${s.name}"?`)) {
    state.suppliers.splice(idx, 1);
    tenantStorage.setItem('billing_system_suppliers', JSON.stringify(state.suppliers));
    dbDeleteSupplier(s.id);
    showToast('Đã xóa nhà cung cấp thành công!', 'warning');
    
    renderSuppliersTable();
    populateSupplierDatalist();
  }
}

// --- Excel Import & Template Helpers for Suppliers ---
let supplierExcelImportData = [];
let isSelectingFile = false;

export function downloadSupplierExcelTemplate() {
  const XLSX = getXLSX();
  if (!XLSX) return;
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([['Mã nhà cung cấp', 'Tên nhà cung cấp', 'Điện thoại', 'Địa chỉ', 'Ghi chú']]);
  ws['!cols'] = [{ wch: 22 }, { wch: 40 }, { wch: 18 }, { wch: 45 }, { wch: 35 }];
  ws['!autofilter'] = { ref: 'A1:E1' };
  XLSX.utils.book_append_sheet(wb, ws, 'Danh Sach Nha Cung Cap');
  XLSX.writeFile(wb, 'Mau_Danh_Sach_Nha_Cung_Cap.xlsx');
  showToast("Đã tải xuống file Excel mẫu nhà cung cấp thành công!");
}

export function exportSuppliersExcel() {
  if (getCloudReadHealth().failedDomains.includes('suppliers')) {
    showToast('Danh sách nhà cung cấp chưa tải được từ Cloud; hãy tải lại trước khi xuất.', 'danger');
    return;
  }
  const XLSX = getXLSX();
  if (!XLSX) return;
  const searchVal = document.getElementById('supplier-search-input')?.value || '';
  const suppliers = filterSuppliersForExport(state.suppliers, searchVal);
  if (!suppliers.length) {
    showToast('Không có nhà cung cấp nào để xuất.', 'warning');
    return;
  }
  const headers = ['Mã nhà cung cấp', 'Tên nhà cung cấp', 'Điện thoại', 'Địa chỉ', 'Công nợ đầu kỳ (đ)', 'Nợ cần trả hiện tại (đ)', 'Tổng mua (đ)', 'Ghi chú'];
  const rows = suppliers.map(supplier => {
    const metrics = calculateSupplierMetrics(supplier);
    return [supplier.code || '', supplier.name || '', supplier.phone || '', supplier.address || '', toNumber(supplier.openingDebt), metrics.payableDebt, metrics.totalPurchase, supplier.notes || ''];
  });
  const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  worksheet['!cols'] = [{ wch: 22 }, { wch: 40 }, { wch: 18 }, { wch: 45 }, { wch: 22 }, { wch: 24 }, { wch: 18 }, { wch: 40 }];
  worksheet['!autofilter'] = { ref: `A1:H${rows.length + 1}` };
  for (let rowIndex = 2; rowIndex <= rows.length + 1; rowIndex += 1) {
    for (const column of ['E', 'F', 'G']) {
      const cell = worksheet[`${column}${rowIndex}`];
      if (cell) cell.z = '#,##0';
    }
  }
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'Danh Sach Nha Cung Cap');
  const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '');
  XLSX.writeFile(workbook, `DanhSachNhaCungCap_${stamp}.xlsx`);
  showToast(`Đã xuất ${rows.length} nhà cung cấp theo bộ lọc hiện tại.`);
}

export function openSupplierExcelModal() {
  const modal = document.getElementById('supplier-excel-modal');
  if (modal) {
    modal.classList.add('active');
    
    // Reset UI
    supplierExcelImportData = [];
    document.getElementById('supplier-excel-file-input').value = '';
    document.getElementById('supplier-excel-preview-container').style.display = 'none';
    const submitBtn = document.getElementById('btn-save-supplier-excel-submit');
    if (submitBtn) {
      submitBtn.setAttribute('disabled', 'true');
      submitBtn.disabled = true;
    }
    const dropzone = document.getElementById('supplier-excel-dropzone');
    if (dropzone) dropzone.className = 'upload-dropzone';
  }
}

export function closeSupplierExcelModal() {
  const modal = document.getElementById('supplier-excel-modal');
  if (modal) modal.classList.remove('active');
}

function handleSupplierExcelFile(file) {
  if (!file) return;
  supplierExcelImportData = [];
  const XLSX = getXLSX();
  if (!XLSX) return;
  
  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array', cellDates: false });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
      
      if (rows.length === 0) {
        showToast("Tập tin Excel trống!", "danger");
        return;
      }
      
      const parsed = parseSupplierRows(rows);
      supplierExcelImportData = parsed.records;
      const previewRows = supplierExcelImportData.slice(0, 5);
      if (parsed.errors.length || supplierExcelImportData.length === 0) {
        const previewBody = document.getElementById('supplier-excel-preview-table-body');
        if (previewBody) previewBody.innerHTML = '';
        showToast(parsed.errors.slice(0, 3).join(' ') || 'Không tìm thấy dòng dữ liệu hợp lệ trong file.', 'danger');
        const summaryEl = document.getElementById('supplier-excel-preview-summary');
        if (summaryEl) summaryEl.textContent = parsed.errors.join(' ');
        const container = document.getElementById('supplier-excel-preview-container');
        if (container) container.style.display = 'block';
        const submitBtn = document.getElementById('btn-save-supplier-excel-submit');
        if (submitBtn) submitBtn.disabled = true;
        return;
      }
      
      // Render bảng preview
      const previewBody = document.getElementById('supplier-excel-preview-table-body');
      if (previewBody) {
        previewBody.innerHTML = previewRows.map((s, idx) => `
          <tr>
            <td style="text-align: center;">${idx + 1}</td>
            <td style="font-weight: 600;">${escapeHtml(s.code)}</td>
            <td style="font-weight: bold;">${escapeHtml(s.name)}</td>
            <td>${escapeHtml(s.phone || '-')}</td>
            <td>${escapeHtml(s.address || '-')}</td>
          </tr>
        `).join('');
      }
      
      const summaryEl = document.getElementById('supplier-excel-preview-summary');
      if (summaryEl) {
        summaryEl.textContent = `Đã đọc ${supplierExcelImportData.length} nhà cung cấp hợp lệ. Hiển thị ${previewRows.length} dòng đầu tiên; trùng mã hiện có sẽ được cập nhật, không thay đổi công nợ.`;
      }
      
      const container = document.getElementById('supplier-excel-preview-container');
      if (container) container.style.display = 'block';
      
      const submitBtn = document.getElementById('btn-save-supplier-excel-submit');
      if (submitBtn) {
        submitBtn.removeAttribute('disabled');
        submitBtn.disabled = false;
      }
      
      const dropzone = document.getElementById('supplier-excel-dropzone');
      if (dropzone) dropzone.className = 'upload-dropzone success-uploaded';
      
      showToast(`Đọc tệp thành công! Tìm thấy ${supplierExcelImportData.length} nhà cung cấp.`, "success");
    } catch(err) {
      console.error(err);
      showToast("Lỗi đọc tệp Excel: " + err.message, "danger");
    } finally {
      const el = document.getElementById('supplier-excel-file-input');
      if (el) el.value = '';
    }
  };
  reader.readAsArrayBuffer(file);
}

async function processSupplierExcelImport() {
  if (supplierExcelImportData.length === 0) return;
  if (getCloudReadHealth().failedDomains.includes('suppliers')) {
    showToast('Danh sách nhà cung cấp chưa tải được từ Cloud; hãy tải lại trước khi nhập để tránh trùng mã.', 'danger');
    return;
  }
  const submitButton = document.getElementById('btn-save-supplier-excel-submit');
  if (submitButton) submitButton.disabled = true;
  try {
    let created = 0;
    let updated = 0;
    let saved = 0;
    for (const supplier of supplierExcelImportData) {
      const existing = getKnownSuppliers().find(item => String(item.code || '').trim().toUpperCase() === supplier.code);
      const result = await dbSaveSupplier({
        ...supplier,
        id: existing?.id || null,
        openingDebt: existing ? Number(existing.openingDebt || 0) : 0
      });
      if (!result) break;
      saved += 1;
      if (existing) updated += 1;
      else created += 1;
    }
    if (saved === supplierExcelImportData.length) {
      closeSupplierExcelModal();
      showToast(`Đã nhập ${saved} nhà cung cấp (${created} thêm mới, ${updated} cập nhật). Công nợ và lịch sử mua hàng được giữ nguyên.`, 'success');
    } else if (saved > 0) {
      showToast(`Đã lưu ${saved}/${supplierExcelImportData.length} nhà cung cấp trước khi gặp lỗi. Có thể nhập lại cùng tệp; các mã đã có sẽ được cập nhật an toàn.`, 'warning');
    }
    renderSuppliersTable();
    populateSupplierDatalist();
    renderAll();
  } catch (err) {
    console.error(err);
    showToast("Lỗi khi nhập danh sách nhà cung cấp: " + err.message, "danger");
  } finally {
    if (submitButton) submitButton.disabled = supplierExcelImportData.length === 0;
  }
}
