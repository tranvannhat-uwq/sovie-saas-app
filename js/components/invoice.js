import { state } from '../state.js';
import { showToast, formatCurrency, formatNumber, formatPhoneNumber, safeCreateIcons, formatDateTime, getColorPercentFromCode, calculateColorMarkedUpPrice, isSameUser, getProvinceNameByCode, PROVINCES, makeSelectSearchable, docSoTienBangChu, getUserCompanyId, getRevenueAttributes, getBrandName, getCompanyName, getCustomerName, getUserById, getUserDisplayName, getPricelistName } from '../utils.js';
import { dbSaveOrder, dbCreateQuickCustomer, dbConfirmOrder, dbAmendOrder, dbFetchOrderDebtSnapshot, dbLoadCustomerAssignedPricing, dbRefreshCustomerFinancialState, dbRefreshOrderById, cacheOrdersLocally, isCloudActive } from '../services/supabase.js?v=20260814-invoice-discount-label-v19';
import { renderAll, switchTab } from '../main.js?v=20260814-invoice-discount-label-v19';
import { populatePricelistsDropdowns } from './pricelists.js';
import { generateUniqueCustomerCode } from './customers.js?v=20260814-invoice-discount-label-v19';
import { addCashbookTransaction } from './so_quy.js?v=20260814-invoice-discount-label-v19';
import { getApplicablePriceList, resolveCustomerProductPrice, normalizePriceListType, PRICE_LIST_TYPES, filterPriceListsForUser, canUserViewPriceList, canUserUsePriceListForCustomer, isDealerPrivatePriceList, isUsableResolvedPrice, shouldOverrideWithGlobalCustomerPriceList } from '../domain/pricing.js?v=20260814-invoice-discount-label-v19';
import { normalizeCustomerPhone } from '../domain/customer-query.js';
import { isPrintOnlyPriceList, requiresOrderSaveApproval, supportsInvoiceLineDiscount } from '../domain/invoice-discount.js?v=20260814-invoice-discount-label-v19';
import { buildProductFamilies, buildVariantSnapshot, searchProductFamilies, shouldAutoSelectVariant, variantSpecification } from '../domain/product-catalog.js';
import { chargeCustomerDebt, getOrderDebtSnapshot, getOrderOutstandingAmount } from '../domain/customer-debt.js?v=20260814-invoice-discount-label-v19';
import { getOrderDisplayCode } from '../domain/order-display.js';
import { canAdjustOrderBusinessDate, currentBusinessDateInputValue, parseOrderBusinessDateInput } from '../domain/order-business-date.js';
import { reorderOrderItems } from '../domain/order-edit.js';

let currentOrderToPrint = null;
let lastFinalizedOrder = null;
let isSavingOrder = false;
let selectedProductFamilyKey = '';
const ORDER_IDEMPOTENCY_STORAGE_KEY = 'billing_pending_order_idempotency_key';
const ORDER_PENDING_ID_STORAGE_KEY = 'billing_pending_order_id';

function abbreviateSalesPosition(position = '') {
  const raw = String(position || '').trim();
  if (/^[A-ZĐ]{2,8}$/u.test(raw)) return raw;
  const normalized = raw.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').toLowerCase();
  if (normalized.includes('giam doc') && normalized.includes('kinh doanh')) return 'GĐKD';
  if (normalized.includes('truong phong') && normalized.includes('kinh doanh')) return 'TPKD';
  if (normalized.includes('pho phong') && normalized.includes('kinh doanh')) return 'PPKD';
  return 'NVKD';
}

function formatSalesManagerPrintLabel(managerId) {
  const manager = getUserById(managerId, state.users);
  const managerName = getUserDisplayName(managerId, managerId || 'N/A', state.users);
  return `${abbreviateSalesPosition(manager?.position)}: ${managerName}`;
}

export function syncInvoiceBusinessDateControl(value = null, isReadOnly = false) {
  const group = document.getElementById('invoice-business-date-group');
  const input = document.getElementById('invoice-business-date');
  if (!group || !input) return;
  const allowed = canAdjustOrderBusinessDate(state.currentUser);
  group.style.display = allowed ? 'block' : 'none';
  input.disabled = !allowed || isReadOnly;
  input.max = currentBusinessDateInputValue();
  input.value = value || input.value || currentBusinessDateInputValue();
}

function createClientUuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function getPendingOrderIdentity() {
  let key = sessionStorage.getItem(ORDER_IDEMPOTENCY_STORAGE_KEY);
  let orderId = sessionStorage.getItem(ORDER_PENDING_ID_STORAGE_KEY);
  // Older builds stored only the key and generated a different order id on
  // every click. Rotate that incomplete legacy pair once to prevent a 409.
  if (!key || !orderId) {
    key = createClientUuid();
    orderId = `DRAFT-${createClientUuid()}`;
    sessionStorage.setItem(ORDER_IDEMPOTENCY_STORAGE_KEY, key);
    sessionStorage.setItem(ORDER_PENDING_ID_STORAGE_KEY, orderId);
  }
  return { key, orderId };
}

function clearPendingOrderIdempotencyKey() {
  sessionStorage.removeItem(ORDER_IDEMPOTENCY_STORAGE_KEY);
  sessionStorage.removeItem(ORDER_PENDING_ID_STORAGE_KEY);
}

export function getActiveInvoiceDiscount(brand) {
  // Bảng giá mới lưu đơn giá SKU trực tiếp. Chiết khấu dòng là nghiệp vụ riêng,
  // không còn được suy ra từ brand_discounts của bảng giá cũ.
  return 0;
}

