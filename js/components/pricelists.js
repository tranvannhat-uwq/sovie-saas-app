import { state } from '../state.js';
import { showToast, safeCreateIcons, getBrandName, makeSelectSearchable } from '../utils.js';
import {
  dbSavePricelist,
  dbDeletePricelist,
  dbSavePriceListItems,
  dbDeletePriceListItem,
  persistAuthorizedPricingCache
} from '../services/supabase.js?v=20260814-invoice-discount-label-v19';
import { renderAll } from '../main.js?v=20260814-invoice-discount-label-v19';
import { applyActivePriceListToInvoice } from './invoice.js?v=20260814-invoice-discount-label-v19';
import {
  PRICE_LIST_TYPES,
  normalizePriceListType,
  isPrivilegedPricingRole,
  filterPriceListsForUser,
  isDealerPrivatePriceList,
  getApplicablePriceList,
  resolvePriceForList,
  sortPriceLists,
  parseVndInteger
} from '../domain/pricing.js?v=20260814-invoice-discount-label-v19';
import { isPrintOnlyPriceList } from '../domain/invoice-discount.js?v=20260814-invoice-discount-label-v19';

const pendingChanges = new Map();
const pendingDeletes = new Set();
const PRICE_MATRIX_FIXED_HEADERS = ['Mã SKU', 'Tên sản phẩm', 'Hãng sơn', 'Quy cách'];

function canManagePriceLists() {
  return isPrivilegedPricingRole(state.currentUser);
}

function rejectPriceListMutation() {
  showToast('Tài khoản kinh doanh chỉ có quyền xem bảng giá.', 'warning');
}

function getProductId(product) {
  return product.id;
}

function itemKey(priceListId, productId) {
  return `${priceListId}::${productId}`;
}

function getPriceItem(priceListId, productId) {
  return (state.priceListItems || []).find(item => item.priceListId === priceListId && item.productId === productId) || null;
}

function upsertPriceListSnapshot(priceList) {
  const allLists = [...(state.allPricelists || [])];
  const index = allLists.findIndex(item => item.id === priceList.id);
  if (index >= 0) allLists[index] = priceList;
  else allLists.push(priceList);
  state.allPricelists = allLists;
  state.pricelists = filterPriceListsForUser(allLists, state.currentUser);
  void persistAuthorizedPricingCache();
}

function commitPriceListItemSnapshot(changes, deletedKeys = new Set()) {
  let allItems = [...(state.allPriceListItems || [])];
  changes.forEach(change => {
    const index = allItems.findIndex(item =>
      item.priceListId === change.priceListId && item.productId === change.productId
    );
    if (index >= 0) allItems[index] = { ...allItems[index], ...change };
    else allItems.push(change);
  });
  deletedKeys.forEach(key => {
    const [priceListId, productId] = key.split('::');
    allItems = allItems.filter(item =>
      !(item.priceListId === priceListId && item.productId === productId)
    );
  });
  const visibleIds = new Set((state.pricelists || []).map(priceList => priceList.id));
  state.allPriceListItems = allItems;
  state.priceListItems = allItems.filter(item => visibleIds.has(item.priceListId));
  void persistAuthorizedPricingCache();
}

function formatVndInput(price) {
  return price === null || price === undefined ? '' : new Intl.NumberFormat('vi-VN').format(Number(price));
}

function priceListBadge(priceList) {
  const type = normalizePriceListType(priceList.type, priceList.customerId);
  if (type === PRICE_LIST_TYPES.DEALER_PRIVATE) return '<span class="price-type-badge specific">Bảng giá riêng - Bảo mật</span>';
  if (type === PRICE_LIST_TYPES.SALES) return '<span class="price-type-badge sales">Sale được dùng</span>';
  if (type === PRICE_LIST_TYPES.CUSTOMER_GROUP) return '<span class="price-type-badge group">Giá nhóm</span>';
  return '<span class="price-type-badge standard">Giá chung</span>';
}

function priceListDisplayName(priceList) {
  if (state.currentUser?.role === 'sale' && isDealerPrivatePriceList(priceList)) return 'Bảng giá riêng';
  const type = normalizePriceListType(priceList.type, priceList.customerId);
  if (type !== PRICE_LIST_TYPES.DEALER_PRIVATE) return priceList.name;
  const customer = state.customers.find(item => item.id === priceList.customerId);
  return customer ? `Giá riêng - ${customer.name}` : priceList.name;
}

function visiblePriceLists() {
  return filterPriceListsForUser(state.pricelists, state.currentUser);
}

function getFilteredMatrixProducts() {
  const productSearch = (document.getElementById('price-matrix-product-search')?.value || '').trim().toLowerCase();
  const brandFilter = document.getElementById('price-matrix-brand-filter')?.value || '';
  const packageFilter = document.getElementById('price-matrix-package-filter')?.value || '';
  const groupFilter = document.getElementById('price-matrix-group-filter')?.value || '';

  return (state.products || [])
    .filter(product => product.id && product.packageType && !product.isLegacy && product.isActive !== false)
    .filter(product => {
      const brand = getBrandName(product.brandId || product.brand, product.brand || '');
      const haystack = `${product.code} ${product.name} ${brand} ${product.displaySpecification || ''} ${product.group || ''}`.toLowerCase();
      if (productSearch && !haystack.includes(productSearch)) return false;
      if (brandFilter && brand !== brandFilter) return false;
      if (packageFilter && product.packageType !== packageFilter) return false;
      if (groupFilter && product.group !== groupFilter) return false;
      return true;
    })
    .sort((a, b) => String(a.code).localeCompare(String(b.code), 'vi'));
}

