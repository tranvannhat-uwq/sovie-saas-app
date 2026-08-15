import { state } from '../state.js';
import { dbFetchActivityLogs, dbFetchOrderActivity } from '../services/supabase.js?v=20260814-invoice-discount-label-v19';
import { switchTab } from '../main.js?v=20260814-invoice-discount-label-v19';
import { getOrderDisplayCode } from '../domain/order-display.js?v=20260814-invoice-discount-label-v19';
import { safeCreateIcons, showToast } from '../utils.js';

const PAGE_SIZE = 20;
let activityPage = 1;
let latestRows = [];

const ACTION_LABELS = {
  create_order: 'Đã tạo đơn hàng', update_order: 'Đã chỉnh sửa đơn hàng', change_order_status: 'Đã thay đổi trạng thái đơn hàng',
  create_draft_order: 'Đã tạo đơn nháp', update_draft_order: 'Đã chỉnh sửa đơn nháp', update_draft_order_notes: 'Đã cập nhật ghi chú đơn nháp', delete_draft_order: 'Đã xóa đơn nháp',
  cancel_order: 'Đã hủy đơn hàng', delete_order: 'Đã xóa đơn hàng', update_order_notes: 'Đã cập nhật ghi chú đơn hàng',
  confirm_payment: 'Đã xác nhận thanh toán', change_payment_status: 'Đã thay đổi trạng thái thanh toán', update_payment: 'Đã cập nhật thanh toán',
  create_customer: 'Đã tạo khách hàng', update_customer: 'Đã chỉnh sửa khách hàng', delete_customer: 'Đã xóa khách hàng',
  create_employee: 'Đã tạo nhân viên', update_employee: 'Đã chỉnh sửa nhân viên', delete_employee: 'Đã xóa nhân viên',
  change_employee_role: 'Đã thay đổi vai trò nhân viên', change_employee_status: 'Đã khóa/mở tài khoản',
  create_sales_return: 'Đã tạo phiếu trả hàng', update_sales_return: 'Đã cập nhật phiếu trả hàng', cancel_sales_return: 'Đã hủy phiếu trả hàng',
  create_cashbook_transaction: 'Đã tạo giao dịch sổ quỹ', update_cashbook_transaction: 'Đã chỉnh sửa giao dịch sổ quỹ', cancel_cashbook_transaction: 'Đã hủy giao dịch sổ quỹ',
  create_supplier: 'Đã tạo nhà cung cấp', update_supplier: 'Đã chỉnh sửa nhà cung cấp', delete_supplier: 'Đã xóa nhà cung cấp',
  create_purchase: 'Đã tạo phiếu mua hàng', update_purchase: 'Đã chỉnh sửa phiếu mua hàng', cancel_purchase: 'Đã hủy phiếu mua hàng',
  create_product: 'Đã tạo sản phẩm', update_product: 'Đã chỉnh sửa sản phẩm', delete_product: 'Đã xóa sản phẩm',
  create_brand: 'Đã tạo hãng sơn', update_brand: 'Đã chỉnh sửa hãng sơn', delete_brand: 'Đã xóa hãng sơn',
  create_pricelist: 'Đã tạo bảng giá', update_pricelist: 'Đã chỉnh sửa bảng giá', delete_pricelist: 'Đã xóa bảng giá',
  create_price: 'Đã thêm giá sản phẩm', update_price: 'Đã sửa giá sản phẩm', delete_price: 'Đã xóa giá sản phẩm'
};
const MODULE_LABELS = { orders: 'Đơn hàng', customers: 'Khách hàng', employees: 'Nhân viên', payments: 'Thanh toán', returns: 'Trả hàng', cashbook: 'Sổ quỹ', suppliers: 'Nhà cung cấp', purchases: 'Mua hàng', products: 'Sản phẩm', brands: 'Hãng sơn', pricelists: 'Bảng giá' };
const FIELD_LABELS = { status: 'Trạng thái', notes: 'Ghi chú', phone: 'Số điện thoại', phone2: 'Số điện thoại 2', address: 'Địa chỉ', customer_name: 'Tên khách hàng', customer_phone: 'Số điện thoại khách hàng', customer_address: 'Địa chỉ khách hàng', recipient_name: 'Người nhận', recipient_phone: 'Số điện thoại người nhận', shipping_address: 'Địa chỉ giao hàng', shipping_unit: 'Đơn vị vận chuyển', shipping_code: 'Mã vận đơn', name: 'Tên', quantity: 'Số lượng', items: 'Sản phẩm', subtotal: 'Tiền hàng', total_market: 'Tổng tiền hàng', total_payable: 'Tổng thanh toán', total_amount: 'Tổng tiền', paid_amount: 'Đã thanh toán', debt: 'Công nợ', debt_amount: 'Công nợ', net_revenue: 'Doanh thu thuần', last_order_at: 'Thời gian đơn hàng gần nhất', total_transaction: 'Tổng giao dịch', discount_value: 'Mức giảm giá', discount_amount: 'Giảm giá', discount_percent: 'Phần trăm giảm giá', discount_type: 'Hình thức giảm giá', shipping_support: 'Hỗ trợ vận chuyển', shipping_discount: 'Giảm phí vận chuyển', shipping_fee: 'Phí vận chuyển', shipping_fee_value: 'Mức phí vận chuyển', shipping_fee_amount: 'Phí vận chuyển', extra_fee: 'Thu khác', other_fee: 'Thu khác', other_fee_value: 'Mức thu khác', other_fee_amount: 'Số tiền thu khác', other_fee_type: 'Hình thức thu khác', payment_method: 'Phương thức thanh toán', payment_status: 'Trạng thái thanh toán', role: 'Vai trò', is_active: 'Trạng thái tài khoản', managed_by: 'Nhân viên phụ trách', pricelist_name: 'Bảng giá', price_list_name: 'Bảng giá', date: 'Ngày đơn hàng', order_date: 'Ngày đơn hàng' };
const HIDDEN_ACTIVITY_FIELDS = new Set([
  'id', 'company_id', 'customer_id', 'product_id', 'variant_id', 'pricelist_id', 'price_list_id',
  'created_by', 'updated_by', 'deleted_by', 'cancelled_by', 'canceled_by', 'salesperson_id',
  'auth_user_id', 'idempotency_key', 'request_fingerprint', 'operation_key', 'saved_at',
  'created_at', 'updated_at', 'deleted_at', 'cancelled_at', 'canceled_at', 'confirmed_at'
]);

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const canViewAll = () => ['admin', 'accounting'].includes(String(state.currentUser?.role || '').toLowerCase());
const formatTime = value => new Date(value).toLocaleString('vi-VN', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit', year: 'numeric' });
const formatMoney = value => `${Number(value || 0).toLocaleString('vi-VN')} đ`;
const EMPTY_VALUE = 'Không có';

function parseStructuredValue(value) {
  if (Array.isArray(value) || (value && typeof value === 'object')) return value;
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || !['[', '{'].includes(trimmed.charAt(0))) return value;
  try { return JSON.parse(trimmed); } catch (_) { return value; }
}