function activeInvoicePriceListSupportsDiscount() {
  const selectedId = document.getElementById('invoice-pricelist-select')?.value || '';
  if (!selectedId || selectedId === 'retail') return false;
  const priceLists = [...(state.allPricelists || []), ...(state.pricelists || [])];
  const selected = priceLists.find(priceList => String(priceList.id) === String(selectedId));
  if (supportsInvoiceLineDiscount(selected)) return true;

  // Legacy drafts may only retain the price-list name on each line.
  return (state.invoiceItems || []).some(item => String(item.priceListName || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes('thi truong'));
}

function getProductId(product) {
  return product.id || product.code;
}

function getOrderItemVariantCode(item) {
  return item.variantCode || item.variantCodeSnapshot || item.productCode || item.code || '';
}

function getOrderItemSpecification(item) {
  const immutableSnapshot = item.specificationSnapshot || item.weightOrVolumeSnapshot;
  if (immutableSnapshot) return immutableSnapshot;

  const directParts = [
    item.packagingName || item.packagingNameSnapshot || item.package,
    item.weightOrVolume ?? item.packageWeight,
    item.unitName || item.packageWeightUnit
  ].filter(value => value !== null && value !== undefined && value !== '');
  if (directParts.length > 1) return directParts.join(' ').trim();

  const variant = (state.products || []).find(product =>
    (item.variantId && product.id === item.variantId) ||
    product.code === getOrderItemVariantCode(item)
  );
  if (variant) {
    const currentSpecification = variantSpecification(variant);
    if (currentSpecification) return currentSpecification;

    const legacyPackage = item.package;
    if (legacyPackage === 'Bo') {
      return [
        variant.weightLon ? `Lon: ${variant.weightLon}` : '',
        variant.weightBao ? `Bao: ${variant.weightBao}` : ''
      ].filter(Boolean).join(' + ') || 'Bộ';
    }
    const legacyWeights = {
      Thung: variant.weightThung,
      Lon: variant.weightLon,
      Hop: variant.weightHop,
      Bao: variant.weightBao,
      Tui: variant.weightTui
    };
    const legacyLabels = { Thung: 'Thùng', Lon: 'Lon', Hop: 'Hộp', Bao: 'Bao', Tui: 'Túi' };
    if (legacyPackage && (legacyWeights[legacyPackage] || legacyLabels[legacyPackage])) {
      return [legacyLabels[legacyPackage] || legacyPackage, legacyWeights[legacyPackage]].filter(Boolean).join(' ');
    }
  }
  return directParts.join(' ').trim() || 'N/A';
}

function resolveProductPrice(product) {
  const productId = getProductId(product);
  const selectedId = document.getElementById('invoice-pricelist-select')?.value || '';
  const customer = state.activeCustomerId ? state.customers.find(c => c.id === state.activeCustomerId) : null;
  if (selectedId === 'retail') {
    return { status: 'missing', price: null, priceListId: null, priceListName: '', source: 'manual_override' };
  }
  const customerForPricing = isExplicitInvoicePriceListOverride() && selectedId ? null : customer;
  // Bảng giá gán cho khách có thể là bảng nội bộ/legacy và không nằm trong
  // dropdown của Sale, nhưng vẫn phải được dùng để tính giá của khách đó.
  const priceListsForPricing = customerForPricing
    ? (state.allPricelists.length ? state.allPricelists : state.pricelists)
    : filterPriceListsForUser(state.pricelists, state.currentUser);
  return resolveCustomerProductPrice({
    productId,
    customer: customerForPricing,
    requestedPriceListId: selectedId,
    priceLists: priceListsForPricing,
    priceListItems: customerForPricing && state.allPriceListItems.length
      ? state.allPriceListItems
      : state.priceListItems
  });
}

function isExplicitInvoicePriceListOverride() {
  const select = document.getElementById('invoice-pricelist-select');
  return Boolean(
    select?.dataset.explicitOverride === 'true'
    && select.value
    && select.value !== 'retail'
  );
}

function getSelectedInvoicePriceListId() {
  return document.getElementById('invoice-pricelist-select')?.value || '';
}

function getSelectedInvoicePriceList() {
  const selectedId = getSelectedInvoicePriceListId();
  return selectedId && selectedId !== 'retail'
    ? (state.pricelists || []).find(priceList => priceList.id === selectedId) || null
    : null;
}

function isPrintOnlyInvoiceMode() {
  if (isPrintOnlyPriceList(getSelectedInvoicePriceList())) return true;
  const priceLists = [...(state.allPricelists || []), ...(state.pricelists || [])];
  return (state.invoiceItems || []).some(item => {
    const priceList = priceLists.find(candidate => String(candidate.id) === String(item.priceListId || ''));
    return isPrintOnlyPriceList(priceList);
  });
}

function syncInvoicePersistenceActions() {
  const printOnly = isPrintOnlyInvoiceMode();
  const saveBtn = document.getElementById('btn-save-order');
  const draftBtn = document.getElementById('btn-draft-order');
  const notice = document.getElementById('invoice-print-only-notice');
  [saveBtn, draftBtn].forEach(button => {
    if (!button || button.style.display === 'none' || isSavingOrder) return;
    button.disabled = printOnly;
    button.title = printOnly ? 'Bảng giá này chỉ được phép in, chưa được Kế toán cho phép lưu.' : '';
  });
  if (notice) notice.style.display = printOnly ? 'block' : 'none';
}

function isManualInvoicePriceMode() {
  return getSelectedInvoicePriceListId() === 'retail';
}

function canApproveManualInvoicePricing() {
  return ['admin', 'accounting'].includes(state.currentUser?.role);
}

function isTradeTermsDiscountPriceList(priceList = getSelectedInvoicePriceList()) {
  const label = `${priceList?.name || ''} ${priceList?.code || ''}`.toLowerCase();
  return label.includes('tt 20/07/2026') || label.includes('tt 20-07-2026') || label.includes('tt 20.07.2026');
}

function isUsingCustomerDefaultPriceList(customer) {
  if (!customer) return true;
  const selectedId = getSelectedInvoicePriceListId();
  if (!selectedId || selectedId === 'retail') return false;
  const applicable = getApplicablePriceList(
    customer,
    state.allPricelists.length ? state.allPricelists : state.pricelists
  );
  return applicable.priceList?.id === selectedId;
}

function canPersistCurrentInvoicePricing(customerOverride = null) {
  // Admin and Accounting may deliberately use the manual-price workflow for
  // an existing customer. Sale keeps the existing customer price-list rules.
  if (isManualInvoicePriceMode() && canApproveManualInvoicePricing()) return true;
  if (isExplicitInvoicePriceListOverride()) {
    const selected = getSelectedInvoicePriceList();
    const isApprovedRestrictedList = requiresOrderSaveApproval(selected)
      && selected?.isPrintOnly === false;
    return Boolean(
      selected
      && (
        normalizePriceListType(selected.type, selected.customerId) === PRICE_LIST_TYPES.GENERAL
        || isApprovedRestrictedList
      )
      && !selected.customerId
      && !selected.customerGroupId
      && canUserViewPriceList(state.currentUser, selected)
    );
  }
  const activeCustomerId = customerOverride?.id || state.activeCustomerId;
  if (!activeCustomerId || (state.isQuickCustomerMode && !customerOverride)) return true;
  const customer = customerOverride
    || state.customers.find(item => item.id === activeCustomerId);
  return isUsingCustomerDefaultPriceList(customer);
}

function shouldRequestAuthoritativePriceListOverride() {
  const selected = getSelectedInvoicePriceList();
  if (!selected || isPrintOnlyPriceList(selected)) return false;
  const customer = state.activeCustomerId
    ? state.customers.find(item => item.id === state.activeCustomerId)
    : null;
  return shouldOverrideWithGlobalCustomerPriceList({
    priceList: selected,
    customer,
    explicitlySelected: isExplicitInvoicePriceListOverride()
  });
}

function getInvoiceProductFamilies() {
  let variants = (state.products || []).filter(product =>
    product?.id &&
    product.packageType &&
    !product.isLegacy &&
    product.isActive !== false
  );
  if (state.activeCustomerBrand && state.activeCustomerBrand !== 'Tất cả') {
    variants = variants.filter(product => {
      const brand = String(product.brand || '').toLowerCase().replace(/\s+/g, '');
      const isFestiva = brand === 'festivanano' || brand === 'festiva';
      return isFestiva || product.brand === state.activeCustomerBrand;
    });
  }
  return buildProductFamilies(variants);
}

function closeVariantPicker() {
  document.getElementById('invoice-variant-modal')?.classList.remove('active');
  document.body.classList.remove('invoice-variant-open');
}

function addVariantToInvoice(variant) {
  if (!variant?.id || !variant.packageType || variant.isLegacy || variant.isActive === false) {
    showToast('Quy cách này đã ngừng áp dụng hoặc không hợp lệ.', 'warning');
    return false;
  }

  const resolvedPrice = resolveProductPrice(variant);
  if (!isUsableResolvedPrice(resolvedPrice)) {
    showToast(`SKU "${variant.code}" chưa có giá trong bảng giá đang áp dụng.`, 'warning');
    return false;
  }

  const price = Number(resolvedPrice.price);
  const snapshot = buildVariantSnapshot(variant);
  state.invoiceItems.push({
    product: variant,
    ...snapshot,
    brand: variant.brand || 'Nano10*',
    package: snapshot.packagingName,
    packageWeight: snapshot.weightOrVolume,
    colorCode: '',
    colorPercent: 0,
    quantity: 1,
    discountPercent: getActiveInvoiceDiscount(variant.brand),
    price,
    unitPrice: price,
    listPrice: price,
    priceListId: resolvedPrice.priceListId,
    priceListName: resolvedPrice.priceListName,
    priceSource: resolvedPrice.source,
    notes: ''
  });

  showToast(`Đã thêm ${variant.code} - ${variantSpecification(variant)}.`);
  closeVariantPicker();
  const searchInput = document.getElementById('invoice-product-search');
  if (searchInput) {
    searchInput.value = '';
    searchInput.removeAttribute('data-selected-family-key');
    searchInput.removeAttribute('data-matched-variant-id');
  }
  selectedProductFamilyKey = '';
  renderInvoiceTable();
  searchInput?.focus();
  return true;
}

function openVariantPicker(family, preferredVariantId = '') {
  if (!family) return;
  if (shouldAutoSelectVariant(family)) {
    addVariantToInvoice(family.variants.find(variant => variant.isActive !== false));
    return;
  }

  const modal = document.getElementById('invoice-variant-modal');
  const options = document.getElementById('invoice-variant-options');
  if (!modal || !options) return;
  document.getElementById('invoice-variant-base-code').textContent = family.baseCode;
  document.getElementById('invoice-variant-modal-title').textContent = family.name;
  document.getElementById('invoice-variant-brand').textContent = `${family.brand} • Có ${family.variants.length} quy cách`;

  options.innerHTML = family.variants.map(variant => {
    const price = resolveProductPrice(variant);
    const hasPrice = isUsableResolvedPrice(price);
    return `
      <button
        type="button"
        class="variant-choice ${variant.id === preferredVariantId ? 'highlighted' : ''}"
        data-variant-id="${variant.id}"
        ${hasPrice ? '' : 'disabled'}
      >
        <span class="variant-choice-main">
          <span class="variant-choice-spec">${variantSpecification(variant)}</span>
          <span class="variant-choice-code">Mã SKU: ${variant.code}</span>
        </span>
        <span class="variant-choice-meta">
          <span class="variant-choice-price">${hasPrice ? formatCurrency(Number(price.price)) : 'Chưa có giá'}</span>
        </span>
      </button>
    `;
  }).join('');

  options.querySelectorAll('.variant-choice[data-variant-id]').forEach(button => {
    button.addEventListener('click', () => {
      const variant = family.variants.find(item => item.id === button.dataset.variantId);
      if (variant) addVariantToInvoice(variant);
    });
  });
  modal.classList.add('active');
  document.body.classList.add('invoice-variant-open');
  safeCreateIcons();
}

export function applyActivePriceListToInvoice() {
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (!plSelect) return;
  const customer = state.activeCustomerId ? state.customers.find(item => item.id === state.activeCustomerId) : null;
  const requestedId = plSelect.value && plSelect.value !== 'retail' ? plSelect.value : '';
  const customerForPricing = isExplicitInvoicePriceListOverride() && requestedId ? null : customer;
  const visibleLists = customerForPricing
    ? (state.allPricelists.length ? state.allPricelists : state.pricelists)
    : filterPriceListsForUser(state.pricelists, state.currentUser);
  const applicable = getApplicablePriceList(customerForPricing, visibleLists, requestedId);
  const activePriceList = applicable.priceList;
  if (customer && activePriceList && plSelect.value !== 'retail' && !isExplicitInvoicePriceListOverride()) {
    plSelect.value = activePriceList.id;
  }
  
  state.invoiceItems.forEach((item, index) => {
    item.discountPercent = getActiveInvoiceDiscount(item.brand);
    if (item.priceSource === 'manual_override' && isManualInvoicePriceMode()) return;
    const resolved = resolveProductPrice(item.product);
    if (resolved.source === 'manual_override') {
      item.priceSource = 'manual_override';
      item.priceListId = null;
      item.priceListName = '';
      return;
    }
    if (isUsableResolvedPrice(resolved)) {
      item.unitPrice = Number(resolved.price);
      item.listPrice = Number(resolved.price);
      item.priceListId = resolved.priceListId;
      item.priceListName = resolved.priceListName;
      item.priceSource = resolved.source;
      recalculateItemPriceWithColorMarkup(index);
    } else {
      item.priceSource = 'missing';
    }
  });
  
  const label = document.getElementById('invoice-pricelist-source-lbl');
  if (label) {
    if (!activePriceList) {
      label.innerText = 'Chưa xác định';
      label.style.background = 'rgba(156, 163, 175, 0.1)';
      label.style.color = '#9ca3af';
    } else if (plSelect.value === 'retail') {
      label.innerText = 'Nhập tay';
      label.style.background = 'rgba(16, 185, 129, 0.1)';
      label.style.color = '#10b981';
    } else {
      const type = normalizePriceListType(activePriceList.type, activePriceList.customerId);
      label.innerText = type === PRICE_LIST_TYPES.DEALER_PRIVATE
        ? (state.currentUser?.role === 'sale' ? 'Bảng giá đang áp dụng' : `Giá riêng đại lý: ${activePriceList.name}`)
        : `Bảng giá đang áp dụng: ${activePriceList.name}`;
      label.style.background = 'rgba(245, 158, 11, 0.1)';
      label.style.color = '#f59e0b';
    }
  }
  
  renderInvoiceTable();
}

export function renderInvoiceTable() {
  const tableBody = document.getElementById('invoice-items-body');
  if (!tableBody) return;
  
  populateQuickCustomerManagerDropdown();
  syncInvoicePersistenceActions();

  const manualPriceMode = isManualInvoicePriceMode();
  const showLineDiscount = activeInvoicePriceListSupportsDiscount();
  const discountColumn = document.getElementById('invoice-discount-col');
  const discountHeader = document.getElementById('invoice-discount-header');
  if (discountColumn) discountColumn.style.display = showLineDiscount ? '' : 'none';
  if (discountHeader) discountHeader.style.display = showLineDiscount ? '' : 'none';
  const adjustmentHeader = document.querySelector('.invoice-items-table thead th:nth-child(6)');
  if (adjustmentHeader) adjustmentHeader.innerText = showLineDiscount ? 'Giá thị trường' : 'Đơn giá';
  
  if (state.invoiceItems.length === 0) {
    tableBody.innerHTML = `
      <tr id="invoice-empty-row">
        <td colspan="${showLineDiscount ? 10 : 9}" style="text-align: center; color: var(--text-muted); padding: 3rem;">
          Chưa chọn sản phẩm nào. Tìm kiếm sản phẩm ở trên để thêm vào hóa đơn.
        </td>
      </tr>
    `;
    calculateInvoiceTotals();
    return;
  }
  
  // Read readonly mode
  const saveBtn = document.getElementById('btn-save-order');
  const isReadOnly = saveBtn && saveBtn.style.display === 'none';

  tableBody.innerHTML = state.invoiceItems.map((item, index) => {
    const p = item.product || {};
    const productName = String(p.name || `Sản phẩm ${index + 1}`);

    const subTotal = item.quantity * item.price * (1 - item.discountPercent / 100);
    
    const disabledAttr = isReadOnly ? 'disabled' : '';

    const effectiveUnitPrice = Math.round((item.price || 0) * (1 - (item.discountPercent || 0) / 100));
    const adjustmentCellHtml = manualPriceMode
      ? `<input type="text" class="form-control-inline item-manual-price" value="${formatNumber(item.unitPrice ?? item.listPrice ?? item.price ?? 0)}" title="Nhập đơn giá gốc; phụ thu màu được cộng tự động" style="width: 80px; text-align: right;" ${disabledAttr}>`
      : showLineDiscount
        ? `<span class="invoice-market-unit-price" title="Giá trước chiết khấu">${formatNumber(item.price || 0)}</span>`
        : `<span class="invoice-effective-unit-price" title="Đơn giá sau chiết khấu">${formatNumber(effectiveUnitPrice)}</span>`;

    // Kiểm tra sản phẩm sơn lót hoặc bột bả (loại trừ trường hợp sơn giả đá)
    const nameLower = productName.toLowerCase();
    const isPrimerOrPutty = (nameLower.includes('lót') || nameLower.includes('bả')) && !nameLower.includes('giả đá');
    if (isPrimerOrPutty) {
      item.colorCode = '';
      item.colorPercent = 0;
    }

    return `
      <tr class="invoice-item-row" data-index="${index}">
        <td style="font-weight: 600; color: #fff;">
          <div class="invoice-product-code-cell">
            <button type="button" class="invoice-item-drag-handle" data-index="${index}" title="Kéo để đổi vị trí sản phẩm" aria-label="Kéo để đổi vị trí sản phẩm ${productName}" ${isReadOnly ? 'disabled' : 'draggable="true"'}>
              <i data-lucide="grip-vertical"></i>
            </button>
            <span>${p.code}</span>
          </div>
        </td>
        <td>
          <div class="flex flex-col gap-1">
            <span style="font-weight: 500; font-size: 0.85rem;">${productName}</span>
            <div class="flex gap-2 items-center" style="margin-top: 2px;">
              <span class="suggestion-brand-badge" style="font-size: 0.65rem; padding: 1px 6px; border-radius: 4px; background: rgba(34, 197, 94, 0.1); color: #22c55e; border: 1px solid rgba(34, 197, 94, 0.2);">${item.brand}</span>
            </div>
          </div>
        </td>
        <td style="text-align: center; position: relative;">
          <input type="text" class="form-control-inline item-color-code" value="${isPrimerOrPutty ? '' : item.colorCode}" placeholder="${isPrimerOrPutty ? 'Không dùng' : 'Nhập mã'}" style="width: 100%; text-align: center;" ${isReadOnly || isPrimerOrPutty ? 'disabled' : ''}>
          <div style="position: absolute; bottom: 2px; left: 0; right: 0; font-size: 0.65rem; color: var(--text-muted); font-weight: 600; text-align: center; line-height: 1; pointer-events: none;">
            ${isPrimerOrPutty ? '<span style="color: var(--text-muted); font-weight: normal;">N/A</span>' : `+<span class="item-color-percent-lbl" style="color: var(--color-primary); font-weight: 700;">${item.colorPercent}</span>% màu`}
          </div>
        </td>
        <td>
          <span class="invoice-variant-display">
            ${variantSpecification(p) || item.package}
            <small>${item.variantCode || p.code}</small>
          </span>
        </td>
        <td style="text-align: right;">
          <input type="number" class="form-control-inline item-quantity" value="${item.quantity}" min="1" style="width: 55px; text-align: center; font-weight: 600;" ${disabledAttr}>
        </td>
        <td style="text-align: center;">
          ${adjustmentCellHtml}
        </td>
        ${showLineDiscount ? `
        <td style="text-align: center;">
          <input type="number" class="form-control-inline item-discount" value="${Number(item.discountPercent || 0)}" min="0" max="100" step="0.01" style="width: 72px; text-align: center; font-weight: 600;" ${disabledAttr}>
        </td>` : ''}
        <td>
          <input type="text" class="form-control-inline item-notes" value="${item.notes}" placeholder="VD: Màu pha đậm..." style="width: 100%; font-size: 0.75rem;" ${disabledAttr}>
        </td>
        <td class="invoice-line-total" style="text-align: right; font-weight: 600; color: #fff; font-size: 0.9rem;">
          ${formatCurrency(subTotal)}
        </td>
        <td style="text-align: center;">
          <button class="btn btn-danger btn-xs btn-circle btn-remove-invoice-item" data-index="${index}" title="Xóa dòng" ${disabledAttr}>
            <i data-lucide="x" style="width: 12px; height: 12px;"></i>
          </button>
        </td>
      </tr>
    `;
  }).join('');
  
  // Trình hỗ trợ cập nhật cục bộ Thành tiền của dòng để tránh vẽ lại toàn bộ bảng (gây mất focus và mất sự kiện click chốt đơn)
  const updateRowSubtotal = (row, idx) => {
    const item = state.invoiceItems[idx];
    const subTotal = Math.round(item.quantity * item.price * (1 - item.discountPercent / 100));
    const totalCell = row?.querySelector('.invoice-line-total');
    if (totalCell) totalCell.innerText = formatCurrency(subTotal);
  };

  const updateRowUnitPrice = (row, idx) => {
    const item = state.invoiceItems[idx];
    const manualPriceInput = row?.querySelector('.item-manual-price');
    if (manualPriceInput) {
      manualPriceInput.value = formatNumber(item.unitPrice ?? item.listPrice ?? item.price ?? 0);
    }
    const marketPrice = row?.querySelector('.invoice-market-unit-price');
    if (marketPrice) marketPrice.innerText = formatNumber(item.price || 0);
    const effectivePrice = row?.querySelector('.invoice-effective-unit-price');
    if (effectivePrice) {
      effectivePrice.innerText = formatNumber((item.price || 0) * (1 - (item.discountPercent || 0) / 100));
    }
  };

  // Gán sự kiện cho các ô nhập liệu trong bảng
  document.querySelectorAll('.item-color-code').forEach(input => {
    input.addEventListener('change', (e) => {
      const row = e.target.closest('tr');
      const idx = parseInt(row.getAttribute('data-index'));
      const colorCode = e.target.value.trim().toUpperCase();
      state.invoiceItems[idx].colorCode = colorCode;
      
      const colorPct = getColorPercentFromCode(colorCode);
      state.invoiceItems[idx].colorPercent = colorPct;
      
      // Cập nhật nhãn màu cộng thêm trên dòng
      const pctLbl = row.querySelector('.item-color-percent-lbl');
      if (pctLbl) pctLbl.innerText = colorPct;
      
      // Tính lại đơn giá có bao gồm tiền màu cộng thêm
      recalculateItemPriceWithColorMarkup(idx);
      updateRowUnitPrice(row, idx);
      updateRowSubtotal(row, idx);
      calculateInvoiceTotals();
    });
  });

  document.querySelectorAll('.item-quantity').forEach(input => {
    input.addEventListener('change', (e) => {
      const row = e.target.closest('tr');
      const idx = parseInt(row.getAttribute('data-index'));
      let qty = parseInt(e.target.value);
      if (isNaN(qty) || qty < 1) qty = 1;
      e.target.value = qty; // Cập nhật lại giá trị hiển thị trên ô nhập
      state.invoiceItems[idx].quantity = qty;
      
      updateRowSubtotal(row, idx);
      calculateInvoiceTotals();
    });
  });

  document.querySelectorAll('.item-discount').forEach(input => {
    input.addEventListener('input', (e) => {
      const row = e.target.closest('tr');
      const idx = parseInt(row.getAttribute('data-index'));
      let disc = parseFloat(e.target.value);
      if (isNaN(disc) || disc < 0) disc = 0;
      if (disc > 100) disc = 100;
      e.target.value = disc; // Cập nhật lại giá trị hiển thị trên ô nhập
      state.invoiceItems[idx].discountPercent = disc;
      
      updateRowUnitPrice(row, idx);
      updateRowSubtotal(row, idx);
      calculateInvoiceTotals();
    });
  });

  document.querySelectorAll('.item-manual-price').forEach(input => {
    input.addEventListener('change', (e) => {
      const row = e.target.closest('tr');
      const idx = parseInt(row.getAttribute('data-index'));
      const value = parseInt(String(e.target.value || '').replace(/\D/g, ''), 10) || 0;
      const price = Math.max(0, value);
      const item = state.invoiceItems[idx];
      item.unitPrice = price;
      item.listPrice = price;
      item.discountPercent = 0;
      item.priceSource = 'manual_override';
      item.priceListId = null;
      item.priceListName = '';
      recalculateItemPriceWithColorMarkup(idx);
      updateRowUnitPrice(row, idx);

      updateRowSubtotal(row, idx);
      calculateInvoiceTotals();
    });
  });

  document.querySelectorAll('.item-notes').forEach(input => {
    input.addEventListener('input', (e) => {
      const idx = parseInt(e.target.closest('tr').getAttribute('data-index'));
      state.invoiceItems[idx].notes = e.target.value;
    });
  });

  document.querySelectorAll('.btn-remove-invoice-item').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const idx = parseInt(btn.getAttribute('data-index'));
      state.invoiceItems.splice(idx, 1);
      renderInvoiceTable();
    });
  });

  let draggedItemIndex = null;
  const clearDragIndicators = () => {
    tableBody.querySelectorAll('.invoice-item-row').forEach(row => {
      row.classList.remove('is-dragging', 'drag-drop-before', 'drag-drop-after');
    });
  };

  tableBody.querySelectorAll('.invoice-item-drag-handle[draggable="true"]').forEach(handle => {
    handle.addEventListener('dragstart', event => {
      draggedItemIndex = Number(handle.dataset.index);
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', String(draggedItemIndex));
      handle.closest('.invoice-item-row')?.classList.add('is-dragging');
    });

    handle.addEventListener('dragend', () => {
      draggedItemIndex = null;
      clearDragIndicators();
    });
  });

  tableBody.querySelectorAll('.invoice-item-row').forEach(row => {
    row.addEventListener('dragover', event => {
      if (!Number.isInteger(draggedItemIndex)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const targetIndex = Number(row.dataset.index);
      clearDragIndicators();
      row.classList.add(event.clientY >= row.getBoundingClientRect().top + row.offsetHeight / 2
        ? 'drag-drop-after'
        : 'drag-drop-before');
      tableBody.querySelector(`.invoice-item-row[data-index="${draggedItemIndex}"]`)?.classList.add('is-dragging');
    });

    row.addEventListener('drop', event => {
      if (!Number.isInteger(draggedItemIndex)) return;
      event.preventDefault();
      const targetIndex = Number(row.dataset.index);
      const placeAfter = row.classList.contains('drag-drop-after');
      let destinationIndex = targetIndex + (placeAfter ? 1 : 0);
      if (draggedItemIndex < destinationIndex) destinationIndex -= 1;
      destinationIndex = Math.max(0, Math.min(state.invoiceItems.length - 1, destinationIndex));

      const reordered = reorderOrderItems(state.invoiceItems, draggedItemIndex, destinationIndex);
      draggedItemIndex = null;
      clearDragIndicators();
      if (reordered !== state.invoiceItems) {
        state.invoiceItems = reordered;
        renderInvoiceTable();
      }
    });
  });

  calculateInvoiceTotals();
  safeCreateIcons();
}