function priceListExcelHeader(priceList) {
  return `${priceListDisplayName(priceList)} [${priceList.id}]`;
}

function matrixProductCells(product) {
  return [
    product.code,
    product.name,
    getBrandName(product.brandId || product.brand, product.brand || ''),
    product.displaySpecification || `${product.packageType} ${product.packageWeight ?? ''} ${product.packageWeightUnit || ''}`.trim()
  ];
}

function buildPriceListSelector() {
  const selector = document.getElementById('pricelist-visible-select');
  if (!selector) return;
  const lists = visiblePriceLists();
  const visibleIds = new Set(lists.map(priceList => priceList.id));
  state.selectedPriceListIds = (state.selectedPriceListIds || []).filter(id => visibleIds.has(id));
  if (!state.selectedPriceListIds?.length) {
    state.selectedPriceListIds = lists.slice(0, 5).map(priceList => priceList.id);
  }
  const query = (document.getElementById('price-list-picker-search')?.value || '').trim().toLowerCase();
  const filtered = lists.filter(priceList => `${priceList.name} ${priceList.code || ''}`.toLowerCase().includes(query));
  selector.innerHTML = `
    <div class="price-list-picker-search-wrap">
      <i data-lucide="search"></i>
      <input type="search" id="price-list-picker-search" placeholder="Tìm bảng giá" value="${query}">
    </div>
    <div class="price-list-picker-options">
      ${filtered.map(priceList => `
        <div class="price-list-picker-option">
          <label>
            <input type="checkbox" class="price-list-visible-check" value="${priceList.id}" ${state.selectedPriceListIds.includes(priceList.id) ? 'checked' : ''}>
            <span><strong>${priceListDisplayName(priceList)}</strong>${priceListBadge(priceList)}</span>
          </label>
          ${canManagePriceLists() ? `
            <div class="picker-actions">
              <button type="button" class="icon-btn edit-price-list" data-id="${priceList.id}" title="Sửa bảng giá"><i data-lucide="pencil"></i></button>
              ${normalizePriceListType(priceList.type, priceList.customerId) !== PRICE_LIST_TYPES.GENERAL
                ? `<button type="button" class="icon-btn delete-price-list" data-id="${priceList.id}" title="Ngừng áp dụng bảng giá"><i data-lucide="archive"></i></button>`
                : ''}
            </div>
          ` : ''}
        </div>
      `).join('') || '<div class="picker-empty">Không tìm thấy bảng giá.</div>'}
    </div>
  `;
  const summary = document.getElementById('pricelist-visible-summary');
  if (summary) summary.innerText = `${state.selectedPriceListIds.length} bảng giá đang hiển thị`;
  safeCreateIcons();
}

function populateMatrixFilters() {
  const skuProducts = (state.products || []).filter(product => product.id && product.packageType && !product.isLegacy);
  const definitions = [
    ['price-matrix-brand-filter', 'Tất cả hãng sơn', [...new Set(skuProducts.map(product => getBrandName(product.brandId || product.brand, product.brand)).filter(Boolean))]],
    ['price-matrix-package-filter', 'Tất cả loại bao bì', [...new Set(skuProducts.map(product => product.packageType).filter(Boolean))]],
    ['price-matrix-group-filter', 'Tất cả nhóm sản phẩm', [...new Set(skuProducts.map(product => product.group).filter(Boolean))]]
  ];
  definitions.forEach(([id, label, values]) => {
    const select = document.getElementById(id);
    if (!select) return;
    const current = select.value;
    values.sort((a, b) => String(a).localeCompare(String(b), 'vi'));
    select.innerHTML = `<option value="">${label}</option>${values.map(value => `<option value="${value}">${value}</option>`).join('')}`;
    select.value = values.includes(current) ? current : '';
  });
}

function buildEffectivePriceItems() {
  const items = (state.priceListItems || []).filter(item => !pendingDeletes.has(itemKey(item.priceListId, item.productId)));
  const byKey = new Map(items.map(item => [itemKey(item.priceListId, item.productId), { ...item }]));
  pendingChanges.forEach((price, key) => {
    const [priceListId, productId] = key.split('::');
    byKey.set(key, { priceListId, productId, price });
  });
  return [...byKey.values()];
}