function displayValue(value) {
  const parsed = parseStructuredValue(value);
  if (parsed === null || parsed === undefined || parsed === '') return EMPTY_VALUE;
  if (parsed === true || parsed === 'true') return 'Có';
  if (parsed === false || parsed === 'false') return 'Không';
  if (Array.isArray(parsed)) return parsed.length ? `${parsed.length} mục` : EMPTY_VALUE;
  if (typeof parsed === 'object') {
    const parts = Object.entries(parsed)
      .filter(([, item]) => item !== null && item !== '' && typeof item !== 'object')
      .slice(0, 8)
      .map(([key, item]) => `${FIELD_LABELS[key] || key}: ${item}`);
    return parts.length ? parts.join(' · ') : EMPTY_VALUE;
  }
  return String(parsed);
}

function itemIdentity(item, index) {
  return String(item?.variantId || item?.productId || item?.productCode || item?.baseCode || item?.variantCode || item?.id || item?.productName || item?.name || `item-${index}`);
}

function itemTitle(item) {
  const code = item?.productCode || item?.baseCode || item?.variantCode || '';
  const name = item?.productName || item?.name || 'Sản phẩm';
  return code && !String(name).includes(code) ? `${code} · ${name}` : name;
}

function itemQuantity(item) {
  return Number(item?.quantity ?? item?.qty ?? 0);
}

function itemPrice(item) {
  return Number(item?.finalUnitPrice ?? item?.unitPrice ?? item?.price ?? item?.listPrice ?? 0);
}