function recalculateItemPriceWithColorMarkup(index) {
  const item = state.invoiceItems[index];
  const p = item.product || {};
  
  // unitPrice/listPrice luôn là giá gốc đang áp dụng. Giá catalog cũ chỉ là
  // phương án dự phòng cho dữ liệu legacy chưa có snapshot giá gốc.
  let basePrice = item.unitPrice ?? item.listPrice;
  if (basePrice === null || basePrice === undefined || !Number.isFinite(Number(basePrice))) {
    if (item.package === 'Bo') basePrice = p.priceLon || p.priceThung || p.price || 0;
    else if (item.package === 'Thung') basePrice = p.priceThung || p.price || 0;
    else if (item.package === 'Lon') basePrice = p.priceLon || 0;
    else if (item.package === 'Hop') basePrice = p.priceHop || 0;
    else if (item.package === 'Bao') basePrice = p.priceBao || 0;
    else if (item.package === 'Tui') basePrice = p.priceTui || 0;
    else basePrice = item.price ?? 0;
  }
  
  // Cộng thêm phần trăm tiền màu nếu có và làm tròn số nguyên cho công nợ/tiền hàng chuẩn VND
  item.price = calculateColorMarkedUpPrice(basePrice, item.colorPercent);
}

export function parseDiscountOrFeeInput(inputId, typeId) {
  const inputEl = document.getElementById(inputId);
  const typeSelectEl = document.getElementById(typeId);
  if (!inputEl) return { value: 0, type: 'amount' };
  
  const type = typeSelectEl ? typeSelectEl.value : 'amount';
  const valStr = inputEl.value || '0';
  
  if (type === 'percent') {
    let num = parseFloat(valStr.replace(/[^0-9.]/g, '')) || 0;
    if (num < 0) num = 0;
    if (num > 100) num = 100;
    return { value: num, type: 'percent' };
  } else {
    let num = parseInt(valStr.replace(/\D/g, ''), 10) || 0;
    if (num < 0) num = 0;
    return { value: num, type: 'amount' };
  }
}

function handleDiscountOrFeeInputChange(inputEl, typeSelectEl) {
  const isPercent = typeSelectEl.value === 'percent';
  let valStr = inputEl.value;

  if (isPercent) {
    valStr = valStr.replace(/[^0-9.]/g, '');
    const parts = valStr.split('.');
    if (parts.length > 2) {
      valStr = parts[0] + '.' + parts.slice(1).join('');
    }
    let num = parseFloat(valStr);
    if (!isNaN(num)) {
      if (num < 0) num = 0;
      if (num > 100) num = 100;
      valStr = num.toString();
    } else if (valStr !== '' && valStr !== '.') {
      valStr = '0';
    }
    inputEl.value = valStr;
  } else {
    let rawDigits = valStr.replace(/\D/g, '');
    if (!rawDigits) {
      inputEl.value = '0';
    } else {
      let num = parseInt(rawDigits, 10);
      if (isNaN(num) || num < 0) num = 0;
      inputEl.value = formatNumber(num);
    }
  }
  calculateInvoiceTotals();
}

export function calculateInvoiceTotals() {
  let totalQty = 0;
  let totalMarket = 0;
  let totalProductSubtotal = 0;
  
  state.invoiceItems.forEach(item => {
    const originalPrice = item.price; 
    const qty = item.quantity;
    const disc = item.discountPercent;
    
    // Làm tròn các giá trị tiền tệ về số nguyên VND
    const originalSubtotal = Math.round(qty * originalPrice);
    const discountedSubtotal = Math.round(originalSubtotal * (1 - disc / 100));
    
    totalQty += qty;
    totalMarket += originalSubtotal;
    totalProductSubtotal += discountedSubtotal;
  });
  
  const totalDiscount = Math.round(totalMarket - totalProductSubtotal);
  const subtotal = totalProductSubtotal; // Tạm tính = Tổng giá trị sản phẩm sau chiết khấu sản phẩm

  // 1. Tính Giảm giá
  const discData = parseDiscountOrFeeInput('invoice-discount-value', 'invoice-discount-type');
  let discountAmount = 0;
  if (discData.type === 'percent') {
    discountAmount = Math.round(subtotal * (discData.value / 100));
  } else {
    discountAmount = discData.value;
  }
  discountAmount = Math.max(0, discountAmount);

  const shippingFeeData = parseDiscountOrFeeInput('invoice-shipping-fee-value', null);
  const shippingFeeAmount = Math.max(0, shippingFeeData.value || 0);

  // Tiền cước khách nhờ thanh toán được cộng vào số còn phải thu.
  const orderTotal = Math.max(0, subtotal - discountAmount);
  const amountDue = Math.max(0, orderTotal + shippingFeeAmount);

  // Cập nhật lên UI với đúng ID trong index.html
  const qtyEl = document.getElementById('summary-total-qty');
  const marketEl = document.getElementById('summary-market-total');
  const discountEl = document.getElementById('summary-discount-total');
  const subtotalEl = document.getElementById('summary-subtotal');
  const discActualEl = document.getElementById('summary-discount-actual');
  const shippingFeeActualEl = document.getElementById('summary-shipping-fee-actual');
  const payableEl = document.getElementById('summary-final-total');
  const savingBadge = document.getElementById('summary-saving-badge');
  const crossedMarket = document.getElementById('summary-final-market-crossed');

  if (qtyEl) qtyEl.innerText = totalQty;
  if (marketEl) marketEl.innerText = formatCurrency(totalMarket);
  if (discountEl) discountEl.innerText = `-${formatCurrency(totalDiscount)}`;
  if (subtotalEl) subtotalEl.innerText = formatCurrency(subtotal);
  if (discActualEl) discActualEl.innerText = `-${formatCurrency(discountAmount)}`;
  if (shippingFeeActualEl) shippingFeeActualEl.innerText = `+${formatCurrency(shippingFeeAmount)}`;
  if (payableEl) payableEl.innerText = formatCurrency(amountDue);

  const totalCombinedDiscount = totalDiscount + discountAmount;
  if (savingBadge && crossedMarket) {
    if (totalMarket > 0 && totalCombinedDiscount > 0) {
      const savingPercent = ((totalCombinedDiscount / totalMarket) * 100).toFixed(0);
      savingBadge.innerText = `Tiết kiệm được ${savingPercent}%`;
      savingBadge.style.display = 'inline-block';
      
      crossedMarket.innerText = formatCurrency(totalMarket);
      crossedMarket.style.display = 'inline';
    } else {
      savingBadge.style.display = 'none';
      crossedMarket.style.display = 'none';
    }
  }
}

export async function addProductToInvoice() {
  const searchInput = document.getElementById('invoice-product-search');
  const query = searchInput?.value.trim() || '';
  if (!query) return;

  const families = getInvoiceProductFamilies();
  const selectedKey = searchInput.getAttribute('data-selected-family-key') || selectedProductFamilyKey;
  let family = selectedKey ? families.find(item => item.key === selectedKey) : null;
  let matchedVariantId = searchInput.getAttribute('data-matched-variant-id') || '';

  if (!family) {
    const matches = searchProductFamilies(families, query);
    if (matches.length === 1) {
      family = matches[0];
      matchedVariantId = matches[0].matchedVariantId || '';
    } else if (matches.length > 1) {
      showToast('Có nhiều sản phẩm phù hợp. Vui lòng chọn một sản phẩm trong danh sách.', 'warning');
      return;
    }
  }

  if (!family) {
    showToast(`Không tìm thấy sản phẩm phù hợp với "${query}".`, 'danger');
    return;
  }
  openVariantPicker(family, matchedVariantId);
}