function renderCell(product, priceList, effectivePriceItems) {
  const key = itemKey(priceList.id, product.id);
  const directItem = getPriceItem(priceList.id, product.id);
  const pendingDelete = pendingDeletes.has(key);
  const pending = pendingChanges.get(key);
  const resolved = resolvePriceForList({
    productId: product.id,
    priceListId: priceList.id,
    priceLists: state.pricelists,
    priceListItems: effectivePriceItems
  });
  const displayPrice = pending !== undefined ? pending : resolved.price;
  const status = pending !== undefined ? 'direct' : resolved.status;
  const statusText = status === 'inherited' ? 'Kế thừa' : status === 'missing' ? 'Chưa có giá' : 'Giá nhập riêng';
  if (!canManagePriceLists()) {
    return `
      <td class="price-col price-cell ${status}">
        <div class="price-cell-editor readonly">
          <span class="price-matrix-value" aria-label="${priceList.name} - ${product.code}">
            ${displayPrice === null || displayPrice === undefined ? 'Chưa có giá' : formatVndInput(displayPrice)}
          </span>
        </div>
        <span class="price-cell-status ${status}">${statusText}</span>
      </td>
    `;
  }
  return `
    <td class="price-col price-cell ${status} ${pending !== undefined || pendingDelete ? 'dirty' : ''}">
      <div class="price-cell-editor">
        <input
          type="text"
          inputmode="numeric"
          class="form-control-inline price-matrix-input"
          data-price-list-id="${priceList.id}"
          data-product-id="${product.id}"
          value="${formatVndInput(displayPrice)}"
          placeholder="Chưa có giá"
          aria-label="${priceList.name} - ${product.code}"
        >
        ${directItem && !pendingDelete && normalizePriceListType(priceList.type, priceList.customerId) !== PRICE_LIST_TYPES.GENERAL ? `
          <button class="icon-btn delete-price-override" data-price-list-id="${priceList.id}" data-product-id="${product.id}" title="Xóa giá riêng">
            <i data-lucide="rotate-ccw"></i>
          </button>
        ` : ''}
      </div>
      <span class="price-cell-status ${status}">${statusText}</span>
    </td>
  `;
}

export function renderPricelistsTable() {
  const body = document.getElementById('pricelists-table-body');
  if (!body) return;
  if (!canManagePriceLists()) {
    pendingChanges.clear();
    pendingDeletes.clear();
  }
  buildPriceListSelector();
  populateMatrixFilters();

  const selectedLists = sortPriceLists(visiblePriceLists().filter(priceList => state.selectedPriceListIds.includes(priceList.id)));
  const head = document.querySelector('#pricelists-panel .price-matrix-table thead');
  if (head) {
    head.innerHTML = `
      <tr>
        <th class="sticky-col sticky-code">Mã sản phẩm</th>
        <th class="sticky-col sticky-name">Tên sản phẩm</th>
        <th class="sticky-col sticky-brand">Hãng sơn</th>
        <th class="sticky-col sticky-package">Quy cách</th>
        ${selectedLists.map(priceList => `
          <th class="price-col">
            <div class="price-column-header">${priceListDisplayName(priceList)}${priceListBadge(priceList)}</div>
          </th>
        `).join('')}
      </tr>
    `;
  }

  const products = getFilteredMatrixProducts();
  const effectivePriceItems = buildEffectivePriceItems();

  if (!selectedLists.length) {
    body.innerHTML = '<tr><td colspan="4" class="empty-table-cell">Chọn ít nhất một bảng giá để hiển thị.</td></tr>';
    return;
  }
  if (!products.length) {
    body.innerHTML = `<tr><td colspan="${4 + selectedLists.length}" class="empty-table-cell">Không tìm thấy SKU phù hợp.</td></tr>`;
    return;
  }

  body.innerHTML = products.map(product => `
    <tr>
      <td class="sticky-col sticky-code sku-code">${product.code}</td>
      <td class="sticky-col sticky-name" title="${product.name}">${product.name}</td>
      <td class="sticky-col sticky-brand">${getBrandName(product.brandId || product.brand, product.brand || '')}</td>
      <td class="sticky-col sticky-package">${product.displaySpecification || `${product.packageType} ${product.packageWeight ?? ''} ${product.packageWeightUnit || ''}`}</td>
      ${selectedLists.map(priceList => renderCell(product, priceList, effectivePriceItems)).join('')}
    </tr>
  `).join('');

  document.querySelectorAll('.price-matrix-input').forEach(input => {
    input.addEventListener('focus', () => {
      const parsed = parseVndInteger(input.value);
      input.value = parsed === null ? '' : String(parsed);
      input.select();
    });
    input.addEventListener('input', () => {
      const parsed = parseVndInteger(input.value);
      const key = itemKey(input.dataset.priceListId, input.dataset.productId);
      pendingDeletes.delete(key);
      if (parsed === null) pendingChanges.delete(key);
      else pendingChanges.set(key, parsed);
      const cell = input.closest('.price-cell');
      cell?.classList.remove('inherited', 'missing');
      cell?.classList.add('direct', 'dirty');
      const statusLabel = cell?.querySelector('.price-cell-status');
      if (statusLabel) {
        statusLabel.className = 'price-cell-status direct';
        statusLabel.textContent = 'Giá nhập riêng (chưa lưu)';
      }
      document.getElementById('btn-save-price-matrix')?.removeAttribute('disabled');
    });
    input.addEventListener('blur', () => {
      const parsed = parseVndInteger(input.value);
      input.value = formatVndInput(parsed);
    });
  });

  document.querySelectorAll('.delete-price-override').forEach(button => {
    button.addEventListener('click', () => {
      const key = itemKey(button.dataset.priceListId, button.dataset.productId);
      pendingChanges.delete(key);
      pendingDeletes.add(key);
      document.getElementById('btn-save-price-matrix')?.removeAttribute('disabled');
      renderPricelistsTable();
    });
  });
  safeCreateIcons();
}

