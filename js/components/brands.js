import { state } from '../state.js';
import { showToast, safeCreateIcons, getBrandById } from '../utils.js';
import { dbSaveBrand, dbDeleteBrand, dbRenameBrandProducts } from '../services/supabase.js?v=20260814-invoice-discount-label-v19';
import { renderAll } from '../main.js?v=20260814-invoice-discount-label-v19';

export function renderBrandsTable() {
  const tableBody = document.getElementById('brands-table-body');
  if (!tableBody) return;
  
  if (!state.brands || state.brands.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="12" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Không tìm thấy hãng sơn nào.
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = state.brands.map((b) => {
    const brandId = b.id || ('brand_' + String(b.name).toLowerCase().replace(/[^a-z0-9]/g, ''));
    return `
      <tr>
        <td style="font-weight: 600; color: #fff;">
          ${b.name}
          <div style="font-size: 0.72rem; color: var(--text-secondary); font-family: monospace; font-weight: normal; margin-top: 2px;">ID: ${brandId}</div>
        </td>
        <td>${b.companyName}</td>
        <td><code>${b.logoFilename}</code></td>
        <td>${b.hotline}</td>
        <td>${b.cskh}</td>
        <td>${b.email}</td>
        <td>${b.addressMain}</td>
        <td>${b.addressFactory}</td>
        <td>${b.addressBusiness || '<span style="color: var(--text-muted); font-style: italic;">Không có (Ẩn ĐĐKD)</span>'}</td>
        <td>${b.invoiceWarehouseText || 'Xuất Tại kho số 03 Chi nhánh Thái Nguyên'}</td>
        <td>${b.salesPhone || b.hotline || '<span style="color: var(--text-muted);">Chưa cấu hình</span>'}</td>
        <td class="admin-only" style="text-align: center;">
          <div style="display: inline-flex; gap: 0.5rem; justify-content: center;">
            <button class="btn btn-secondary btn-sm btn-circle edit-brand-btn" data-name="${b.name}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-brand-btn" data-name="${b.name}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  safeCreateIcons();
  
  // Gán sự kiện cho các nút sửa, xóa hãng sơn
  document.querySelectorAll('.edit-brand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-name');
      openBrandModal(name);
    });
  });
  
  document.querySelectorAll('.delete-brand-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const name = btn.getAttribute('data-name');
      deleteBrand(name);
    });
  });
}

function openBrandModal(brandName = null) {
  const modal = document.getElementById('brand-modal');
  const title = document.getElementById('brand-modal-title');
  const form = document.getElementById('brand-form');
  const nameInput = document.getElementById('brand-name');
  const compSelect = document.getElementById('brand-company-id');
  const compNameInput = document.getElementById('brand-company-name');
  
  if (!modal || !title || !form) return;
  
  form.reset();

  // Populate company dropdown
  if (compSelect) {
    const compOptions = (state.companies || []).map(c => `<option value="${c.id}">${c.name}</option>`).join('');
    compSelect.innerHTML = `<option value="">-- Nhãn dùng chung (Không thuộc công ty riêng) --</option>${compOptions}`;
    
    compSelect.onchange = () => {
      const selectedId = compSelect.value;
      if (selectedId) {
        const found = (state.companies || []).find(c => c.id === selectedId);
        if (found && compNameInput) compNameInput.value = found.name;
      } else if (compNameInput) {
        compNameInput.value = 'Dùng chung';
      }
    };
  }
  
  const idDisplay = document.getElementById('brand-id-display');
  if (brandName) {
    title.innerText = 'Chỉnh sửa hãng sơn';
    document.getElementById('brand-edit-is-new').value = 'false';
    document.getElementById('brand-old-name').value = brandName;
    nameInput.value = brandName;
    nameInput.removeAttribute('disabled');
    
    const brand = state.brands.find(b => b.name === brandName);
    if (brand) {
      const brandId = brand.id || ('brand_' + String(brand.name).toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (idDisplay) idDisplay.value = brandId;
      if (compSelect) compSelect.value = brand.companyId || '';
      document.getElementById('brand-company-name').value = brand.companyName || 'Dùng chung';
      document.getElementById('brand-logo-filename').value = brand.logoFilename;
      document.getElementById('brand-hotline').value = brand.hotline;
      document.getElementById('brand-cskh').value = brand.cskh;
      document.getElementById('brand-email').value = brand.email;
      document.getElementById('brand-address-main').value = brand.addressMain;
      document.getElementById('brand-address-factory').value = brand.addressFactory;
      document.getElementById('brand-address-business').value = brand.addressBusiness || '';
      document.getElementById('brand-invoice-warehouse-text').value = brand.invoiceWarehouseText || 'Xuất Tại kho số 03 Chi nhánh Thái Nguyên';
      document.getElementById('brand-sales-phone').value = brand.salesPhone || '';
    }
  } else {
    title.innerText = 'Thêm hãng sơn mới';
    document.getElementById('brand-edit-is-new').value = 'true';
    document.getElementById('brand-old-name').value = '';
    nameInput.removeAttribute('disabled');
    if (idDisplay) idDisplay.value = '(Tự động sinh mã ID khi lưu)';
    document.getElementById('brand-invoice-warehouse-text').value = 'Xuất Tại kho số 03 Chi nhánh Thái Nguyên';
  }
  
  modal.classList.add('active');
}

function closeBrandModal() {
  const modal = document.getElementById('brand-modal');
  if (modal) modal.classList.remove('active');
}

async function saveBrand() {
  const isNew = document.getElementById('brand-edit-is-new').value === 'true';
  const oldName = document.getElementById('brand-old-name').value.trim();
  const name = document.getElementById('brand-name').value.trim();
  const compSelect = document.getElementById('brand-company-id');
  const companyId = compSelect ? (compSelect.value || null) : null;
  const companyName = document.getElementById('brand-company-name').value.trim() || 'Dùng chung';
  const logoFilename = document.getElementById('brand-logo-filename').value.trim();
  const hotline = document.getElementById('brand-hotline').value.trim();
  const cskh = document.getElementById('brand-cskh').value.trim();
  const email = document.getElementById('brand-email').value.trim();
  const addressMain = document.getElementById('brand-address-main').value.trim();
  const addressFactory = document.getElementById('brand-address-factory').value.trim();
  const addressBusiness = document.getElementById('brand-address-business').value.trim() || null;
  const invoiceWarehouseText = document.getElementById('brand-invoice-warehouse-text').value.trim() || 'Xuất Tại kho số 03 Chi nhánh Thái Nguyên';
  const salesPhone = document.getElementById('brand-sales-phone').value.trim();
  
  if (!name || !companyName || !logoFilename || !hotline || !cskh || !email || !addressMain || !addressFactory) {
    showToast('Vui lòng nhập đầy đủ các trường bắt buộc (*)', 'danger');
    return;
  }
  
  const existingBrand = state.brands.find(b => b.name === oldName || b.name === name);
  const id = existingBrand && existingBrand.id ? existingBrand.id : ('brand_' + name.toLowerCase().replace(/[^a-z0-9]/g, ''));

  const brandObj = {
    id,
    name,
    companyId,
    companyName,
    logoFilename,
    hotline,
    cskh,
    email,
    addressMain,
    addressFactory,
    addressBusiness,
    invoiceWarehouseText,
    salesPhone
  };
  
  // Nếu thêm mới hãng sơn, kiểm tra trùng tên hãng sơn
  if (isNew) {
    const exists = state.brands.some(b => b.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      showToast(`Hãng sơn "${name}" đã tồn tại!`, 'danger');
      return;
    }
  } else if (oldName && oldName !== name) {
    const exists = state.brands.some(b => b.name.toLowerCase() === name.toLowerCase() && b.id !== id);
    if (exists) {
      showToast(`Tên hãng sơn "${name}" đã tồn tại!`, 'danger');
      return;
    }
  }
  
  const success = await dbSaveBrand(brandObj, oldName);
  if (success) {
    if (isNew) {
      state.brands.push(brandObj);
      showToast(`Đã thêm hãng sơn "${name}" thành công!`);
    } else {
      state.brands = (state.brands || []).filter(b => 
        b.id !== id && 
        b.name.toLowerCase() !== (oldName || '').toLowerCase() && 
        b.name.toLowerCase() !== name.toLowerCase()
      );
      state.brands.push(brandObj);

      // Cập nhật liên kết nếu đổi tên hãng sơn
      if (oldName && oldName !== name) {
        // Cập nhật Sản phẩm
        (state.products || []).forEach(p => {
          const linkedBrand = getBrandById(p.brandId || p.brand);
          const matchesBrand = linkedBrand?.id === id ||
            p.brandId === id ||
            String(p.brand || '').trim().toLowerCase() === oldName.toLowerCase();
          if (matchesBrand) {
            p.brand = name;
            p.brandId = id;
          }
        });
        localStorage.setItem('billing_system_products', JSON.stringify(state.products));
        await dbRenameBrandProducts(id, oldName, name);

        // Cập nhật Khách hàng
        (state.customers || []).forEach(c => {
          if (c.assignedBrand === oldName) c.assignedBrand = name;
          if (c.brandDiscounts && c.brandDiscounts[oldName] !== undefined) {
            c.brandDiscounts[name] = c.brandDiscounts[oldName];
            delete c.brandDiscounts[oldName];
          }
        });
        localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));

        // Cập nhật Bảng giá
        (state.pricelists || []).forEach(pl => {
          if (pl.brandDiscounts && pl.brandDiscounts[oldName] !== undefined) {
            pl.brandDiscounts[name] = pl.brandDiscounts[oldName];
            delete pl.brandDiscounts[oldName];
          }
        });

        // Cập nhật các ô lọc giao diện đang chọn tên cũ
        const prodFilter = document.getElementById('product-brand-filter');
        if (prodFilter && (prodFilter.value === oldName || prodFilter.value.toLowerCase() === oldName.toLowerCase())) {
          prodFilter.value = name;
        }
        const dashFilter = document.getElementById('dashboard-filter-brand');
        if (dashFilter && (dashFilter.value === oldName || dashFilter.value.toLowerCase() === oldName.toLowerCase())) {
          dashFilter.value = name;
        }
      }

      showToast(`Đã cập nhật hãng sơn "${name}" thành công!`);
    }
    
    // Đồng bộ lại local storage
    localStorage.setItem('billing_system_brands', JSON.stringify(state.brands));
    
    closeBrandModal();
    renderAll();
  }
}

async function deleteBrand(name) {
  if (confirm(`Bạn có chắc chắn muốn xóa hãng sơn "${name}" không? Mọi sản phẩm thuộc hãng sơn này có thể không tìm thấy logo/thông tin liên kết.`)) {
    const success = await dbDeleteBrand(name);
    if (success) {
      state.brands = state.brands.filter(b => b.name !== name);
      localStorage.setItem('billing_system_brands', JSON.stringify(state.brands));
      showToast(`Đã xóa hãng sơn "${name}"!`);
      renderAll();
    }
  }
}

export function setupBrandsPanel() {
  const addBtn = document.getElementById('btn-open-add-brand-modal');
  const closeBtn = document.getElementById('btn-close-brand-modal');
  const cancelBtn = document.getElementById('btn-cancel-brand-modal');
  const form = document.getElementById('brand-form');
  
  if (addBtn) addBtn.addEventListener('click', () => openBrandModal());
  if (closeBtn) closeBtn.addEventListener('click', closeBrandModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeBrandModal);
  
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveBrand();
    });
  }
}