export function compileActiveOrder(customerOverride = null) {
  if (state.invoiceItems.length === 0) {
    showToast('Vui lòng chọn ít nhất một sản phẩm vào hóa đơn!', 'danger');
    return null;
  }
  const missingPriceItem = state.invoiceItems.find(item => {
    const unitPrice = item.unitPrice ?? item.price;
    return item.priceSource === 'missing' || !Number.isFinite(Number(unitPrice)) || Number(unitPrice) < 0;
  });
  if (missingPriceItem) {
    showToast(`Sản phẩm "${missingPriceItem.product?.code || ''}" chưa có giá hợp lệ. Không thể chốt đơn.`, 'danger');
    return null;
  }
  
  let customerName = 'Khách hàng vãng lai';
  let phone = 'N/A';
  let address = 'N/A';
  let custId = null;
  let agencyBrand = 'Nano10*';
  let customerManagerId = '';
  
  if (customerOverride) {
    custId = customerOverride.id;
    customerName = customerOverride.name || 'Khách hàng';
    phone = customerOverride.phone || 'N/A';
    address = customerOverride.address || 'N/A';
    customerManagerId = customerOverride.managedBy || customerOverride.managed_by || '';
    if (customerOverride.assignedBrand && customerOverride.assignedBrand !== 'Tất cả') {
      agencyBrand = customerOverride.assignedBrand;
    }
  } else if (state.isQuickCustomerMode) {
    const qName = document.getElementById('quick-cust-name').value.trim();
    if (!qName) {
      showToast('Vui lòng nhập tên khách hàng mới!', 'danger');
      return null;
    }
    customerName = qName;
    phone = document.getElementById('quick-cust-phone').value.trim() || 'N/A';
    address = document.getElementById('quick-cust-address').value.trim() || 'N/A';
    custId = state.activeCustomerId || null;
    const qBrand = document.getElementById('quick-cust-assigned-brand');
    if (qBrand && qBrand.value && qBrand.value !== 'Tất cả') {
      agencyBrand = qBrand.value;
    }
    customerManagerId = document.getElementById('quick-cust-manager')?.value || '';
  } else if (state.activeCustomerId) {
    const cust = state.customers.find(c => c.id === state.activeCustomerId);
    if (cust) {
      custId = cust.id;
      customerName = cust.name;
      phone = cust.phone || 'N/A';
      address = cust.address || 'N/A';
      customerManagerId = cust.managedBy || cust.managed_by || '';
      if (cust.assignedBrand && cust.assignedBrand !== 'Tất cả') {
        agencyBrand = cust.assignedBrand;
      }
    }
  } else {
    const searchInput = document.getElementById('invoice-customer-search');
    if (searchInput && searchInput.value.trim() !== '') {
      customerName = searchInput.value.trim();
    } else {
      showToast('Vui lòng chọn khách hàng hoặc nhập thông tin chế độ "Khách lẻ" trước khi chốt đơn!', 'danger');
      return null;
    }
  }

  const companyId = getUserCompanyId(state.currentUser);

  // Tính các con số và làm tròn số nguyên VND để lưu trữ và hiển thị sạch sẽ
  let totalMarket = 0;
  let subtotal = 0;
  state.invoiceItems.forEach(item => {
    const originalSubtotal = Math.round(item.quantity * item.price);
    const discountedSubtotal = Math.round(originalSubtotal * (1 - item.discountPercent / 100));
    totalMarket += originalSubtotal;
    subtotal += discountedSubtotal;
  });
  
  const totalDiscount = Math.round(totalMarket - subtotal);
  
  const discData = parseDiscountOrFeeInput('invoice-discount-value', 'invoice-discount-type');
  let discountAmount = 0;
  if (discData.type === 'percent') {
    discountAmount = Math.round(subtotal * (discData.value / 100));
  } else {
    discountAmount = discData.value;
  }
  discountAmount = Math.max(0, discountAmount);

  const shippingFeeData = parseDiscountOrFeeInput('invoice-shipping-fee-value', null);
  const shippingFeeAmount = Math.max(0, shippingFeeData.value || 0);

  const totalPayable = Math.max(0, subtotal - discountAmount);
  const paidAmount = 0;
  const amountDue = Math.max(0, totalPayable + shippingFeeAmount);

  const plSelect = document.getElementById('invoice-pricelist-select');
  const pricelistId = plSelect ? plSelect.value : 'retail';
  if (state.currentUser?.role === 'sale') {
    const orderCustomer = custId ? state.customers.find(customer => customer.id === custId) : null;
    const authorizedPriceLists = [...(state.allPricelists || []), ...(state.pricelists || [])];
    const selectedPriceListIds = new Set(state.invoiceItems.map(item => item.priceListId).filter(Boolean));
    if (pricelistId && pricelistId !== 'retail') selectedPriceListIds.add(pricelistId);
    const forbiddenId = [...selectedPriceListIds].find(id => {
      const priceList = authorizedPriceLists.find(item => item.id === id);
      return !priceList || !canUserUsePriceListForCustomer(state.currentUser, priceList, orderCustomer);
    });
    if (forbiddenId) {
      showToast('403: Bảng giá không được cấp quyền cho kinh doanh.', 'danger');
      return null;
    }
  }

  // Lấy ID đơn hàng đang chỉnh sửa (nếu là sửa đơn nháp)
  const saveBtn = document.getElementById('btn-save-order');
  const editOrderId = saveBtn ? saveBtn.getAttribute('data-edit-order-id') : null;
  const pendingOrderIdentity = getPendingOrderIdentity();
  
  // Keep both the request key and the temporary id stable across retries.
  // Final display numbers are still generated by the database.
  const orderId = editOrderId || pendingOrderIdentity.orderId;
  let orderDate = new Date().toISOString();
  if (canAdjustOrderBusinessDate(state.currentUser)) {
    const parsedOrderDate = parseOrderBusinessDateInput(document.getElementById('invoice-business-date')?.value);
    if (!parsedOrderDate.ok) {
      showToast(parsedOrderDate.message, 'danger');
      return null;
    }
    orderDate = parsedOrderDate.value;
  }

  // Đóng gói các dòng hoá đơn để lưu cùng với thuộc tính doanh thu Multi-Company
  const itemsToSave = state.invoiceItems.map(item => {
    const productBrand = item.brand || (item.product && item.product.brand) || 'Nano10*';
    const revAttrs = getRevenueAttributes(productBrand, agencyBrand, companyId, state.brands);
    const variantSnapshot = buildVariantSnapshot(item.product);
    const snapshot = {
      ...variantSnapshot,
      productGroupId: item.productGroupId || variantSnapshot.productGroupId,
      variantId: item.variantId || variantSnapshot.variantId,
      variantCode: item.variantCode || variantSnapshot.variantCode,
      baseCode: item.baseCode || variantSnapshot.baseCode,
      packagingName: item.packagingName || item.package || variantSnapshot.packagingName,
      weightOrVolume: item.weightOrVolume ?? item.packageWeight ?? variantSnapshot.weightOrVolume,
      unitName: item.unitName || variantSnapshot.unitName,
      specificationSnapshot: item.specificationSnapshot || variantSnapshot.specificationSnapshot
    };

    return {
      brand: productBrand,
      productId: snapshot.variantId || getProductId(item.product),
      productGroupId: snapshot.productGroupId,
      variantId: snapshot.variantId || getProductId(item.product),
      variantCode: snapshot.variantCode || item.product.code,
      baseCode: snapshot.baseCode,
      productCode: snapshot.variantCode || item.product.code,
      productName: item.product.name,
      package: snapshot.packagingName,
      packagingName: snapshot.packagingName,
      packageWeight: snapshot.weightOrVolume,
      packageWeightUnit: snapshot.unitName,
      unitName: snapshot.unitName,
      weightOrVolume: snapshot.weightOrVolume,
      weightOrVolumeSnapshot: [snapshot.weightOrVolume, snapshot.unitName]
        .filter(value => value !== null && value !== undefined && value !== '')
        .join(' '),
      specificationSnapshot: snapshot.specificationSnapshot,
      colorCode: item.colorCode || '',
      colorPercent: item.colorPercent || 0,
      quantity: item.quantity,
      discountPercent: item.discountPercent,
      price: item.price,
      unitPrice: item.unitPrice ?? item.price,
      listPrice: item.listPrice ?? item.price,
      priceListId: item.priceListId || pricelistId || '',
      priceListNameSnapshot: item.priceListName || state.pricelists.find(priceList => priceList.id === item.priceListId)?.name || '',
      priceSource: item.priceSource || 'manual',
      finalUnitPrice: Math.round(Number(item.price) * (1 - Number(item.discountPercent || 0) / 100)),
      priceSelectedBy: state.currentUser?.username || 'admin',
      notes: item.notes || '',
      companyId: companyId,
      productBrand: revAttrs.productBrand,
      agencyBrand: revAttrs.agencyBrand,
      revenueBrand: revAttrs.revenueBrand,
      revenueCompany: revAttrs.revenueCompany
    };
  });

  const order = {
    id: orderId,
    draftId: editOrderId || null,
    idempotencyKey: pendingOrderIdentity.key,
    companyId: companyId,
    customerId: custId,
    customerName,
    notes: document.getElementById('invoice-notes').value.trim(),
    items: itemsToSave,
    date: orderDate,
    totalMarket,
    totalDiscount,
    subtotal,
    discountValue: discData.value,
    discountType: discData.type,
    discountAmount: discountAmount,
    otherFeeValue: 0,
    otherFeeType: 'amount',
    otherFeeAmount: 0,
    shippingFeeValue: shippingFeeAmount,
    shippingFeeAmount,
    paidAmount,
    amountDue,
    totalPayable,
    pricelistId,
    priceListOverride: shouldRequestAuthoritativePriceListOverride(),
    priceListNameSnapshot: state.pricelists.find(priceList => priceList.id === pricelistId)?.name || '',
    priceSelectedBy: state.currentUser ? state.currentUser.username : 'admin',
    customerManagerId,
    createdBy: state.currentUser ? state.currentUser.username : 'admin'
  };

  return order;
}

export async function saveActiveOrder(status = 'settled') {
  if (isPrintOnlyInvoiceMode()) {
    showToast('Bảng giá này chỉ dùng để in và chưa được Kế toán cho phép lưu. Không thể lưu nháp, chốt đơn hoặc phát sinh công nợ.', 'warning');
    return null;
  }
  if (isSavingOrder) {
    console.warn("Lưu đơn hàng đang được thực hiện...");
    return null;
  }

  const saveBtn = document.getElementById('btn-save-order');
  const draftBtn = document.getElementById('btn-draft-order');

  const disableButtons = () => {
    if (saveBtn) {
      saveBtn.disabled = true;
      saveBtn.style.opacity = '0.5';
      saveBtn.style.cursor = 'not-allowed';
    }
    if (draftBtn) {
      draftBtn.disabled = true;
      draftBtn.style.opacity = '0.5';
      draftBtn.style.cursor = 'not-allowed';
    }
  };

  const enableButtons = () => {
    if (saveBtn) {
      saveBtn.disabled = false;
      saveBtn.style.opacity = '1';
      saveBtn.style.cursor = 'pointer';
    }
    if (draftBtn) {
      draftBtn.disabled = false;
      draftBtn.style.opacity = '1';
      draftBtn.style.cursor = 'pointer';
    }
  };

  isSavingOrder = true;
  disableButtons();
  let persistedOrderAfterCommit = null;

  try {
    let manualPricingApproved = false;
    if (isManualInvoicePriceMode() && canApproveManualInvoicePricing()) {
      const actionLabel = status === 'draft' ? 'lưu đơn nháp' : 'chốt đơn';
      manualPricingApproved = window.confirm(
        `Xác nhận ${actionLabel} với đơn giá nhập tay?\n\n`
        + 'Giá trị đơn hàng và công nợ (nếu chốt đơn) sẽ được tính theo các đơn giá này.'
      );
      if (!manualPricingApproved) return null;
    }

    let resolvedQuickCustomer = null;
    let reusedExistingQuickCustomer = false;
    
    // Xử lý tạo nhanh khách hàng mới nếu ở chế độ thêm nhanh
    if (state.isQuickCustomerMode) {
      const qName = document.getElementById('quick-cust-name').value.trim();
      const qPhone = document.getElementById('quick-cust-phone').value.trim();
      const cleanPhone = normalizeCustomerPhone(qPhone);
      const duplicateCustomer = cleanPhone
        ? state.customers.find(c => {
          const cPhone = normalizeCustomerPhone(c.phone);
          return cPhone === cleanPhone;
        })
        : null;

      if (duplicateCustomer) {
        // Reuse the existing profile without overwriting it. The order still
        // goes through the normal existing-customer pricing and permission checks.
        resolvedQuickCustomer = duplicateCustomer;
        reusedExistingQuickCustomer = true;
        state.activeCustomerId = duplicateCustomer.id;
        showToast(
          `Số điện thoại đã thuộc khách hàng ${duplicateCustomer.name} (${duplicateCustomer.code || duplicateCustomer.id}). Đơn hàng sẽ được lưu cho khách hàng này.`,
          'warning'
        );
      } else {
        if (!qName) {
          showToast('Vui lòng nhập tên khách hàng mới!', 'danger');
          return null;
        }
        const qProvinceSelect = document.getElementById('quick-cust-province');
        const qProvince = qProvinceSelect ? qProvinceSelect.value : '';
        if (!qProvince) {
          showToast('Vui lòng chọn Tỉnh/Thành phố cho khách hàng mới!', 'danger');
          return null;
        }

        const qCode = generateUniqueCustomerCode(qProvince);
        const qAddress = document.getElementById('quick-cust-address').value.trim();
        const qAssignedBrand = document.getElementById('quick-cust-assigned-brand').value;
        if (!qAssignedBrand) {
          showToast('Vui lòng chọn nhãn đại lý độc quyền!', 'warning');
          return null;
        }

        const qManagerSelect = document.getElementById('quick-cust-manager');
        const qManager = qManagerSelect ? qManagerSelect.value : '';
        if (!qManager) {
          showToast('Vui lòng chọn nhân viên quản lý cho khách hàng mới!', 'danger');
          return null;
        }

        const plSelect = document.getElementById('invoice-pricelist-select');
        const qPricelistId = plSelect && plSelect.value ? plSelect.value : 'custom';
        const newCustomer = {
          id: `cust-${Date.now()}`,
          code: qCode,
          name: qName,
          phone: qPhone,
          address: qAddress,
          assignedBrand: qAssignedBrand,
          brandDiscounts: { province: qProvince },
          debt: 0,
          totalTransaction: 0,
          notes: 'Thêm nhanh từ màn hình lên đơn',
          pricelistId: qPricelistId,
          managedBy: qManager
        };

        const custSaved = await dbCreateQuickCustomer(newCustomer);
        if (!custSaved) return null;
        // Keep the local state aligned with the authoritative manager chosen by
        // the RPC (Sale users are always forced to own their quick customers).
        const savedCustomer = custSaved === true
          ? newCustomer
          : { ...newCustomer, ...custSaved };
        resolvedQuickCustomer = savedCustomer;
        state.activeCustomerId = savedCustomer.id;
        state.customers.push(savedCustomer);
        localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
      }
    }

    const order = compileActiveOrder(resolvedQuickCustomer);
    if (!order) return null;

    if (!canPersistCurrentInvoicePricing(reusedExistingQuickCustomer ? resolvedQuickCustomer : null)) {
      showToast('Chỉ Bảng giá chung được phép ghi đè bảng giá mặc định của khách hàng.', 'warning');
      return null;
    }

    if (manualPricingApproved) order.manualPriceConfirmed = true;
    
    order.status = status;

    // Lấy ID đơn sửa nếu có
    const saveBtnEl = document.getElementById('btn-save-order');
    const editOrderId = saveBtnEl ? saveBtnEl.getAttribute('data-edit-order-id') : null;
    const amendOrderId = saveBtnEl ? saveBtnEl.getAttribute('data-amend-order-id') : null;

    if (amendOrderId && status !== 'settled') {
      showToast('Đơn đã chốt chỉ có thể được lưu thành một bản chốt thay thế.', 'warning');
      return null;
    }

    let amendmentReason = '';
    if (amendOrderId) {
      amendmentReason = window.prompt('Nhập lý do sửa đơn đã chốt (ít nhất 3 ký tự):', 'Điều chỉnh thông tin đơn hàng')?.trim() || '';
      if (!amendmentReason) return null;
      if (amendmentReason.length < 3) {
        showToast('Lý do sửa đơn phải có ít nhất 3 ký tự.', 'warning');
        return null;
      }
    }

    showToast('Đang lưu hóa đơn...', 'info');

    const saved = amendOrderId
      ? await dbAmendOrder(amendOrderId, order, amendmentReason)
      : (status === 'settled' ? await dbConfirmOrder(order) : await dbSaveOrder(order));
    if (saved) {
      // Finalized IDs, snapshots, prices and totals come back from the database.
      const persistedOrder = status === 'settled' && saved.order ? saved.order : order;
      // From this point the database transaction has completed. Any later
      // exception is a local refresh problem and must never be reported as a
      // failed save, otherwise users may retry an order that is already final.
      if (isCloudActive && (status === 'draft' || (status === 'settled' && typeof saved === 'object'))) {
        persistedOrderAfterCommit = persistedOrder;
      }
      if (amendOrderId) {
        lastFinalizedOrder = persistedOrder;
        await Promise.all([
          dbRefreshOrderById(amendOrderId),
          persistedOrder.id && String(persistedOrder.id) !== String(amendOrderId)
            ? dbRefreshOrderById(persistedOrder.id)
            : Promise.resolve(true),
          persistedOrder.customerId
            ? dbRefreshCustomerFinancialState(persistedOrder.customerId, { includeHistory: false })
            : Promise.resolve(true)
        ]);
        resetInvoiceBuilder();
        renderAll();
        showToast(`Đã lưu bản sửa ${persistedOrder.id}; đơn cũ ${amendOrderId} được giữ lại ở trạng thái đã hủy.`, 'success');
        return persistedOrder;
      }
      if (status === 'draft') {
        // Show success only after local state and the screen are refreshed.
      } else {
        // Cập nhật state in-memory của khách hàng sau khi DB đã chốt thành công
        if (persistedOrder.customerId) {
          const cust = state.customers.find(c => c.id === persistedOrder.customerId);
          if (cust) {
            const recoveredCustomer = saved.customer_state;
            if (recoveredCustomer) {
              cust.debt = Number(recoveredCustomer.debt || 0);
              cust.totalTransaction = Number(recoveredCustomer.total_transaction || 0);
              cust.netRevenue = Number(recoveredCustomer.net_revenue || 0);
              cust.lastOrderAt = recoveredCustomer.last_order_at || cust.lastOrderAt || '';
            } else {
              const debtBefore = Number(cust.debt) || 0;
              const debtAmount = getOrderOutstandingAmount(persistedOrder);
              const rpcDebt = Number(saved.new_debt);
              cust.debt = Number.isFinite(rpcDebt)
                ? rpcDebt
                : chargeCustomerDebt(debtBefore, debtAmount);
            }
            if (!saved.already_finalized && !recoveredCustomer) {
              cust.totalTransaction = Math.round((cust.totalTransaction || 0) + persistedOrder.totalPayable);
              cust.netRevenue = Math.round((cust.netRevenue || 0) + persistedOrder.totalPayable);
              cust.lastOrderAt = persistedOrder.date || new Date().toISOString();
            }
            localStorage.setItem('billing_system_customers', JSON.stringify(state.customers));
          }
        }
      }
      
      // Lưu local
      if (editOrderId) {
        state.savedOrders = state.savedOrders.filter(o => o.id !== editOrderId);
      }
      state.savedOrders = state.savedOrders.filter(o => o.id !== persistedOrder.id);
      state.savedOrders.unshift(persistedOrder);
      cacheOrdersLocally(state.savedOrders);
      if (status === 'settled') lastFinalizedOrder = persistedOrder;

      resetInvoiceBuilder();
      renderAll();

      if (status === 'draft') {
        showToast(`Đã lưu đơn nháp ${persistedOrder.id} thành công!`, 'success');
      } else {
        showToast(`Đã chốt và lưu đơn hàng ${persistedOrder.id} thành công!`, 'success');
      }
      
      return persistedOrder;
    } else {
      showToast('Lưu đơn hàng không thành công. Vui lòng kiểm tra kết nối và thử lại!', 'danger');
      return null;
    }
  } catch (error) {
    if (persistedOrderAfterCommit) {
      console.error('Lỗi làm mới giao diện sau khi máy chủ đã lưu đơn:', error);
      const completedAction = status === 'draft' ? 'lưu nháp' : 'chốt và lưu';
      showToast(`Đơn ${persistedOrderAfterCommit.id} đã được ${completedAction} thành công trên máy chủ. Giao diện chưa tự làm mới; mở Lịch sử đơn để xem trạng thái chính xác.`, 'warning');
      return persistedOrderAfterCommit;
    }
    console.error("Lỗi khi lưu đơn hàng:", error);
    showToast('Có lỗi xảy ra khi lưu đơn hàng: ' + (error.message || 'Lỗi hệ thống'), 'danger');
    return null;
  } finally {
    isSavingOrder = false;
    enableButtons();
  }
}