export function openPricelistModal(index = -1) {
  if (!canManagePriceLists()) {
    rejectPriceListMutation();
    return;
  }
  const modal = document.getElementById('pricelist-modal');
  const form = document.getElementById('pricelist-form');
  if (!modal || !form) return;
  form.reset();
  modal.classList.add('active');
  document.getElementById('pricelist-edit-index').value = String(index);
  document.getElementById('pricelist-edit-id').value = '';
  document.getElementById('pl-type').value = PRICE_LIST_TYPES.GENERAL;
  document.getElementById('pl-active').checked = true;
  document.getElementById('pl-available-for-sales').checked = false;
  document.getElementById('pl-allow-order-save').checked = true;
  document.getElementById('pl-display-order').value = '0';
  document.getElementById('pricelist-modal-title').innerText = index === -1 ? 'Thêm bảng giá mới' : 'Chỉnh sửa bảng giá';

  const customerSelect = document.getElementById('pl-customer-id');
  customerSelect.innerHTML = `<option value="">Chọn khách hàng/đại lý</option>${state.customers.map(customer => `<option value="${customer.id}">${customer.name} (${customer.code})</option>`).join('')}`;
  const parentSelect = document.getElementById('pl-parent-price-list-id');
  parentSelect.innerHTML = `<option value="">Kế thừa từ Giá chung</option>${state.pricelists.map(priceList => `<option value="${priceList.id}">${priceList.name}</option>`).join('')}`;

  if (index !== -1) {
    const priceList = state.pricelists[index];
    document.getElementById('pricelist-edit-id').value = priceList.id;
    document.getElementById('pl-code').value = priceList.code || '';
    document.getElementById('pl-name').value = priceList.name;
    document.getElementById('pl-type').value = normalizePriceListType(priceList.type, priceList.customerId);
    document.getElementById('pl-customer-id').value = priceList.customerId || '';
    document.getElementById('pl-customer-group-id').value = priceList.customerGroupId || '';
    document.getElementById('pl-parent-price-list-id').value = priceList.parentPriceListId || '';
    document.getElementById('pl-effective-from').value = priceList.effectiveFrom || '';
    document.getElementById('pl-effective-to').value = priceList.effectiveTo || '';
    document.getElementById('pl-display-order').value = String(priceList.displayOrder || 0);
    document.getElementById('pl-active').checked = priceList.isActive !== false;
    document.getElementById('pl-available-for-sales').checked = priceList.isAvailableForSales === true;
    document.getElementById('pl-allow-order-save').checked = !isPrintOnlyPriceList(priceList);
  }
  makeSelectSearchable('pl-customer-id', 'Tìm khách hàng/đại lý');
  updatePricelistTypeFields();
}

function updatePricelistTypeFields() {
  const type = document.getElementById('pl-type')?.value;
  const customerGroup = document.getElementById('pl-customer-field');
  const groupField = document.getElementById('pl-customer-group-field');
  if (customerGroup) customerGroup.style.display = type === PRICE_LIST_TYPES.DEALER_PRIVATE ? 'block' : 'none';
  if (groupField) groupField.style.display = type === PRICE_LIST_TYPES.CUSTOMER_GROUP ? 'block' : 'none';
  const salesToggle = document.getElementById('pl-available-for-sales');
  if (salesToggle) {
    salesToggle.disabled = type === PRICE_LIST_TYPES.DEALER_PRIVATE;
    if (type === PRICE_LIST_TYPES.DEALER_PRIVATE) salesToggle.checked = false;
  }
}

export function closePricelistModal() {
  document.getElementById('pricelist-modal')?.classList.remove('active');
}

export async function savePricelist() {
  if (!canManagePriceLists()) {
    rejectPriceListMutation();
    return;
  }
  const index = Number.parseInt(document.getElementById('pricelist-edit-index').value, 10);
  const type = document.getElementById('pl-type').value;
  const customerId = document.getElementById('pl-customer-id').value || null;
  const customerGroupId = document.getElementById('pl-customer-group-id').value.trim() || null;
  if (type === PRICE_LIST_TYPES.DEALER_PRIVATE && !customerId) {
    showToast('Bảng giá riêng phải gắn với một khách hàng/đại lý.', 'warning');
    return;
  }
  if (type === PRICE_LIST_TYPES.CUSTOMER_GROUP && !customerGroupId) {
    showToast('Bảng giá nhóm phải có mã nhóm khách hàng.', 'warning');
    return;
  }

  const id = index === -1 ? `pl-${Date.now()}` : document.getElementById('pricelist-edit-id').value;
  const priceList = {
    id,
    code: document.getElementById('pl-code').value.trim().toUpperCase(),
    name: document.getElementById('pl-name').value.trim(),
    type,
    customerId: type === PRICE_LIST_TYPES.DEALER_PRIVATE ? customerId : null,
    customerGroupId: type === PRICE_LIST_TYPES.CUSTOMER_GROUP ? customerGroupId : null,
    parentPriceListId: document.getElementById('pl-parent-price-list-id').value || null,
    effectiveFrom: document.getElementById('pl-effective-from').value || '',
    effectiveTo: document.getElementById('pl-effective-to').value || '',
    isActive: document.getElementById('pl-active').checked,
    isAvailableForSales: type === PRICE_LIST_TYPES.DEALER_PRIVATE ? false : document.getElementById('pl-available-for-sales').checked,
    isPrintOnly: !document.getElementById('pl-allow-order-save').checked,
    displayOrder: Number(document.getElementById('pl-display-order').value || 0),
    brandDiscounts: {}
  };
  if (!priceList.name) return;
  if (priceList.parentPriceListId === id) {
    showToast('Bảng giá không thể kế thừa chính nó.', 'warning');
    return;
  }
  if (!(await dbSavePricelist(priceList))) return;
  upsertPriceListSnapshot(priceList);
  closePricelistModal();
  renderAll();
  populatePricelistsDropdowns();
  showToast('Đã lưu bảng giá.');
}

