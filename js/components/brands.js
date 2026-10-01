import { state } from '../state.js';
import { showToast, safeCreateIcons, getBrandById } from '../utils.js';
import { dbSaveBrand, dbDeleteBrand, dbRenameBrandProducts } from '../services/supabase.js';
import { renderAll } from '../main.js';
import { tenantStorage } from '../services/tenant-storage.js';

export function renderBrandsTable() {
  const tableBody = document.getElementById('brands-table-body');
  if (!tableBody) return;

  const query = (document.getElementById('brand-search-input')?.value || '').toLowerCase().trim();
  const brands = (state.brands || []).filter(brand => !query
    || String(brand.name || '').toLowerCase().includes(query));

  if (brands.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="3" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          ${query ? 'Không tìm thấy thương hiệu phù hợp.' : 'Chưa có thương hiệu nào.'}
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = brands.map((b) => {
    const brandId = b.id || ('brand_' + String(b.name).toLowerCase().replace(/[^a-z0-9]/g, ''));
    const safeName = String(b.name || '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
    const productCount = (state.products || []).filter(product =>
      String(product.brandId || product.brand || '').toLowerCase() === String(brandId).toLowerCase()
      || String(product.brand || '').toLowerCase() === String(b.name || '').toLowerCase()
    ).length;
    return `
      <tr>
        <td style="font-weight: 600;">
          ${safeName}
          <div style="font-size: 0.72rem; color: var(--text-secondary); font-family: monospace; font-weight: normal; margin-top: 2px;">ID: ${String(brandId).replace(/[&<>"']/g, '')}</div>
        </td>
        <td>${productCount.toLocaleString('vi-VN')}</td>
        <td class="admin-only" style="text-align: center;">
          <div style="display: inline-flex; gap: 0.5rem; justify-content: center;">
            <button class="btn btn-secondary btn-sm btn-circle edit-brand-btn" data-name="${safeName}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-brand-btn" data-name="${safeName}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  safeCreateIcons();
  
  // Thương hiệu là metadata danh mục; thông tin phát hành được quản lý riêng.
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
  if (!modal || !title || !form) return;
  
  form.reset();
  
  const idDisplay = document.getElementById('brand-id-display');
  if (brandName) {
    title.innerText = 'Chỉnh sửa thương hiệu';
    document.getElementById('brand-edit-is-new').value = 'false';
    document.getElementById('brand-old-name').value = brandName;
    nameInput.value = brandName;
    nameInput.removeAttribute('disabled');
    
    const brand = state.brands.find(b => b.name === brandName);
    if (brand) {
      const brandId = brand.id || ('brand_' + String(brand.name).toLowerCase().replace(/[^a-z0-9]/g, ''));
      if (idDisplay) idDisplay.value = brandId;
    }
  } else {
    title.innerText = 'Thêm thương hiệu mới';
    document.getElementById('brand-edit-is-new').value = 'true';
    document.getElementById('brand-old-name').value = '';
    nameInput.removeAttribute('disabled');
    if (idDisplay) idDisplay.value = '(Tự động sinh mã ID khi lưu)';
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
  
  if (!name) {
    showToast('Vui lòng nhập tên thương hiệu.', 'danger');
    return;
  }
  
  const existingBrand = state.brands.find(b => b.name === oldName || b.name === name);
  const normalizedId = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const generatedSuffix = globalThis.crypto?.randomUUID?.() || `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const id = existingBrand?.id || `brand_${normalizedId || generatedSuffix}`;

  const brandObj = {
    ...(existingBrand || {}),
    id,
    name
  };
  
  // Nếu thêm mới thương hiệu, kiểm tra trùng tên thương hiệu
  if (isNew) {
    const exists = state.brands.some(b => b.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      showToast(`Thương hiệu "${name}" đã tồn tại!`, 'danger');
      return;
    }
  } else if (oldName && oldName !== name) {
    const exists = state.brands.some(b => b.name.toLowerCase() === name.toLowerCase() && b.id !== id);
    if (exists) {
      showToast(`Tên thương hiệu "${name}" đã tồn tại!`, 'danger');
      return;
    }
  }
  
  const success = await dbSaveBrand(brandObj, oldName);
  if (success) {
    if (isNew) {
      state.brands.push(brandObj);
      showToast(`Đã thêm thương hiệu "${name}" thành công!`);
    } else {
      state.brands = (state.brands || []).filter(b => 
        b.id !== id && 
        b.name.toLowerCase() !== (oldName || '').toLowerCase() && 
        b.name.toLowerCase() !== name.toLowerCase()
      );
      state.brands.push(brandObj);

      // Cập nhật liên kết nếu đổi tên thương hiệu
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
        tenantStorage.setItem('billing_system_products', JSON.stringify(state.products));
        await dbRenameBrandProducts(id, oldName, name);

        // Cập nhật Khách hàng
        (state.customers || []).forEach(c => {
          if (c.assignedBrand === oldName) c.assignedBrand = name;
          if (c.brandDiscounts && c.brandDiscounts[oldName] !== undefined) {
            c.brandDiscounts[name] = c.brandDiscounts[oldName];
            delete c.brandDiscounts[oldName];
          }
        });
        tenantStorage.setItem('billing_system_customers', JSON.stringify(state.customers));

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

      showToast(`Đã cập nhật thương hiệu "${name}" thành công!`);
    }
    
    // Đồng bộ lại local storage
    tenantStorage.setItem('billing_system_brands', JSON.stringify(state.brands));
    
    closeBrandModal();
    renderAll();
  }
}

async function deleteBrand(name) {
  const linkedCount = (state.products || []).filter(product => {
    const resolved = getBrandById(product.brandId || product.brand);
    return resolved?.name?.toLowerCase() === String(name).toLowerCase()
      || String(product.brand || '').toLowerCase() === String(name).toLowerCase();
  }).length;
  const linkedCustomerCount = (state.customers || []).filter(customer => {
    const resolved = getBrandById(customer.assignedBrandId || customer.assignedBrand);
    return resolved?.name?.toLowerCase() === String(name).toLowerCase()
      || String(customer.assignedBrand || '').toLowerCase() === String(name).toLowerCase();
  }).length;
  if (linkedCount > 0 || linkedCustomerCount > 0) {
    const references = [
      linkedCount ? `${linkedCount} mặt hàng` : '',
      linkedCustomerCount ? `${linkedCustomerCount} khách hàng` : ''
    ].filter(Boolean).join(' và ');
    showToast(`Không thể xóa thương hiệu đang được dùng bởi ${references}. Hãy gỡ các liên kết trước.`, 'warning');
    return;
  }
  if (confirm(`Bạn có chắc chắn muốn xóa giá trị thương hiệu "${name}" khỏi danh mục không?`)) {
    const success = await dbDeleteBrand(name);
    if (success) {
      state.brands = state.brands.filter(b => b.name !== name);
      tenantStorage.setItem('billing_system_brands', JSON.stringify(state.brands));
      showToast(`Đã xóa thương hiệu "${name}"!`);
      renderAll();
    }
  }
}

export function setupBrandsPanel() {
  const addBtn = document.getElementById('btn-open-add-brand-modal');
  const searchInput = document.getElementById('brand-search-input');
  const closeBtn = document.getElementById('btn-close-brand-modal');
  const cancelBtn = document.getElementById('btn-cancel-brand-modal');
  const form = document.getElementById('brand-form');
  
  if (addBtn) addBtn.addEventListener('click', () => openBrandModal());
  if (searchInput) searchInput.addEventListener('input', renderBrandsTable);
  if (closeBtn) closeBtn.addEventListener('click', closeBrandModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeBrandModal);
  
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveBrand();
    });
  }
}