export function resetInvoiceCustomer() {
  state.activeCustomerId = '';
  state.activeCustomerBrand = 'Tất cả';
  
  const idInput = document.getElementById('invoice-customer-id');
  if (idInput) idInput.value = '';
  
  const searchInput = document.getElementById('invoice-customer-search');
  if (searchInput) {
    searchInput.value = '';
    searchInput.removeAttribute('disabled');
  }
  
  // Khôi phục ô ghi chú hóa đơn
  const notesInput = document.getElementById('invoice-notes');
  if (notesInput) notesInput.value = '';
  
  const infoCard = document.getElementById('invoice-customer-info-card');
  if (infoCard) infoCard.style.display = 'none';
  
  const clearCustBtn = document.getElementById('btn-clear-invoice-customer');
  if (clearCustBtn) clearCustBtn.style.display = 'none';
  
  const discVal = document.getElementById('invoice-discount-value');
  if (discVal) discVal.value = '0';
  const discType = document.getElementById('invoice-discount-type');
  if (discType) discType.value = 'percent';
  const shippingFeeVal = document.getElementById('invoice-shipping-fee-value');
  if (shippingFeeVal) shippingFeeVal.value = '0';
  
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (plSelect) {
    plSelect.querySelectorAll('option[data-customer-assigned="true"]').forEach(option => option.remove());
    plSelect.value = '';
    plSelect.dataset.explicitOverride = 'false';
    plSelect.disabled = false;
  }
  
  const plGroup = document.getElementById('invoice-pricelist-group');
  if (plGroup) plGroup.style.display = 'block';
  
  applyActivePriceListToInvoice();
}

export function prepareInvoiceCustomerReselection(searchValue = '', shouldFocus = true) {
  state.activeCustomerId = '';
  state.activeCustomerBrand = 'Tất cả';

  const idInput = document.getElementById('invoice-customer-id');
  if (idInput) idInput.value = '';

  const searchInput = document.getElementById('invoice-customer-search');
  if (searchInput) {
    searchInput.value = searchValue;
    searchInput.removeAttribute('disabled');
    searchInput.removeAttribute('data-selected-customer-name');
    if (shouldFocus) searchInput.focus();
  }

  const infoCard = document.getElementById('invoice-customer-info-card');
  if (infoCard) infoCard.style.display = 'none';

  const clearCustBtn = document.getElementById('btn-clear-invoice-customer');
  if (clearCustBtn) clearCustBtn.style.display = 'none';

  const plSelect = document.getElementById('invoice-pricelist-select');
  if (plSelect) {
    plSelect.querySelectorAll('option[data-customer-assigned="true"]').forEach(option => option.remove());
    plSelect.value = '';
    plSelect.dataset.explicitOverride = 'false';
    plSelect.disabled = false;
  }

  applyActivePriceListToInvoice();
}

export function resetInvoiceBuilder() {
  clearPendingOrderIdempotencyKey();
  state.invoiceItems = [];
  document.getElementById('invoice-notes').value = '';
  const productSearch = document.getElementById('invoice-product-search');
  if (productSearch) {
    productSearch.value = '';
    productSearch.removeAttribute('data-selected-family-key');
    productSearch.removeAttribute('data-matched-variant-id');
  }
  selectedProductFamilyKey = '';
  syncInvoiceBusinessDateControl(currentBusinessDateInputValue(), false);
  closeVariantPicker();
  
  // Khôi phục nút và tiêu đề panel về trạng thái Tạo hóa đơn mới
  const saveBtn = document.getElementById('btn-save-order');
  const draftBtn = document.getElementById('btn-draft-order');
  const panelTitle = document.querySelector('#invoice-panel .panel-title');
  
  if (saveBtn) {
    saveBtn.style.display = 'inline-flex';
    saveBtn.innerHTML = `<i data-lucide="check-square"></i> Thanh toán & Chốt đơn`;
    saveBtn.removeAttribute('data-edit-order-id');
    saveBtn.removeAttribute('data-amend-order-id');
  }
  if (draftBtn) {
    draftBtn.style.display = 'inline-flex';
    draftBtn.innerHTML = `<i data-lucide="file-text"></i> Lưu đơn nháp`;
  }
  if (panelTitle) panelTitle.innerHTML = `<i data-lucide="shopping-bag"></i> Chọn sản phẩm vào hóa đơn`;

  if (state.isQuickCustomerMode) {
    disableQuickCustomerMode();
  } else {
    resetInvoiceCustomer();
  }
  renderInvoiceTable();
}

export function enableQuickCustomerMode() {
  state.isQuickCustomerMode = true;
  
  // Hide search and show quick add fields
  const searchGroup = document.getElementById('invoice-customer-search-group');
  if (searchGroup) searchGroup.style.display = 'none';
  
  const toggleContainer = document.getElementById('invoice-quick-customer-toggle-container');
  if (toggleContainer) toggleContainer.style.display = 'none';
  
  const quickFields = document.getElementById('invoice-quick-customer-fields');
  if (quickFields) {
    quickFields.style.display = 'flex';
    // Pre-fill name with whatever is in search input
    const searchInput = document.getElementById('invoice-customer-search');
    const quickNameInput = document.getElementById('quick-cust-name');
    if (searchInput && quickNameInput) {
      quickNameInput.value = searchInput.value.trim();
    }
  }
  
  const quickBrandSelect = document.getElementById('quick-cust-assigned-brand');
  if (quickBrandSelect) {
    const brands = state.brands && state.brands.length > 0
      ? state.brands.map(b => b.name)
      : ['Nano10*', 'Hatacco nano', 'mutsutec', 'tdkaw', 'cova', 'festivanano'];
    quickBrandSelect.innerHTML = `
      <option value="Tất cả">Chọn nhãn sơn</option>
      ${brands.map(b => `<option value="${b}">${b}</option>`).join('')}
    `;
    quickBrandSelect.value = 'Tất cả';
    makeSelectSearchable('quick-cust-assigned-brand', 'Chọn nhãn sơn', false);
  }
  
  // Hide info card
  const infoCard = document.getElementById('invoice-customer-info-card');
  if (infoCard) infoCard.style.display = 'none';
  
  // Update state active customer to represent quick customer
  state.activeCustomerId = '';
  state.activeCustomerBrand = quickBrandSelect ? quickBrandSelect.value : 'Tất cả';
  
  // Reset invoice item discounts to 0 since new customer has no predefined discounts
  state.invoiceItems.forEach(item => {
    item.discountPercent = 0;
  });
  
  // Move the price list selector inside quick customer fields
  const plGroup = document.getElementById('invoice-pricelist-group');
  if (plGroup && quickFields) {
    plGroup.style.display = 'block';
    quickFields.appendChild(plGroup);
  }
  
  renderInvoiceTable();
}

export function disableQuickCustomerMode() {
  state.isQuickCustomerMode = false;
  
  // Show search and hide quick add fields
  const searchGroup = document.getElementById('invoice-customer-search-group');
  if (searchGroup) searchGroup.style.display = 'block';
  
  const toggleContainer = document.getElementById('invoice-quick-customer-toggle-container');
  if (toggleContainer) toggleContainer.style.display = 'block';
  
  const quickFields = document.getElementById('invoice-quick-customer-fields');
  if (quickFields) quickFields.style.display = 'none';
  
  // Clear inputs
  const qName = document.getElementById('quick-cust-name');
  if (qName) qName.value = '';
  const qPhone = document.getElementById('quick-cust-phone');
  if (qPhone) qPhone.value = '';
  const qProvince = document.getElementById('quick-cust-province');
  if (qProvince) qProvince.value = '';
  const qAddr = document.getElementById('quick-cust-address');
  if (qAddr) qAddr.value = '';
  const qBrand = document.getElementById('quick-cust-assigned-brand');
  if (qBrand) {
    qBrand.value = 'Tất cả';
    makeSelectSearchable('quick-cust-assigned-brand', 'Chọn nhãn sơn', false);
  }
  const qManager = document.getElementById('quick-cust-manager');
  if (qManager) {
    if (state.currentUser) {
      qManager.value = state.currentUser.username;
    } else {
      qManager.value = '';
    }
  }
  
  // Restore the price list selector back to the placeholder
  const placeholder = document.getElementById('invoice-pricelist-placeholder');
  const plGroup = document.getElementById('invoice-pricelist-group');
  if (placeholder && plGroup) {
    placeholder.appendChild(plGroup);
  }
  
  resetInvoiceCustomer();
}

export function handleQuickCustomerBrandChange(newBrand) {
  if (newBrand && newBrand !== 'Tất cả') {
    const invalidItems = state.invoiceItems.filter(item => {
      const pBrandLower = (item.brand || '').toLowerCase().replace(/\s+/g, '');
      const isFestiva = pBrandLower === 'festivanano' || pBrandLower === 'festiva';
      if (isFestiva) return false;
      return item.brand !== newBrand;
    });
    if (invalidItems.length > 0) {
      const ok = confirm(`Khách hàng mới này được chỉ định nhãn sơn "${newBrand}". Chọn nhãn này sẽ loại bỏ ${invalidItems.length} sản phẩm khác nhãn sơn hiện có trong đơn hàng. Bạn có đồng ý không?`);
      if (!ok) {
        const quickBrandSelect = document.getElementById('quick-cust-assigned-brand');
        if (quickBrandSelect) {
          quickBrandSelect.value = state.activeCustomerBrand;
          makeSelectSearchable('quick-cust-assigned-brand', 'Chọn nhãn sơn', false);
        }
        return;
      } else {
        state.invoiceItems = state.invoiceItems.filter(item => {
          const pBrandLower = (item.brand || '').toLowerCase().replace(/\s+/g, '');
          const isFestiva = pBrandLower === 'festivanano' || pBrandLower === 'festiva';
          return isFestiva || item.brand === newBrand;
        });
      }
    }
  }
  state.activeCustomerBrand = newBrand;
  
  // For quick customer, they have no preset brandDiscounts, so brand discounts default to 0.
  state.invoiceItems.forEach(item => {
    item.discountPercent = 0;
  });
  
  renderInvoiceTable();
}

function canPrintProcessingInvoice(user = state.currentUser) {
  return ['admin', 'accounting'].includes(String(user?.role || '').toLowerCase());
}