export async function savePriceMatrix() {
  if (!canManagePriceLists()) {
    rejectPriceListMutation();
    return;
  }
  const changes = [...pendingChanges.entries()].map(([key, price]) => {
    const [priceListId, productId] = key.split('::');
    return {
      id: `${priceListId}:${productId}`,
      priceListId,
      productId,
      price,
      sourceType: 'manual',
      updatedBy: state.currentUser?.username || 'admin'
    };
  });
  if (changes.some(item => item.price < 0)) {
    showToast('Giá không được âm.', 'danger');
    return;
  }
  if (changes.some(item => item.price === 0) && !confirm('Có ô giá bằng 0. Bạn xác nhận đây là giá 0 được nhập chủ động?')) return;

  const saved = changes.length === 0 || await dbSavePriceListItems(changes);
  if (!saved) return;
  for (const key of pendingDeletes) {
    const [priceListId, productId] = key.split('::');
    if (!(await dbDeletePriceListItem(priceListId, productId))) return;
  }

  commitPriceListItemSnapshot(changes, pendingDeletes);
  const count = changes.length + pendingDeletes.size;
  pendingChanges.clear();
  pendingDeletes.clear();
  document.getElementById('btn-save-price-matrix')?.setAttribute('disabled', 'true');
  renderPricelistsTable();
  showToast(`Đã lưu ${count} thay đổi giá.`);
}

export async function deletePricelist(index) {
  if (!canManagePriceLists()) {
    rejectPriceListMutation();
    return;
  }
  const priceList = state.pricelists[index];
  if (priceList && normalizePriceListType(priceList.type, priceList.customerId) === PRICE_LIST_TYPES.GENERAL) {
    showToast('Không thể xóa bảng Giá chung. Có thể ngừng áp dụng bảng giá khác.', 'warning');
    return;
  }
  if (!priceList || !confirm(`Ngừng áp dụng bảng giá "${priceList.name}"? Dữ liệu giá và đơn cũ vẫn được giữ.`)) return;
  if (!(await dbDeletePricelist(priceList.id))) return;
  upsertPriceListSnapshot({ ...priceList, isActive: false });
  state.selectedPriceListIds = state.selectedPriceListIds.filter(id => id !== priceList.id);
  renderAll();
  showToast('Bảng giá đã được ngừng áp dụng.');
}

export function populatePricelistsDropdowns() {
  const lists = visiblePriceLists();
  const invoiceSelect = document.getElementById('invoice-pricelist-select');
  if (invoiceSelect) {
    const current = invoiceSelect.value;
    const activeCustomer = state.activeCustomerId
      ? (state.customers || []).find(customer => customer.id === state.activeCustomerId)
      : null;
    const applicable = activeCustomer
      ? getApplicablePriceList(
          activeCustomer,
          state.allPricelists?.length ? state.allPricelists : state.pricelists
        ).priceList
      : null;
    const assignedOnly = applicable && !lists.some(priceList => priceList.id === applicable.id)
      ? applicable
      : null;
    invoiceSelect.innerHTML = `
      <option value="">Tự động theo khách hàng</option>
      ${lists.map(priceList => `<option value="${priceList.id}">${priceListDisplayName(priceList)}</option>`).join('')}
      ${assignedOnly ? `<option value="${assignedOnly.id}" data-customer-assigned="true">${assignedOnly.name} (theo đại lý)</option>` : ''}
      <option value="retail">Nhập tay có xác nhận</option>
    `;
    const desired = current || assignedOnly?.id || '';
    if ([...invoiceSelect.options].some(option => option.value === desired)) invoiceSelect.value = desired;
  }
  const customerSelect = document.getElementById('cust-pricelist');
  if (customerSelect) {
    const current = customerSelect.value;
    customerSelect.innerHTML = `<option value="">Dùng Giá chung</option>${lists.filter(priceList => normalizePriceListType(priceList.type, priceList.customerId) !== PRICE_LIST_TYPES.DEALER_PRIVATE).map(priceList => `<option value="${priceList.id}">${priceList.name}</option>`).join('')}`;
    if ([...customerSelect.options].some(option => option.value === current)) customerSelect.value = current;
  }
}