function renderItemsDiff(change) {
  const oldItems = parseStructuredValue(change?.old);
  const newItems = parseStructuredValue(change?.new);
  if (!Array.isArray(oldItems) && !Array.isArray(newItems)) return '';
  const before = new Map((Array.isArray(oldItems) ? oldItems : []).map((item, index) => [itemIdentity(item, index), item]));
  const after = new Map((Array.isArray(newItems) ? newItems : []).map((item, index) => [itemIdentity(item, index), item]));
  const keys = [...new Set([...before.keys(), ...after.keys()])];
  const rows = keys.map(key => {
    const oldItem = before.get(key);
    const newItem = after.get(key);
    if (!oldItem) return `<li class="activity-item-change added"><strong>${escapeHtml(itemTitle(newItem))}</strong><span>Đã thêm · SL ${itemQuantity(newItem)} · ${formatMoney(itemPrice(newItem))}</span></li>`;
    if (!newItem) return `<li class="activity-item-change removed"><strong>${escapeHtml(itemTitle(oldItem))}</strong><span>Đã xóa · SL ${itemQuantity(oldItem)} · ${formatMoney(itemPrice(oldItem))}</span></li>`;
    const details = [];
    if (itemQuantity(oldItem) !== itemQuantity(newItem)) details.push(`Số lượng: ${itemQuantity(oldItem)} → ${itemQuantity(newItem)}`);
    if (itemPrice(oldItem) !== itemPrice(newItem)) details.push(`Đơn giá: ${formatMoney(itemPrice(oldItem))} → ${formatMoney(itemPrice(newItem))}`);
    if (itemTitle(oldItem) !== itemTitle(newItem)) details.push(`Sản phẩm: ${itemTitle(oldItem)} → ${itemTitle(newItem)}`);
    return details.length ? `<li class="activity-item-change updated"><strong>${escapeHtml(itemTitle(newItem))}</strong><span>${escapeHtml(details.join(' · '))}</span></li>` : '';
  }).filter(Boolean);
  return `<article class="activity-diff activity-items-diff"><strong>Sản phẩm</strong><div class="activity-items-summary"><span>${before.size} sản phẩm trước</span><i data-lucide="arrow-right"></i><span>${after.size} sản phẩm sau</span></div>${rows.length ? `<ul>${rows.join('')}</ul>` : '<p>Danh sách sản phẩm không có thay đổi đáng kể.</p>'}</article>`;
}

function renderFieldDiff(field, change) {
  if (field === 'items') return renderItemsDiff(change);
  return `<article class="activity-diff"><strong>${escapeHtml(FIELD_LABELS[field] || field)}</strong><div class="activity-diff-values"><div><span>Trước</span><pre>${escapeHtml(displayValue(change?.old))}</pre></div><i data-lucide="arrow-right"></i><div><span>Sau</span><pre>${escapeHtml(displayValue(change?.new))}</pre></div></div></article>`;
}
const actionLabel = action => ACTION_LABELS[action] || 'Đã thực hiện thay đổi';

function isVisibleActivityField(field) {
  if (!field || HIDDEN_ACTIVITY_FIELDS.has(field)) return false;
  if (field === 'managed_by') return true;
  if (/(?:_id|Id)$/.test(field)) return false;
  if (/(?:_by|By)$/.test(field)) return false;
  return !/(?:fingerprint|password|secret|token)/i.test(field);
}

function visibleChanges(row) {
  return Object.entries(row?.changes || {}).filter(([field]) => isVisibleActivityField(field));
}

function activityTargetHtml(row) {
  const id = row.order_id || row.target_id;
  if (row.order_id) {
    const displayCode = getOrderDisplayCode({ id: row.order_id, created_at: row.created_at });
    return `<button class="activity-target-link" data-order-id="${escapeHtml(row.order_id)}" title="Mở đơn ${escapeHtml(displayCode)}">#${escapeHtml(displayCode)}</button>`;
  }
  return `<strong>${escapeHtml(row.target_name || id)}</strong>`;
}

function activitySummary(row) {
  const count = visibleChanges(row).length;
  return `${actionLabel(row.action)} ${activityTargetHtml(row)}${count > 1 ? `<span class="activity-change-count">${count} thay đổi</span>` : ''}`;
}

function navigateToOrder(orderId) {
  switchTab('history-panel');
  const input = document.getElementById('order-search-input');
  if (input) { input.value = orderId; input.dispatchEvent(new Event('input')); }
  document.getElementById('activity-dropdown')?.classList.remove('active');
}

function bindTargetLinks(root = document) {
  root.querySelectorAll('.activity-target-link').forEach(button => {
    button.onclick = event => { event.stopPropagation(); navigateToOrder(button.dataset.orderId); };
  });
}