export async function renderAndPrintOrder(order, type = 'retail') {
  if (type === 'processing' && !canPrintProcessingInvoice()) {
    showToast('Chỉ Admin hoặc Kế toán được in hóa đơn bên gia công.', 'danger');
    return false;
  }

  const orderDebtSnapshot = type === 'agent' && order?.status === 'settled' && order?.customerId
    ? await dbFetchOrderDebtSnapshot(order.id, order.customerId)
    : null;
  // Cập nhật tiêu đề hóa đơn và kích thước logo theo loại bản in
  const titleEl = document.querySelector('#print-invoice-template h1');
  const printLogoImg = document.querySelector('.print-logo-container img');
  const printLogoSvg = document.getElementById('print-logo-svg');
  const printLogoContainer = document.querySelector('.print-logo-container');
  const printHeader = document.querySelector('.print-header');
  if (printHeader) {
    printHeader.style.display = type === 'warehouse' ? 'flex' : 'none';
  }
  
  if (titleEl) {
    if (type === 'warehouse' || type === 'processing') {
      titleEl.innerText = 'PHIẾU XUẤT KHO';
      titleEl.style.fontSize = '17.6pt'; // Giảm 20% từ 22pt
    } else if (type === 'retail') {
      titleEl.innerText = 'HÓA ĐƠN';
      titleEl.style.fontSize = '22pt';
    } else {
      titleEl.innerText = 'HÓA ĐƠN BÁN HÀNG';
      titleEl.style.fontSize = '22pt';
    }
  }

  if (type === 'warehouse') {
    if (printLogoImg) {
      printLogoImg.style.maxHeight = '164px'; // Giảm 20% từ 205px
      printLogoImg.style.maxWidth = '360px'; // Giảm 20% từ 450px
    }
    if (printLogoSvg) {
      printLogoSvg.setAttribute('width', '136'); // Giảm 20% từ 170
      printLogoSvg.setAttribute('height', '136'); // Giảm 20% từ 170
    }
    if (printLogoContainer) {
      printLogoContainer.style.minWidth = '152px'; // Giảm 20% từ 190px
    }
  } else {
    if (printLogoImg) {
      printLogoImg.style.maxHeight = '55px';
      printLogoImg.style.maxWidth = '150px';
    }
    if (printLogoSvg) {
      printLogoSvg.setAttribute('width', '45');
      printLogoSvg.setAttribute('height', '45');
    }
    if (printLogoContainer) {
      printLogoContainer.style.minWidth = '150px';
    }
  }

  document.getElementById('print-invoice-id').innerText = getOrderDisplayCode(order);
  document.getElementById('print-invoice-date').innerText = formatDateTime(order.date);
  const invoiceIdRowEl = document.getElementById('print-invoice-id-row');
  const invoiceDateLabelEl = document.getElementById('print-invoice-date-label');
  if (invoiceIdRowEl) invoiceIdRowEl.style.display = type === 'processing' ? 'none' : '';
  if (invoiceDateLabelEl) invoiceDateLabelEl.innerText = type === 'processing' ? 'Ngày:' : 'Ngày lập:';
  const customerNameEl = document.getElementById('print-customer-name');
  if (customerNameEl) {
    customerNameEl.innerText = order.customerName;
    customerNameEl.style.fontSize = type === 'warehouse' ? 'calc(1em + 4px)' : '';
    if (type === 'processing') customerNameEl.style.fontSize = 'calc(1em + 4px)';
  }
  
  // Tổng hợp ghi chú đơn hàng và ghi chú mặc định của khách hàng
  let combinedNotes = order.notes || '';
  if (order.customerId) {
    const cust = state.customers.find(c => c.id === order.customerId);
    if (cust && cust.notes) {
      if (combinedNotes) {
        if (!combinedNotes.includes(cust.notes)) {
          combinedNotes = `${cust.notes} | ${combinedNotes}`;
        }
      } else {
        combinedNotes = cust.notes;
      }
    }
  }
  const notesEl = document.getElementById('print-invoice-notes');
  if (notesEl) notesEl.innerText = combinedNotes || 'N/A';
  
  // Điền nhãn sơn và cập nhật thông tin nhà phân phối / công ty tương ứng
  const firstItem = order.items[0];
  let brandName = 'N/A';
  if (firstItem) {
    brandName = firstItem.brand || (firstItem.product && firstItem.product.brand) || 'N/A';
  }
  // 1. Tìm cấu hình hãng sơn tương ứng trong danh sách state.brands
  let brandConfig = state.brands ? state.brands.find(b => b.name.toLowerCase() === brandName.toLowerCase()) : null;
  if (!brandConfig && state.brands) {
    brandConfig = state.brands.find(b => brandName.toLowerCase().includes(b.name.toLowerCase()) || b.name.toLowerCase().includes(brandName.toLowerCase()));
  }

  // Cấu hình mặc định (fallback) nếu hoàn toàn không tìm thấy hãng sơn trong bảng dữ liệu
  const defaultBrandConfig = {
    name: brandName,
    companyName: 'CÔNG TY CỔ PHẦN ABS JAPAN',
    logoFilename: 'absjapan.png',
    hotline: '088.603.7878 - 0961.030.923',
    cskh: '0868.055.866',
    email: 'nhamaysonnano@gmail.com',
    addressMain: 'Tiên Kha - Phúc Thịnh - Hà Nội',
    addressFactory: 'TDP Cầu Giao - P.Phúc Thuận - T.Thái Nguyên',
    addressBusiness: '228 Hoàng Hữu Nam - P.Long Bình - Hồ Chí Minh',
    invoiceWarehouseText: 'Xuất Tại kho số 03 Chi nhánh Thái Nguyên',
    salesPhone: ''
  };

  const config = brandConfig || defaultBrandConfig;
  const logoSrc = config.logoFilename;

  let logoPromise = Promise.resolve();
  if (printLogoImg) {
    logoPromise = new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      printLogoImg.onload = () => {
        printLogoImg.style.display = 'block';
        if (printLogoSvg) printLogoSvg.style.display = 'none';
        done();
      };

      printLogoImg.onerror = () => {
        printLogoImg.style.display = 'none';
        if (printLogoSvg) printLogoSvg.style.display = 'block';
        done();
      };

      printLogoImg.src = logoSrc;

      // Nếu ảnh đã được cache và load xong từ trước
      if (printLogoImg.complete && printLogoImg.naturalWidth !== 0) {
        printLogoImg.style.display = 'block';
        if (printLogoSvg) printLogoSvg.style.display = 'none';
        done();
      }

      // Giới hạn thời gian tối đa 800ms để in luôn nếu mạng quá chậm
      setTimeout(done, 800);
    });
  }

  await logoPromise;

  // Điền các trường thông tin chi tiết của công ty lên hóa đơn
  const companyAddressMainEl = document.getElementById('print-company-address-main');
  if (companyAddressMainEl) companyAddressMainEl.innerText = config.addressMain;

  const companyAddressFactoryEl = document.getElementById('print-company-address-factory');
  if (companyAddressFactoryEl) companyAddressFactoryEl.innerText = config.addressFactory;

  const companyCskhEl = document.getElementById('print-company-cskh');
  if (companyCskhEl) companyCskhEl.innerText = config.cskh;

  const companyEmailEl = document.getElementById('print-company-email');
  if (companyEmailEl) companyEmailEl.innerText = config.email;

  const companyLargeEl = document.getElementById('print-company-name-large');
  if (companyLargeEl) {
    companyLargeEl.innerText = config.companyName;
    companyLargeEl.style.display = type === 'retail' ? 'none' : '';
    if (type === 'processing') companyLargeEl.style.display = 'none';
  }

  const sellerNameEl = document.getElementById('print-seller-name');
  if (sellerNameEl) sellerNameEl.innerText = config.companyName;

  const hotlineEl = document.getElementById('print-company-hotline');
  if (hotlineEl) hotlineEl.innerText = config.hotline;

  const sellerHotlineEl = document.getElementById('print-seller-hotline');
  if (sellerHotlineEl) sellerHotlineEl.innerText = config.hotline;

  const ddkdEl = document.getElementById('print-company-ddkd');
  if (ddkdEl) {
    if (config.addressBusiness && config.addressBusiness.trim() !== '') {
      ddkdEl.style.display = 'block';
      const companyAddressBusinessEl = document.getElementById('print-company-address-business');
      if (companyAddressBusinessEl) companyAddressBusinessEl.innerText = config.addressBusiness;
    } else {
      ddkdEl.style.display = 'none';
    }
  }

  const addressEl = document.getElementById('print-customer-address');
  const phoneEl = document.getElementById('print-customer-phone');
  const groupEl = document.getElementById('print-customer-group');
  const managerEl = document.getElementById('print-customer-manager');
  const creatorEl = document.getElementById('print-creator-name');
  const salesPhoneEl = document.getElementById('print-sales-phone');
  const salesPhoneGroupEl = document.getElementById('print-sales-phone-group');
  const warehouseTextEl = document.getElementById('print-warehouse-text');
  const warehouseRowEl = document.getElementById('print-warehouse-row');
  const processingReasonRowEl = document.getElementById('print-processing-reason-row');
  const processingReasonEl = document.getElementById('print-processing-reason');
  const paymentMethodWrapEl = document.getElementById('print-payment-method-wrap');
  const paymentMethodEl = document.getElementById('print-payment-method');

  const salespersonId = order.salespersonId || order.salesperson_id || order.createdBy;
  const creatorName = getUserDisplayName(salespersonId, 'Không xác định', state.users);

  if (creatorEl) creatorEl.innerText = creatorName || 'admin';
  if (salesPhoneEl) salesPhoneEl.innerText = config.salesPhone || config.hotline || 'N/A';
  if (salesPhoneGroupEl) salesPhoneGroupEl.style.display = type === 'warehouse' ? '' : 'none';
  if (warehouseTextEl) warehouseTextEl.innerText = config.invoiceWarehouseText || 'Xuất Tại kho số 03 Chi nhánh Thái Nguyên';
  if (warehouseRowEl) {
    warehouseRowEl.style.display = type === 'retail' ? 'none' : '';
    if (type === 'processing') warehouseRowEl.style.display = 'none';
  }
  if (processingReasonRowEl) processingReasonRowEl.style.display = type === 'processing' ? '' : 'none';
  if (processingReasonEl) processingReasonEl.innerText = order.processingReason || order.exportReason || order.reason || order.notes || '';
  if (paymentMethodWrapEl) paymentMethodWrapEl.style.display = type === 'processing' ? '' : 'none';
  if (paymentMethodEl) {
    const paymentMethod = String(order.paymentMethod || order.payment_method || '').trim();
    const normalizedPaymentMethod = paymentMethod.toLowerCase();
    const paymentMethodLabels = {
      cash: 'Tiền mặt',
      tien_mat: 'Tiền mặt',
      bank_transfer: 'Chuyển khoản',
      transfer: 'Chuyển khoản',
      chuyen_khoan: 'Chuyển khoản',
      card: 'Thẻ',
      e_wallet: 'Ví điện tử'
    };
    paymentMethodEl.innerText = paymentMethodLabels[normalizedPaymentMethod] || paymentMethod;
  }

  const orderCustomer = order.customerId
    ? state.customers.find(c => String(c.id) === String(order.customerId))
    : null;
  const managerId = orderCustomer?.managedBy
    || orderCustomer?.managed_by
    || order.customerManagerId
    || order.customer_manager_id
    || order.managedBy
    || '';
  if (managerEl) {
    managerEl.innerText = formatSalesManagerPrintLabel(managerId);
    managerEl.style.display = type === 'processing' ? 'none' : '';
  }

  if (order.customerId) {
    const cust = orderCustomer;
    if (cust) {
      if (addressEl) addressEl.innerText = cust.address || 'N/A';
      if (phoneEl) phoneEl.innerText = formatPhoneNumber(cust.phone) || 'N/A';
      if (groupEl) groupEl.innerText = cust.managedBy || 'N/A';
    } else {
      if (addressEl) addressEl.innerText = 'N/A';
      if (phoneEl) phoneEl.innerText = 'N/A';
      if (groupEl) groupEl.innerText = 'N/A';
    }
  } else {
    if (addressEl) addressEl.innerText = 'N/A';
    if (phoneEl) phoneEl.innerText = 'N/A';
    if (groupEl) groupEl.innerText = 'N/A';
  }

  const table = document.getElementById('print-invoice-table');
  
  if (type === 'warehouse') {
    // Tính tổng số lượng quy cách
    const totals = {};
    let totalQty = 0;
    order.items.forEach(item => {
      let pkg = item.packagingName || item.packagingNameSnapshot || item.package;
      if (pkg === 'Thung') pkg = 'Thùng';
      else if (pkg === 'Lon') pkg = 'Lon';
      else if (pkg === 'Hop') pkg = 'Hộp';
      else if (pkg === 'Bao') pkg = 'Bao';
      else if (pkg === 'Tui') pkg = 'Túi';
      else if (pkg === 'Bo') pkg = 'Bộ';
      
      const qty = parseInt(item.quantity) || 0;
      totalQty += qty;
      if (qty > 0) {
        totals[pkg] = (totals[pkg] || 0) + qty;
      }
    });
    
    const totalParts = Object.entries(totals).map(([pkg, qty]) => `${qty} ${pkg}`);
    const totalsText = totalParts.length > 0 ? totalParts.join(', ') : '0';

    // Hoá đơn cho nhân viên kho (Ẩn giá tiền, thêm Mã màu, thu nhỏ Tên SP/Khối lượng/SL, tăng kích thước Mã hàng và Ghi chú)
    table.innerHTML = `
      <thead>
        <tr>
          <th style="width: 5%;">STT</th>
          <th style="width: 30%;">Tên sản phẩm</th>
          <th style="width: 14%;">Mã hàng</th>
          <th style="width: 10%; text-align: center;">Mã màu</th>
          <th style="width: 10%; text-align: center;">Khối lượng</th>
          <th style="width: 6%; text-align: center;">SL</th>
          <th style="width: 25%;">Ghi chú</th>
        </tr>
      </thead>
      <tbody>
        ${order.items.map((item, idx) => {
          const specification = getOrderItemSpecification(item);
          const variantCode = getOrderItemVariantCode(item);
          
          return `
            <tr>
              <td style="text-align: center;">${idx + 1}</td>
              <td>${item.productName}</td>
              <td style="font-weight: bold; font-size: 14pt;">${variantCode}</td>
              <td style="text-align: center; font-weight: bold; font-size: 14pt;">${item.colorCode || ''}</td>
              <td style="text-align: center;">${specification}</td>
              <td style="text-align: center; font-weight: bold; font-size: 14pt;">${item.quantity}</td>
              <td style="font-size: 13pt; font-weight: 500;">${item.notes || ''}</td>
            </tr>
          `;
        }).join('')}
        <tr style="background-color: #f5f5f5; font-weight: bold;">
          <td colspan="5" style="text-align: right; padding-right: 15px; font-size: 13pt;">Tổng cộng:</td>
          <td style="text-align: center; font-size: 14pt; color: #000;">${totalQty}</td>
          <td style="font-size: 13pt; color: #000;">${totalsText}</td>
        </tr>
      </tbody>
    `;
    
    // Ẩn tổng tiền thanh toán trên hóa đơn kho
    document.querySelector('.print-summary').style.display = 'none';
  } else if (type === 'processing') {
    let totalQty = 0;
    const itemRowsHtml = order.items.map((item, idx) => {
      const quantity = Number(item.quantity) || 0;
      totalQty += quantity;
      const specification = getOrderItemSpecification(item);
      const colorPercentText = Number(item.colorPercent) > 0 ? ` (+${item.colorPercent}% màu)` : '';
      const colorCodeDisplay = item.colorCode ? `${item.colorCode}${colorPercentText}` : '';

      return `
        <tr>
          <td style="text-align: center;">${idx + 1}</td>
          <td>${item.productName}</td>
          <td style="text-align: center; font-weight: bold;">${colorCodeDisplay}</td>
          <td style="text-align: center;">${specification}</td>
          <td style="text-align: center; font-weight: bold;">${item.quantity}</td>
        </tr>
      `;
    }).join('');

    table.innerHTML = `
      <thead>
        <tr>
          <th style="width: 7%;">STT</th>
          <th style="width: 55%;">Tên, nhãn hiệu, sản phẩm</th>
          <th style="width: 16%; text-align: center;">Mã màu/ % Màu</th>
          <th style="width: 14%;">ĐVT</th>
          <th style="width: 8%; text-align: center;">SL</th>
        </tr>
      </thead>
      <tbody>
        ${itemRowsHtml}
        <tr style="background-color: #f5f5f5; font-weight: bold;">
          <td colspan="4" style="text-align: center; font-size: 13pt;">Tổng số lượng:</td>
          <td style="text-align: center; font-size: 13pt;">${totalQty}</td>
        </tr>
      </tbody>
    `;

    const processingSummary = document.querySelector('.print-summary');
    if (processingSummary) processingSummary.style.display = 'none';
  } else {
    // Hóa đơn bán hàng (Đại lý & Bán lẻ) dùng chung mẫu in chuẩn như yêu cầu
    const isRetail = type === 'retail';
    const summaryLabelColspan = 7;
    let oldDebt = 0;
    let newDebt = 0;
    let hasDebtInfo = false;
    
    if (type !== 'retail' && order.customerId) {
      const cust = state.customers.find(c => c.id === order.customerId);
      if (cust) {
        hasDebtInfo = true;
        const debtSnapshot = getOrderDebtSnapshot(order, cust, orderDebtSnapshot);
        const isSettledOrder = order.status === 'settled';
        if (!isSettledOrder) {
          oldDebt = cust.debt || 0;
          newDebt = oldDebt;
        } else if (debtSnapshot) {
          oldDebt = debtSnapshot.debtBefore;
          newDebt = debtSnapshot.debtAfter;
        } else {
          newDebt = cust.debt || 0;
          oldDebt = newDebt - getOrderOutstandingAmount(order);
        }
      }
    }

    let debtRowsHtml = '';
    if (hasDebtInfo) {
      debtRowsHtml = `
        <tr>
          <td colspan="${summaryLabelColspan}" style="font-weight: bold; text-align: left; padding: 4px 8px;">Nợ cũ</td>
          <td style="text-align: right; font-weight: bold; padding: 4px 8px;">${formatNumber(oldDebt)}</td>
        </tr>
        <tr>
          <td colspan="${summaryLabelColspan}" style="font-weight: bold; text-align: left; padding: 4px 8px;">Tổng nợ hiện tại</td>
          <td style="text-align: right; font-weight: bold; padding: 4px 8px;">${formatNumber(newDebt)}</td>
        </tr>
      `;
    }

    let sumSubTotal = 0;
    const headerPriceText = isRetail ? 'Giá bán x % màu' : 'Giá nhập';
    const headerSubtotalText = isRetail ? 'Thành tiền X % màu' : 'Thành tiền';

    const itemRowsHtml = order.items.map((item, idx) => {
      const discountMultiplier = 1 - (item.discountPercent || 0) / 100;
      const displayPrice = isRetail ? item.price : Math.round(item.price * discountMultiplier);
      const subTotal = isRetail ?
        Math.round(item.quantity * item.price) :
        Math.round(Math.round(item.quantity * item.price) * discountMultiplier);
      sumSubTotal += subTotal;
      
      const packageDisplay = getOrderItemSpecification(item);
      const colorPercentText = item.colorPercent > 0 ? ` (+${item.colorPercent}% màu)` : '';
      const colorCodeDisplay = item.colorCode ? `${item.colorCode}${colorPercentText}` : '';
      
      return `
        <tr>
          <td style="text-align: center;">${idx + 1}</td>
          <td>${item.productName}</td>
          <td style="font-weight: bold; text-align: center;">${getOrderItemVariantCode(item)}</td>
          <td style="text-align: center; font-weight: bold;">${colorCodeDisplay}</td>
          <td style="text-align: center;">${packageDisplay}</td>
          <td style="text-align: center;">${item.quantity}</td>
          <td style="text-align: right;">${formatNumber(displayPrice)}</td>
          <td style="text-align: right; font-weight: bold;">${formatNumber(subTotal)}</td>
        </tr>
      `;
    }).join('');

    const printSubtotal = order.subtotal !== undefined ? order.subtotal : (isRetail ? sumSubTotal - order.totalDiscount : sumSubTotal);
    const printDiscount = order.discountAmount || 0;
    const printOtherFee = order.otherFeeAmount || 0;
    const printShippingFee = order.shippingFeeAmount || order.shippingFeeValue || 0;

    table.innerHTML = `
      <thead>
        <tr>
          <th style="width: 5%;">STT</th>
          <th style="width: 35%;">Tên, nhãn hiệu, sản phẩm</th>
          <th style="width: 10%;">Mã SP</th>
          <th style="width: 12%; text-align: center;">Mã màu/ % Màu</th>
          <th style="width: 10%;">ĐVT</th>
          <th style="width: 6%; text-align: center;">SL</th>
          <th style="width: 12%; text-align: right;">${headerPriceText}</th>
          <th style="width: 16%; text-align: right;">${headerSubtotalText}</th>
        </tr>
      </thead>
      <tbody>
        ${itemRowsHtml}
        <tr>
          <td colspan="${summaryLabelColspan}" style="font-weight: bold; text-align: left; padding: 4px 8px;">Tạm tính</td>
          <td style="text-align: right; font-weight: bold; padding: 4px 8px;">${formatNumber(printSubtotal)}</td>
        </tr>
        
        <tr>
          <td colspan="${summaryLabelColspan}" style="font-weight: bold; text-align: left; padding: 4px 8px;">Chiết khấu bán hàng${order.discountType === 'percent' && order.discountValue > 0 ? ` (${order.discountValue}%)` : ''}</td>
          <td style="text-align: right; font-weight: bold; padding: 4px 8px;">-${formatNumber(printDiscount)}</td>
        </tr>
        
        ${printOtherFee > 0 ? `
        <tr>
          <td colspan="${summaryLabelColspan}" style="font-weight: bold; text-align: left; padding: 4px 8px;">Khách cọc${order.otherFeeType === 'percent' && order.otherFeeValue > 0 ? ` (${order.otherFeeValue}%)` : ''}</td>
          <td style="text-align: right; font-weight: bold; padding: 4px 8px;">-${formatNumber(printOtherFee)}</td>
        </tr>
        ` : ''}

        ${printShippingFee > 0 ? `
        <tr>
          <td colspan="${summaryLabelColspan}" style="font-weight: bold; text-align: left; padding: 4px 8px;">Thu Khác</td>
          <td style="text-align: right; font-weight: bold; padding: 4px 8px;">+${formatNumber(printShippingFee)}</td>
        </tr>
        ` : ''}
        
        <tr>
          <td colspan="${summaryLabelColspan}" style="font-weight: bold; text-align: left; padding: 4px 8px; font-size: 13pt;">TỔNG THANH TOÁN</td>
          <td style="text-align: right; font-weight: bold; padding: 4px 8px; font-size: 13pt;">${formatNumber(order.amountDue !== undefined ? order.amountDue : Math.max(0, order.totalPayable - (order.paidAmount || 0)))}</td>
        </tr>
        
        ${debtRowsHtml}
      </tbody>
    `;

    // Ẩn bảng tổng tiền dạng nổi ở bên phải vì đã tích hợp thẳng vào bảng
    const oldSummary = document.querySelector('.print-summary');
    if (oldSummary) oldSummary.style.display = 'none';
  }

  // Tổng số tiền viết bằng chữ
  const wordsContainer = document.getElementById('print-amount-in-words-container');
  if (wordsContainer) {
    if (type === 'warehouse' || type === 'processing') {
      wordsContainer.style.display = 'none';
    } else {
      wordsContainer.style.display = 'block';
      const amountInWords = docSoTienBangChu(
        order.amountDue !== undefined
          ? order.amountDue
          : Math.max(0, order.totalPayable - (order.paidAmount || 0))
      );
      const wordsTextEl = document.getElementById('print-amount-in-words');
      if (wordsTextEl) {
        wordsTextEl.innerText = amountInWords;
      }
    }
  }

  // Gán nhãn ký tên khách hàng và dựng các cột chữ ký
  const sigsEl = document.querySelector('.print-signatures');
  if (sigsEl) {
    if (type === 'warehouse' || type === 'processing') {
      sigsEl.innerHTML = `
        <div class="print-sig-col" style="width: 30%;">
          <p><strong>Người lập phiếu</strong></p>
          <p style="font-size: 11pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, ghi rõ họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
        <div class="print-sig-col" style="width: 30%;">
          <p><strong>Thủ kho</strong></p>
          <p style="font-size: 11pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, đóng dấu xuất kho)</p>
          <div class="print-sig-space"></div>
        </div>
        <div class="print-sig-col" style="width: 30%;">
          <p><strong>Người nhận hàng</strong></p>
          <p style="font-size: 11pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, ghi rõ họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
      `;
    } else if (type === 'retail') {
      // Hóa đơn bán lẻ gồm 2 chữ ký thông dụng
      sigsEl.innerHTML = `
        <div class="print-sig-col" style="width: 45%;">
          <p style="margin: 0; font-size: 12pt; font-weight: bold; color: #000;">Người bán hàng</p>
          <p style="font-size: 10pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, ghi rõ họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
        <div class="print-sig-col" style="width: 45%;">
          <p style="margin: 0; font-size: 12pt; font-weight: bold; color: #000;">Người mua hàng</p>
          <p style="font-size: 10pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, ghi rõ họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
      `;
    } else {
      // Hóa đơn bán hàng đại lý gồm 5 chữ ký như yêu cầu
      sigsEl.innerHTML = `
        <div class="print-sig-col" style="width: 18%;">
          <p style="margin: 0; font-size: 12pt; font-weight: bold; color: #000;">Người lập phiếu</p>
          <p style="font-size: 10pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
        <div class="print-sig-col" style="width: 18%;">
          <p style="margin: 0; font-size: 12pt; font-weight: bold; color: #000;">Người nhận</p>
          <p style="font-size: 10pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
        <div class="print-sig-col" style="width: 18%;">
          <p style="margin: 0; font-size: 12pt; font-weight: bold; color: #000;">Thủ kho</p>
          <p style="font-size: 10pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
        <div class="print-sig-col" style="width: 18%;">
          <p style="margin: 0; font-size: 12pt; font-weight: bold; color: #000;">KT. Trưởng</p>
          <p style="font-size: 10pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
        <div class="print-sig-col" style="width: 18%;">
          <p style="margin: 0; font-size: 12pt; font-weight: bold; color: #000;">Giám đốc</p>
          <p style="font-size: 10pt; color: #555; font-style: italic; margin: 0; margin-top: 2px;">(Ký, họ tên)</p>
          <div class="print-sig-space"></div>
        </div>
      `;
    }
  }

  // Gọi lệnh in của trình duyệt
  window.print();
}