export function exportPriceMatrixExcel() {
  const lists = sortPriceLists(
    (state.pricelists || []).filter(priceList =>
      priceList.isActive !== false && state.selectedPriceListIds.includes(priceList.id)
    )
  );
  if (!lists.length) {
    showToast('Hãy chọn ít nhất một bảng giá cần xuất.', 'warning');
    return;
  }

  const products = getFilteredMatrixProducts();
  const effectiveItems = buildEffectivePriceItems();
  const headers = [...PRICE_MATRIX_FIXED_HEADERS, ...lists.map(priceListExcelHeader)];
  const directRows = [
    headers,
    ...products.map(product => [
      ...matrixProductCells(product),
      ...lists.map(priceList => {
        const resolved = resolvePriceForList({
          productId: product.id,
          priceListId: priceList.id,
          priceLists: state.pricelists,
          priceListItems: effectiveItems
        });
        return resolved.price === null ? '' : Number(resolved.price);
      })
    ])
  ];
  const effectiveRows = [
    headers,
    ...products.map(product => [
      ...matrixProductCells(product),
      ...lists.map(priceList => {
        const resolved = resolvePriceForList({
          productId: product.id,
          priceListId: priceList.id,
          priceLists: state.pricelists,
          priceListItems: effectiveItems
        });
        return resolved.price === null ? '' : Number(resolved.price);
      })
    ])
  ];

  const workbook = XLSX.utils.book_new();
  const directSheet = XLSX.utils.aoa_to_sheet(directRows);
  const effectiveSheet = XLSX.utils.aoa_to_sheet(effectiveRows);
  const guideSheet = XLSX.utils.aoa_to_sheet([
    ['HƯỚNG DẪN NHẬP BẢNG GIÁ'],
    ['1. Chỉ chỉnh sửa và nhập lại sheet "Nhap Gia".'],
    ['2. Ô trống được bỏ qua, không làm thay đổi dữ liệu đang có.'],
    ['3. Nhập XOA để xóa giá riêng và quay lại giá kế thừa.'],
    ['4. Giá phải là số nguyên không âm. Giá 0 cần xác nhận khi nhập.'],
    ['5. Không sửa Mã SKU hoặc phần ID trong dấu [] ở tiêu đề bảng giá.'],
    ['6. Sheet "Gia Hien Tai" chỉ dùng đối chiếu, gồm cả giá kế thừa.']
  ]);
  const widths = [{ wch: 18 }, { wch: 44 }, { wch: 22 }, { wch: 24 }, ...lists.map(() => ({ wch: 28 }))];
  [directSheet, effectiveSheet].forEach(sheet => {
    sheet['!cols'] = widths;
    sheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(headers.length - 1)}${Math.max(1, products.length + 1)}` };
    for (let rowIndex = 1; rowIndex <= products.length; rowIndex += 1) {
      for (let columnIndex = PRICE_MATRIX_FIXED_HEADERS.length; columnIndex < headers.length; columnIndex += 1) {
        const cell = sheet[XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })];
        if (cell && typeof cell.v === 'number') cell.z = '#,##0';
      }
    }
  });
  guideSheet['!cols'] = [{ wch: 90 }];
  XLSX.utils.book_append_sheet(workbook, directSheet, 'Nhap Gia');
  XLSX.utils.book_append_sheet(workbook, effectiveSheet, 'Gia Hien Tai');
  XLSX.utils.book_append_sheet(workbook, guideSheet, 'Huong Dan');
  XLSX.writeFile(workbook, `Bang_Gia_${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast(`Đã xuất ${products.length} SKU và ${lists.length} bảng giá đang chọn.`);
}

function findPriceListFromExcelHeader(header, lists) {
  const raw = String(header || '').trim();
  const idMatch = raw.match(/\[([^\]]+)\]\s*$/);
  if (idMatch) return lists.find(priceList => priceList.id === idMatch[1].trim()) || null;

  const normalized = raw.toLowerCase();
  const matches = lists.filter(priceList =>
    String(priceList.id).toLowerCase() === normalized ||
    String(priceList.code || '').toLowerCase() === normalized ||
    String(priceList.name || '').toLowerCase() === normalized ||
    priceListDisplayName(priceList).toLowerCase() === normalized
  );
  return matches.length === 1 ? matches[0] : null;
}

function findProductFromExcelRow(code, brand) {
  const normalizedCode = String(code || '').trim().toUpperCase();
  const normalizedBrand = String(brand || '').trim().toLowerCase();
  const matches = (state.products || []).filter(product =>
    product.code === normalizedCode &&
    product.packageType &&
    !product.isLegacy
  );
  if (matches.length <= 1 || !normalizedBrand) return matches.length === 1 ? matches[0] : null;
  return matches.find(product =>
    getBrandName(product.brandId || product.brand, product.brand || '').trim().toLowerCase() === normalizedBrand
  ) || null;
}

function getPriceMatrixRowsFromSheet(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) return null;
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true });
  const firstHeader = String(rows[0]?.[0] || '').trim().toLowerCase();
  if (rows.length < 2 || !firstHeader.includes('sku')) return null;
  return { sheetName, rows };
}