export function openActivityDetail(rowOrId) {
  const row = typeof rowOrId === 'string' ? latestRows.find(item => item.id === rowOrId) : rowOrId;
  if (!row) return;
  const changes = visibleChanges(row);
  document.getElementById('activity-detail-body').innerHTML = `
    <div class="activity-detail-meta"><div><span>Người thực hiện</span><strong>${escapeHtml(row.actor_name)}</strong></div><div><span>Thời gian</span><strong>${formatTime(row.created_at)}</strong></div><div><span>Hoạt động</span><strong>${actionLabel(row.action)}</strong></div><div><span>Đối tượng</span>${activityTargetHtml(row)}</div></div>
    <h4>Những thay đổi (${changes.length})</h4>
    <div class="activity-diff-list">${changes.length ? changes.map(([field, change]) => renderFieldDiff(field, change)).join('') : '<p class="activity-empty">Không có thay đổi nghiệp vụ cần hiển thị.</p>'}</div>`;
  document.getElementById('activity-detail-modal').classList.add('active');
  bindTargetLinks(document.getElementById('activity-detail-body'));
  safeCreateIcons();
}

function rowHtml(row) {
  return `<tr class="activity-row" data-activity-id="${escapeHtml(row.id)}"><td><div class="activity-actor"><span class="activity-avatar">${escapeHtml((row.actor_name || '?').trim().charAt(0).toUpperCase())}</span><div><strong>${escapeHtml(row.actor_name)}</strong><small>${escapeHtml(row.actor_username || '')}</small></div></div></td><td><div class="activity-summary">${activitySummary(row)}</div></td><td><span class="activity-module-badge">${escapeHtml(MODULE_LABELS[row.module] || row.module)}</span></td><td>${formatTime(row.created_at)}</td><td><button class="btn btn-secondary btn-sm activity-detail-btn" data-id="${escapeHtml(row.id)}"><i data-lucide="eye"></i></button></td></tr>`;
}

function currentFilters(limit = PAGE_SIZE, offset = (activityPage - 1) * PAGE_SIZE) {
  return { search: document.getElementById('activity-search')?.value.trim() || '', actor_id: document.getElementById('activity-actor-filter')?.value || 'all', module: document.getElementById('activity-module-filter')?.value || 'all', action: document.getElementById('activity-action-filter')?.value || 'all', start: document.getElementById('activity-start-filter')?.value ? `${document.getElementById('activity-start-filter').value}T00:00:00+07:00` : null, end: document.getElementById('activity-end-filter')?.value ? `${document.getElementById('activity-end-filter').value}T23:59:59+07:00` : null, limit, offset };
}

export async function renderActivityLog() {
  const body = document.getElementById('activity-log-body');
  if (!body) return;
  if (!canViewAll()) {
    body.innerHTML = '<tr><td colspan="5" class="activity-empty">Tài khoản này không có quyền xem toàn bộ lịch sử hoạt động.</td></tr>';
    return;
  }
  const actorFilter = document.getElementById('activity-actor-filter');
  if (actorFilter && actorFilter.options.length <= 1) actorFilter.innerHTML = '<option value="all">Tất cả nhân viên</option>' + (state.users || []).map(user => `<option value="${escapeHtml(user.authUserId || user.id)}">${escapeHtml(user.displayName || user.username)}</option>`).join('');
  body.innerHTML = '<tr><td colspan="5" class="activity-empty">Đang tải lịch sử hoạt động...</td></tr>';
  try {
    const rawResult = await dbFetchActivityLogs(currentFilters());
    const result = typeof rawResult === 'string' ? JSON.parse(rawResult) : rawResult;
    latestRows = result.rows || [];
    body.innerHTML = latestRows.length ? latestRows.map(rowHtml).join('') : '<tr><td colspan="5" class="activity-empty">Không có hoạt động phù hợp.</td></tr>';
    const pages = Math.max(1, Math.ceil(Number(result.total || 0) / PAGE_SIZE));
    document.getElementById('activity-page-info').textContent = `Trang ${activityPage}/${pages} · ${Number(result.total || 0)} hoạt động`;
    document.getElementById('activity-prev').disabled = activityPage <= 1;
    document.getElementById('activity-next').disabled = activityPage >= pages;
    bindTargetLinks(body);
    body.querySelectorAll('.activity-detail-btn').forEach(button => button.onclick = () => openActivityDetail(button.dataset.id));
    safeCreateIcons();
  } catch (error) {
    body.innerHTML = `<tr><td colspan="5" class="activity-empty">${escapeHtml(error.message || 'Không tải được lịch sử hoạt động.')}</td></tr>`;
  }
}