export function openPrintTypeModal(order) {
  currentOrderToPrint = order;
  const modal = document.getElementById('print-type-modal');
  if (modal) modal.classList.add('active');
}

export function setupPrintTypeModal() {
  const modal = document.getElementById('print-type-modal');
  if (!modal) return;
  
  const closeBtn = document.getElementById('btn-close-print-type-modal');
  if (closeBtn) {
    const newCloseBtn = closeBtn.cloneNode(true);
    closeBtn.parentNode.replaceChild(newCloseBtn, closeBtn);
    newCloseBtn.addEventListener('click', () => {
      modal.classList.remove('active');
    });
  }

  const retailBtn = document.getElementById('btn-print-type-retail');
  if (retailBtn) {
    const newRetailBtn = retailBtn.cloneNode(true);
    retailBtn.parentNode.replaceChild(newRetailBtn, retailBtn);
    newRetailBtn.addEventListener('click', () => {
      if (currentOrderToPrint) {
        renderAndPrintOrder(currentOrderToPrint, 'retail');
        modal.classList.remove('active');
      }
    });
  }
  
  const agentBtn = document.getElementById('btn-print-type-agent');
  if (agentBtn) {
    const newAgentBtn = agentBtn.cloneNode(true);
    agentBtn.parentNode.replaceChild(newAgentBtn, agentBtn);
    newAgentBtn.addEventListener('click', () => {
      if (currentOrderToPrint) {
        renderAndPrintOrder(currentOrderToPrint, 'agent');
        modal.classList.remove('active');
      }
    });
  }

  const processingBtn = document.getElementById('btn-print-type-processing');
  if (processingBtn) {
    const newProcessingBtn = processingBtn.cloneNode(true);
    processingBtn.parentNode.replaceChild(newProcessingBtn, processingBtn);
    newProcessingBtn.addEventListener('click', () => {
      if (!currentOrderToPrint) return;
      if (!canPrintProcessingInvoice()) {
        showToast('Chỉ Admin hoặc Kế toán được in hóa đơn bên gia công.', 'danger');
        return;
      }
      renderAndPrintOrder(currentOrderToPrint, 'processing');
      modal.classList.remove('active');
    });
  }
  
  const warehouseBtn = document.getElementById('btn-print-type-warehouse');
  if (warehouseBtn) {
    const newWarehouseBtn = warehouseBtn.cloneNode(true);
    warehouseBtn.parentNode.replaceChild(newWarehouseBtn, warehouseBtn);
    newWarehouseBtn.addEventListener('click', () => {
      if (currentOrderToPrint) {
        if (state.currentUser && state.currentUser.role === 'sale') {
          showToast('Nhân viên kinh doanh không có quyền in hóa đơn kho!', 'danger');
          return;
        }
        renderAndPrintOrder(currentOrderToPrint, 'warehouse');
        modal.classList.remove('active');
      }
    });
  }
}