function countPriceMatrixValues(rows) {
  return rows.slice(1).reduce((count, row) => {
    for (let columnIndex = PRICE_MATRIX_FIXED_HEADERS.length; columnIndex < (rows[0]?.length || 0); columnIndex += 1) {
      const rawValue = row?.[columnIndex];
      if (rawValue !== '' && rawValue !== null && rawValue !== undefined) count += 1;
    }
    return count;
  }, 0);
}

function selectPriceMatrixImportRows(workbook) {
  const candidates = ['Nhap Gia', 'Gia Hien Tai', workbook.SheetNames[0]]
    .map(sheetName => getPriceMatrixRowsFromSheet(workbook, sheetName))
    .filter(Boolean);
  const uniqueCandidates = candidates.filter((candidate, index) =>
    candidates.findIndex(item => item.sheetName === candidate.sheetName) === index
  );
  if (!uniqueCandidates.length) return null;
  return uniqueCandidates
    .map(candidate => ({ ...candidate, valueCount: countPriceMatrixValues(candidate.rows) }))
    .sort((a, b) => b.valueCount - a.valueCount)[0];
}

function mergePriceMatrixRows(primaryRows, fallbackRows) {
  if (!primaryRows?.length) return fallbackRows || [];
  if (!fallbackRows?.length) return primaryRows;

  const fallbackByKey = new Map(fallbackRows.slice(1).map(row => [
    [
      String(row?.[0] || '').trim().toUpperCase(),
      String(row?.[2] || '').trim().toLowerCase(),
      String(row?.[3] || '').trim().toLowerCase()
    ].join('|'),
    row
  ]));

  return [
    primaryRows[0],
    ...primaryRows.slice(1).map(row => {
      const key = [
        String(row?.[0] || '').trim().toUpperCase(),
        String(row?.[2] || '').trim().toLowerCase(),
        String(row?.[3] || '').trim().toLowerCase()
      ].join('|');
      const fallbackRow = fallbackByKey.get(key);
      if (!fallbackRow) return row;
      const merged = [...row];
      for (let columnIndex = PRICE_MATRIX_FIXED_HEADERS.length; columnIndex < primaryRows[0].length; columnIndex += 1) {
        if (merged[columnIndex] === '' || merged[columnIndex] === null || merged[columnIndex] === undefined) {
          merged[columnIndex] = fallbackRow[columnIndex];
        }
      }
      return merged;
    })
  ];
}

async function importPriceMatrixExcel(file) {
  if (!canManagePriceLists()) {
    rejectPriceListMutation();
    return;
  }
  try {
    const workbook = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const importRows = getPriceMatrixRowsFromSheet(workbook, 'Nhap Gia');
    const currentRows = getPriceMatrixRowsFromSheet(workbook, 'Gia Hien Tai');
    const selectedSheet = selectPriceMatrixImportRows(workbook);
    const rows = importRows && currentRows
      ? mergePriceMatrixRows(importRows.rows, currentRows.rows)
      : (selectedSheet?.rows || []);
    const firstHeader = String(rows[0]?.[0] || '').trim().toLowerCase();
    if (rows.length < 2 || !firstHeader.includes('sku')) {
      throw new Error('Không tìm thấy sheet "Nhap Gia" hoặc cột đầu tiên "Mã SKU".');
    }

    const lists = visiblePriceLists();
    const mappedColumns = rows[0].slice(PRICE_MATRIX_FIXED_HEADERS.length).map((header, offset) => ({
      columnIndex: offset + PRICE_MATRIX_FIXED_HEADERS.length,
      header,
      priceList: findPriceListFromExcelHeader(header, lists)
    }));
    const unknownHeaders = mappedColumns.filter(column => !column.priceList && String(column.header || '').trim());
    if (unknownHeaders.length) {
      throw new Error(`Không nhận diện được bảng giá: ${unknownHeaders.map(column => column.header).join(', ')}`);
    }
    const priceColumns = mappedColumns.filter(column => column.priceList);
    if (!priceColumns.length) throw new Error('File không có cột bảng giá hợp lệ.');

    const operations = new Map();
    const errors = [];
    rows.slice(1).forEach((row, rowOffset) => {
      const rowNumber = rowOffset + 2;
      const code = String(row[0] || '').trim().toUpperCase();
      if (!code) return;
      const product = findProductFromExcelRow(code, row[2]);
      if (!product) {
        errors.push(`Dòng ${rowNumber}: không tìm thấy hoặc không xác định duy nhất SKU ${code}.`);
        return;
      }
      priceColumns.forEach(({ columnIndex, priceList }) => {
        const rawValue = row[columnIndex];
        if (rawValue === '' || rawValue === null || rawValue === undefined) return;
        const key = itemKey(priceList.id, product.id);
        if (String(rawValue).trim().toUpperCase() === 'XOA') {
          operations.set(key, { action: 'delete', priceListId: priceList.id, productId: product.id });
          return;
        }
        const price = parseVndInteger(rawValue);
        if (price === null || price < 0) {
          errors.push(`Dòng ${rowNumber}, ${priceList.name}: giá "${rawValue}" không hợp lệ.`);
          return;
        }
        operations.set(key, {
          action: 'upsert',
          id: `${priceList.id}:${product.id}`,
          priceListId: priceList.id,
          productId: product.id,
          price,
          sourceType: 'excel_import',
          updatedBy: state.currentUser?.username || 'admin'
        });
      });
    });

    if (errors.length) {
      const details = errors.slice(0, 12).join('\n');
      alert(`Không nhập dữ liệu vì có ${errors.length} lỗi:\n\n${details}${errors.length > 12 ? '\n...' : ''}`);
      return;
    }
    const allOperations = [...operations.values()];
    if (!allOperations.length) {
      showToast('Không có ô giá nào cần nhập.', 'warning');
      return;
    }
    const upserts = allOperations.filter(operation => operation.action === 'upsert');
    const deletes = allOperations.filter(operation => operation.action === 'delete');
    if (upserts.some(item => item.price === 0) && !confirm('File có giá bằng 0. Bạn xác nhận đây là giá 0 được nhập chủ động?')) return;
    if (!confirm(`Nhập ${upserts.length} giá và xóa ${deletes.length} giá riêng từ file Excel?`)) return;

    if (upserts.length && !(await dbSavePriceListItems(upserts))) return;
    for (const item of deletes) {
      if (!(await dbDeletePriceListItem(item.priceListId, item.productId))) return;
    }

    const importedDeleteKeys = new Set(deletes.map(item => itemKey(item.priceListId, item.productId)));
    commitPriceListItemSnapshot(upserts, importedDeleteKeys);
    upserts.forEach(item => {
      pendingChanges.delete(itemKey(item.priceListId, item.productId));
      pendingDeletes.delete(itemKey(item.priceListId, item.productId));
    });
    deletes.forEach(item => {
      pendingChanges.delete(itemKey(item.priceListId, item.productId));
      pendingDeletes.delete(itemKey(item.priceListId, item.productId));
    });
    state.selectedPriceListIds = [...new Set([
      ...state.selectedPriceListIds,
      ...allOperations.map(item => item.priceListId)
    ])];
    renderPricelistsTable();
    showToast(`Đã nhập ${upserts.length} giá và xóa ${deletes.length} giá riêng.`);
  } catch (error) {
    showToast(`Không thể nhập bảng giá: ${error.message}`, 'danger');
  }
}