async function renderActivityDropdown() {
  const list = document.getElementById('activity-dropdown-list');
  if (!list || !canViewAll()) return;
  list.innerHTML = '<div class="activity-empty">Đang tải...</div>';
  try {
    const result = await dbFetchActivityLogs({ limit: PAGE_SIZE, offset: 0 });
    latestRows = [...(result.rows || []), ...latestRows.filter(old => !(result.rows || []).some(row => row.id === old.id))];
    list.innerHTML = result.rows?.length ? result.rows.map(row => {
      const changeCount = visibleChanges(row).length;
      return `<article class="activity-dropdown-item" data-id="${escapeHtml(row.id)}" role="button" tabindex="0"><span class="activity-avatar">${escapeHtml((row.actor_name || '?').charAt(0).toUpperCase())}</span><span class="activity-dropdown-content"><strong>${escapeHtml(row.actor_name)}</strong><span class="activity-dropdown-action">${escapeHtml(actionLabel(row.action))}</span><span class="activity-dropdown-info">${changeCount > 1 ? `<span class="activity-change-count">${changeCount} thay đổi</span>` : '<span></span>'}<small>${formatTime(row.created_at)}</small></span><span class="activity-dropdown-meta">${activityTargetHtml(row)}</span></span></article>`;
    }).join('') : '<div class="activity-empty">Chưa có hoạt động.</div>';
    bindTargetLinks(list);
    list.querySelectorAll('.activity-dropdown-item').forEach(card => {
      card.onclick = event => { if (!event.target.closest('.activity-target-link')) openActivityDetail(card.dataset.id); };
      card.onkeydown = event => {
        if (!['Enter', ' '].includes(event.key) || event.target.closest('.activity-target-link')) return;
        event.preventDefault();
        openActivityDetail(card.dataset.id);
      };
    });
  } catch (error) { list.innerHTML = '<div class="activity-empty">Không tải được lịch sử.</div>'; }
}

export async function openOrderActivityModal(orderId) {
  const modal = document.getElementById('order-activity-modal');
  const body = document.getElementById('order-activity-body');
  if (!modal || !body) return;
  modal.classList.add('active'); body.innerHTML = '<div class="activity-empty">Đang tải lịch sử đơn hàng...</div>';
  try {
    const rows = await dbFetchOrderActivity(orderId);
    latestRows = [...rows, ...latestRows.filter(old => !rows.some(row => row.id === old.id))];
    body.innerHTML = rows.length ? `<div class="activity-timeline">${rows.map(row => `<button class="activity-timeline-item" data-id="${escapeHtml(row.id)}"><time>${formatTime(row.created_at)}</time><span><strong>${escapeHtml(row.actor_name)}</strong> ${escapeHtml(actionLabel(row.action).toLowerCase())}</span></button>`).join('')}</div>` : '<div class="activity-empty">Chưa có hoạt động được ghi cho đơn này.</div>';
    body.querySelectorAll('.activity-timeline-item').forEach(button => button.onclick = () => openActivityDetail(button.dataset.id));
  } catch (error) { body.innerHTML = `<div class="activity-empty">${escapeHtml(error.message)}</div>`; }
}

export function setupActivityLog() {
  const actorFilter = document.getElementById('activity-actor-filter');
  if (actorFilter) actorFilter.innerHTML = '<option value="all">Tất cả nhân viên</option>' + (state.users || []).map(user => `<option value="${escapeHtml(user.authUserId || user.id)}">${escapeHtml(user.displayName || user.username)}</option>`).join('');
  const button = document.getElementById('btn-activity-log');
  const dropdown = document.getElementById('activity-dropdown');
  if (button) button.onclick = async event => { event.stopPropagation(); dropdown.classList.toggle('active'); if (dropdown.classList.contains('active')) await renderActivityDropdown(); };
  document.addEventListener('click', event => { if (!event.target.closest('.activity-header-wrap')) dropdown?.classList.remove('active'); });
  document.getElementById('activity-view-all')?.addEventListener('click', () => {
    activityPage = 1;
    dropdown.classList.remove('active');
    switchTab('activity-log-panel');
  });
  ['activity-search','activity-actor-filter','activity-module-filter','activity-action-filter','activity-start-filter','activity-end-filter'].forEach(id => document.getElementById(id)?.addEventListener(id === 'activity-search' ? 'input' : 'change', () => { activityPage = 1; renderActivityLog(); }));
  document.getElementById('activity-prev')?.addEventListener('click', () => { if (activityPage > 1) { activityPage--; renderActivityLog(); } });
  document.getElementById('activity-next')?.addEventListener('click', () => { activityPage++; renderActivityLog(); });
  document.getElementById('activity-detail-close')?.addEventListener('click', () => document.getElementById('activity-detail-modal').classList.remove('active'));
  document.getElementById('order-activity-close')?.addEventListener('click', () => document.getElementById('order-activity-modal').classList.remove('active'));
  globalThis.openOrderActivityModal = openOrderActivityModal;
}