export function setupInvoiceCreator() {
  populateQuickCustomerManagerDropdown();
  syncInvoiceBusinessDateControl(currentBusinessDateInputValue(), false);

  const quickProvinceSelect = document.getElementById('quick-cust-province');
  if (quickProvinceSelect) {
    quickProvinceSelect.innerHTML = `
      <option value="">-- Chọn Tỉnh/Thành --</option>
      ${Object.entries(PROVINCES).map(([code, name]) => {
        if (code === 'OTHER') return '';
        return `<option value="${code}">${name}</option>`;
      }).join('')}
      <option value="OTHER">Khác</option>
    `;
    makeSelectSearchable('quick-cust-province', '-- Chọn Tỉnh/Thành --');
  }
  
  makeSelectSearchable('quick-cust-assigned-brand', 'Chọn nhãn sơn', false);

  const searchInput = document.getElementById('invoice-product-search');
  const suggestionsList = document.getElementById('invoice-product-suggestions');
  const addBtn = document.getElementById('btn-add-to-invoice-table');
  const resetBtn = document.getElementById('btn-reset-order');
  const saveBtn = document.getElementById('btn-save-order');
  const draftBtn = document.getElementById('btn-draft-order');
  const printBtn = document.getElementById('btn-print-order');

  if (searchInput) {
    searchInput.addEventListener('input', () => {
      searchInput.removeAttribute('data-selected-family-key');
      searchInput.removeAttribute('data-matched-variant-id');
      selectedProductFamilyKey = '';
      const query = searchInput.value.trim();
      if (!query) {
        suggestionsList.style.display = 'none';
        return;
      }

      const matches = searchProductFamilies(getInvoiceProductFamilies(), query).slice(0, 30);

      if (matches.length === 0) {
        suggestionsList.innerHTML = `<li class="suggestion-item" style="color: var(--text-muted); cursor: default;">Không tìm thấy sản phẩm</li>`;
      } else {
        suggestionsList.innerHTML = matches.map(family => {
          const matchedVariant = family.variants.find(variant => variant.id === family.matchedVariantId);
          return `
          <li class="suggestion-item" data-family-key="${family.key}" data-matched-variant-id="${family.matchedVariantId || ''}" style="text-align: left; display: flex; justify-content: space-between; align-items: center; width: 100%;">
            <div class="suggestion-info" style="text-align: left; align-items: flex-start; display: flex; flex-direction: column;">
              <span class="suggestion-code" style="font-weight: 700; color: var(--text-primary); font-size: 0.8rem;">${family.baseCode}</span>
              <span class="suggestion-name" style="color: var(--text-secondary); font-size: 0.85rem;">${family.name}</span>
              <span style="color: var(--text-muted); font-size: 0.75rem;">
                ${matchedVariant ? `Khớp ${matchedVariant.code} • ${variantSpecification(matchedVariant)}` : `Có ${family.variants.length} quy cách`}
              </span>
            </div>
            <span class="suggestion-brand-badge" style="font-size: 0.7rem; padding: 2px 8px; border-radius: 6px; background: rgba(34, 197, 94, 0.15); color: #047857; border: 1px solid rgba(34, 197, 94, 0.3);">${family.brand}</span>
          </li>
        `;
        }).join('');
      }
      suggestionsList.style.display = 'block';

      suggestionsList.querySelectorAll('.suggestion-item[data-family-key]').forEach(item => {
        item.addEventListener('click', () => {
          const family = matches.find(match => match.key === item.dataset.familyKey);
          if (!family) return;
          selectedProductFamilyKey = family.key;
          searchInput.value = family.baseCode;
          searchInput.setAttribute('data-selected-family-key', family.key);
          searchInput.setAttribute('data-matched-variant-id', item.dataset.matchedVariantId || '');
          suggestionsList.style.display = 'none';
          addProductToInvoice();
        });
      });
    });

    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addProductToInvoice();
      }
    });
  }

  document.addEventListener('click', (e) => {
    if (searchInput && suggestionsList && !searchInput.contains(e.target) && !suggestionsList.contains(e.target)) {
      suggestionsList.style.display = 'none';
    }
  });

  if (addBtn) addBtn.addEventListener('click', addProductToInvoice);
  document.getElementById('btn-close-invoice-variant-modal')?.addEventListener('click', closeVariantPicker);
  document.getElementById('invoice-variant-modal')?.addEventListener('click', event => {
    if (event.target.id === 'invoice-variant-modal') closeVariantPicker();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.getElementById('invoice-variant-modal')?.classList.contains('active')) {
      closeVariantPicker();
    }
  });

  if (resetBtn) {
    resetBtn.addEventListener('click', () => {
      const hasItems = state.invoiceItems.length > 0;
      const hasCustomer = state.activeCustomerId !== '' || state.isQuickCustomerMode;
      const hasNotes = document.getElementById('invoice-notes') && document.getElementById('invoice-notes').value.trim() !== '';
      
      if (hasItems || hasCustomer || hasNotes) {
        if (confirm('Bạn có chắc chắn muốn làm mới toàn bộ đơn hàng đang lập không?')) {
          resetInvoiceBuilder();
        }
      } else {
        showToast('Đơn hàng hiện tại đã trống!', 'info');
      }
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      const order = await saveActiveOrder('settled');
      if (order) {
        switchTab('history-panel');
      }
    });
  }

  if (draftBtn) {
    draftBtn.addEventListener('click', async () => {
      const order = await saveActiveOrder('draft');
      if (order) {
        switchTab('history-panel');
      }
    });
  }

  if (printBtn) {
    printBtn.addEventListener('click', () => {
      // Saving resets the builder, but the user must still be able to print
      // the order that was just finalized without opening History first.
      const order = state.invoiceItems.length > 0 ? compileActiveOrder() : lastFinalizedOrder;
      if (order) {
        openPrintTypeModal(order);
      } else {
        showToast('Chưa có đơn hàng để in. Vui lòng lập đơn hoặc mở đơn trong lịch sử.', 'warning');
      }
    });
  }

  const discValInput = document.getElementById('invoice-discount-value');
  const discTypeSelect = document.getElementById('invoice-discount-type');
  if (discValInput && discTypeSelect) {
    discValInput.addEventListener('input', () => handleDiscountOrFeeInputChange(discValInput, discTypeSelect));
    discValInput.addEventListener('blur', () => {
      if (discValInput.value.trim() === '') discValInput.value = '0';
      calculateInvoiceTotals();
    });
    discTypeSelect.addEventListener('change', () => handleDiscountOrFeeInputChange(discValInput, discTypeSelect));
  }

  const shippingFeeValInput = document.getElementById('invoice-shipping-fee-value');
  if (shippingFeeValInput) {
    shippingFeeValInput.addEventListener('input', () => {
      let rawDigits = shippingFeeValInput.value.replace(/\D/g, '');
      shippingFeeValInput.value = rawDigits ? formatNumber(parseInt(rawDigits, 10) || 0) : '0';
      calculateInvoiceTotals();
    });
    shippingFeeValInput.addEventListener('blur', () => {
      if (shippingFeeValInput.value.trim() === '') shippingFeeValInput.value = '0';
      calculateInvoiceTotals();
    });
  }

  // Sự kiện tìm kiếm khách hàng trong invoice panel
  setupInvoiceCustomerSearch();

  // Quick Customer Mode Listeners
  const quickToggleBtn = document.getElementById('btn-quick-customer-toggle');
  if (quickToggleBtn) {
    quickToggleBtn.addEventListener('click', enableQuickCustomerMode);
  }

  const quickCancelBtn = document.getElementById('btn-quick-customer-cancel');
  if (quickCancelBtn) {
    quickCancelBtn.addEventListener('click', disableQuickCustomerMode);
  }

  const quickBrandSelect = document.getElementById('quick-cust-assigned-brand');
  if (quickBrandSelect) {
    quickBrandSelect.addEventListener('change', () => {
      handleQuickCustomerBrandChange(quickBrandSelect.value);
    });
  }

  const invoicePlSelect = document.getElementById('invoice-pricelist-select');
  if (invoicePlSelect) {
    invoicePlSelect.addEventListener('change', () => {
      const isCustomerAssigned = invoicePlSelect.selectedOptions[0]?.dataset.customerAssigned === 'true';
      invoicePlSelect.dataset.explicitOverride = String(
        Boolean(invoicePlSelect.value) && invoicePlSelect.value !== 'retail' && !isCustomerAssigned
      );
      syncInvoicePersistenceActions();
      applyActivePriceListToInvoice();
    });
  }
}

function setupInvoiceCustomerSearch() {
  const custSearchInput = document.getElementById('invoice-customer-search');
  const infoCard = document.getElementById('invoice-customer-info-card');
  const clearBtn = document.getElementById('btn-clear-invoice-customer');

  if (!custSearchInput) return;

  clearBtn?.addEventListener('click', () => prepareInvoiceCustomerReselection());

  // Lắng nghe sự kiện để tìm kiếm gợi ý khách hàng giống như tìm sản phẩm
  const suggestions = document.createElement('ul');
  suggestions.className = 'suggestions-list';
  suggestions.id = 'invoice-customer-suggestions';
  suggestions.style.display = 'none';
  custSearchInput.parentNode.appendChild(suggestions);

  custSearchInput.addEventListener('input', () => {
    if (state.isQuickCustomerMode) return; // Không cần gợi ý ở chế độ khách lẻ

    const selectedName = custSearchInput.dataset.selectedCustomerName || '';
    if (state.activeCustomerId && custSearchInput.value.trim() !== selectedName) {
      const typedValue = custSearchInput.value;
      prepareInvoiceCustomerReselection(typedValue, false);
    }
    
    const val = custSearchInput.value.trim().toLowerCase();
    if (val === '') {
      suggestions.style.display = 'none';
      return;
    }

    const matches = state.customers.filter(c => {
      if (state.currentUser && state.currentUser.role === 'sale') {
        if (!isSameUser(c.managedBy, state.currentUser.username)) return false;
      }
      return c.code.toLowerCase().includes(val) || c.name.toLowerCase().includes(val) || (c.phone && c.phone.includes(val));
    });

    if (matches.length === 0) {
      suggestions.innerHTML = `<li class="suggestion-item" style="color: var(--text-muted); cursor: default;">Không tìm thấy khách hàng</li>`;
    } else {
      suggestions.innerHTML = matches.map(c => `
        <li class="suggestion-item select-cust-suggestion" data-id="${c.id}" style="text-align: left; display: flex; justify-content: space-between; align-items: center; width: 100%;">
          <div class="suggestion-info">
            <span style="font-weight: 600; color: var(--text-primary);">${c.name} (${c.code})</span>
            <span style="font-size: 0.75rem; color: var(--text-secondary); display: block; margin-top: 2px;">SĐT: ${c.phone || 'N/A'} • Nợ: ${formatCurrency(c.debt)}</span>
          </div>
        </li>
      `).join('');
    }
    suggestions.style.display = 'block';

    document.querySelectorAll('.select-cust-suggestion').forEach(item => {
      item.addEventListener('click', async () => {
        const id = item.getAttribute('data-id');
        const customer = state.customers.find(c => c.id === id);
        if (customer) {
          await selectInvoiceCustomer(customer);
        }
        suggestions.style.display = 'none';
      });
    });
  });

  document.addEventListener('click', (e) => {
    if (!custSearchInput.contains(e.target) && !suggestions.contains(e.target)) {
      suggestions.style.display = 'none';
    }
  });

  setupPrintTypeModal();
}

async function selectInvoiceCustomer(customer) {
  state.activeCustomerId = customer.id;
  state.activeCustomerBrand = customer.assignedBrand;

  const assignedReference = customer.pricelistId || customer.defaultPriceListId || '';
  let applicablePricing = getApplicablePriceList(
    customer,
    state.allPricelists.length ? state.allPricelists : state.pricelists
  );
  const hasDatabaseAssignedPriceList = assignedReference && !['custom', 'retail'].includes(assignedReference);
  const assignedListNeedsScopedItems = Boolean(
    applicablePricing.priceList
    && !canUserViewPriceList(state.currentUser, applicablePricing.priceList)
    && !(state.allPriceListItems || []).some(item => item.priceListId === applicablePricing.priceList.id)
  );
  if (hasDatabaseAssignedPriceList
      && (applicablePricing.selectionSource !== 'customer_default' || assignedListNeedsScopedItems)) {
    const retry = await dbLoadCustomerAssignedPricing(customer);
    applicablePricing = getApplicablePriceList(
      customer,
      state.allPricelists.length ? state.allPricelists : state.pricelists
    );
    if (!retry.loaded || applicablePricing.selectionSource !== 'customer_default') {
      // Never disguise the global fallback as the price list assigned to this
      // dealer. An unresolved assignment must fail closed until its exact list
      // is authorized and loaded.
      applicablePricing = { priceList: null, selectionSource: 'missing_customer_default' };
    }
    if (!applicablePricing.priceList && state.currentUser?.role === 'sale') {
      showToast('Máy chủ chưa trả được bảng giá đã gắn cho đại lý này. Admin cần áp dụng bản cập nhật 0041.', 'danger');
    }
  }
  
  document.getElementById('invoice-customer-id').value = customer.id;
  document.getElementById('invoice-customer-search').value = customer.name;
  document.getElementById('invoice-customer-search').removeAttribute('disabled');
  document.getElementById('invoice-customer-search').dataset.selectedCustomerName = customer.name;
  
  const clearBtn = document.getElementById('btn-clear-invoice-customer');
  if (clearBtn) clearBtn.style.display = 'inline-flex';
  
  const infoCard = document.getElementById('invoice-customer-info-card');
  if (infoCard) {
    infoCard.style.display = 'block';
    document.getElementById('selected-customer-name-lbl').innerText = customer.name;
    document.getElementById('selected-customer-phone-lbl').innerText = customer.phone || 'N/A';
    const provinceName = getProvinceNameByCode(customer.brandDiscounts && customer.brandDiscounts.province);
    const detailAddress = customer.address || 'N/A';
    document.getElementById('selected-customer-address-lbl').innerText = provinceName ? `[${provinceName}] ${detailAddress}` : detailAddress;
    const customerNotesLbl = document.getElementById('selected-customer-notes-lbl');
    if (customerNotesLbl) customerNotesLbl.innerText = customer.notes || 'Không có';
    document.getElementById('selected-customer-brand-lbl').innerText = customer.assignedBrand;
    
    const applicable = applicablePricing;
    const pl = applicable.priceList;
    const plName = pl
      ? (isDealerPrivatePriceList(pl) ? (state.currentUser?.role === 'sale' ? 'Theo danh sách được cấp' : `Giá riêng đại lý - ${pl.name}`) : pl.name)
      : 'Chưa xác định';
    const plLbl = document.getElementById('selected-customer-pricelist-lbl');
    if (plLbl) plLbl.innerText = plName;
    
    const debtLbl = document.getElementById('selected-customer-debt-lbl');
    if (debtLbl) {
      debtLbl.innerText = formatCurrency(customer.debt);
      debtLbl.style.color = (customer.debt > 0) ? 'var(--color-danger)' : ((customer.debt < 0) ? 'var(--color-success)' : 'var(--text-muted)');
    }
  }


  // Tự động gán bảng giá mặc định của đại lý
  const plSelect = document.getElementById('invoice-pricelist-select');
  if (plSelect) {
    const applicable = applicablePricing;
    plSelect.querySelectorAll('option[data-customer-assigned="true"]').forEach(option => option.remove());
    if (applicable.selectionSource === 'customer_default'
        && applicable.priceList
        && ![...plSelect.options].some(option => option.value === applicable.priceList.id)) {
      const assignedOption = document.createElement('option');
      assignedOption.value = applicable.priceList.id;
      assignedOption.textContent = `${applicable.priceList.name} (theo đại lý)`;
      assignedOption.dataset.customerAssigned = 'true';
      const retailOption = [...plSelect.options].find(option => option.value === 'retail');
      plSelect.insertBefore(assignedOption, retailOption || null);
    }
    plSelect.value = applicable.priceList?.id || '';
    plSelect.dataset.explicitOverride = 'false';
    plSelect.disabled = false;
  }
  
  const plGroup = document.getElementById('invoice-pricelist-group');
  if (plGroup) {
    plGroup.style.display = 'block';
  }
  
  applyActivePriceListToInvoice();
  if (applicablePricing.priceList) {
    showToast(`Đã chọn khách hàng "${customer.name}". Tự động áp chiết khấu theo bảng giá.`);
  }
}

// Lắng nghe sự kiện để đồng bộ render bảng khi load đơn nháp từ module history
document.addEventListener('loadDraftOrder', (e) => {
  const { order, isReadOnly } = e.detail;
  if (isReadOnly) {
    // A finalized read-only order keeps its immutable historical snapshots.
    renderInvoiceTable();
    return;
  }

  // Editable drafts/copies/amendments must be recalculated from the currently
  // applicable database price list. Otherwise the lines and source badge keep
  // stale prices from the previously viewed order while confirmation resolves
  // the customer's current price list on the server.
  applyActivePriceListToInvoice();
});

// Tải danh sách nhân viên quản lý chữ đỏ cho Thêm nhanh khách mới
export function populateQuickCustomerManagerDropdown() {
  const select = document.getElementById('quick-cust-manager');
  if (!select) return;
  
  const currentUser = state.currentUser;
  
  if (currentUser && currentUser.role === 'sale') {
    select.innerHTML = `
      <option value="${currentUser.username}">${currentUser.displayName} (${currentUser.isExternal ? 'Kinh doanh ngoài' : 'Sale'})</option>
    `;
    select.value = currentUser.username;
    select.setAttribute('disabled', 'true');
  } else {
    select.removeAttribute('disabled');
    select.innerHTML = `
      <option value="">-- Chọn nhân viên quản lý --</option>
      ${state.users.map(u => `
        <option value="${u.username}">${u.displayName} (${u.isExternal ? 'Kinh doanh ngoài' : (u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale')})</option>
      `).join('')}
    `;
    
    if (currentUser) {
      select.value = currentUser.username;
    } else {
      select.value = '';
    }
  }
}