export function setupPricelistManagement() {
  const visiblePicker = document.getElementById('pricelist-visible-picker');

  document.getElementById('btn-open-add-pricelist-modal')?.addEventListener('click', () => openPricelistModal(-1));
  document.getElementById('btn-close-pricelist-modal')?.addEventListener('click', closePricelistModal);
  document.getElementById('btn-cancel-pricelist')?.addEventListener('click', closePricelistModal);
  document.getElementById('pricelist-form')?.addEventListener('submit', event => {
    event.preventDefault();
    savePricelist();
  });
  document.getElementById('pl-type')?.addEventListener('change', updatePricelistTypeFields);
  ['price-matrix-product-search', 'price-matrix-brand-filter', 'price-matrix-package-filter', 'price-matrix-group-filter'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderPricelistsTable);
    document.getElementById(id)?.addEventListener('change', renderPricelistsTable);
  });
  document.getElementById('pricelist-visible-select')?.addEventListener('change', event => {
    if (!event.target.classList.contains('price-list-visible-check')) return;
    state.selectedPriceListIds = [...document.querySelectorAll('.price-list-visible-check:checked')].map(input => input.value);
    renderPricelistsTable();
  });
  document.getElementById('pricelist-visible-select')?.addEventListener('input', event => {
    if (event.target.id === 'price-list-picker-search') {
      const query = event.target.value;
      buildPriceListSelector();
      const nextInput = document.getElementById('price-list-picker-search');
      if (nextInput) {
        nextInput.value = query;
        nextInput.focus();
        nextInput.setSelectionRange(query.length, query.length);
      }
    }
  });
  document.getElementById('pricelist-visible-select')?.addEventListener('click', event => {
    const editButton = event.target.closest('.edit-price-list');
    const deleteButton = event.target.closest('.delete-price-list');
    if (editButton) {
      event.preventDefault();
      openPricelistModal(state.pricelists.findIndex(priceList => priceList.id === editButton.dataset.id));
    }
    if (deleteButton) {
      event.preventDefault();
      deletePricelist(state.pricelists.findIndex(priceList => priceList.id === deleteButton.dataset.id));
    }
  });
  document.getElementById('btn-save-price-matrix')?.addEventListener('click', savePriceMatrix);
  document.getElementById('btn-export-pricelist-excel')?.addEventListener('click', exportPriceMatrixExcel);
  const priceExcelInput = document.getElementById('pricelist-excel-file-input');
  document.getElementById('btn-import-pricelist-excel')?.addEventListener('click', () => priceExcelInput?.click());
  priceExcelInput?.addEventListener('change', async () => {
    const file = priceExcelInput.files?.[0];
    priceExcelInput.value = '';
    if (file) await importPriceMatrixExcel(file);
  });

  document.addEventListener('pointerdown', event => {
    if (visiblePicker?.open && !visiblePicker.contains(event.target)) {
      visiblePicker.open = false;
    }
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && visiblePicker?.open) {
      visiblePicker.open = false;
      visiblePicker.querySelector('summary')?.focus();
    }
  });
}

