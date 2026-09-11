import { state } from '../state.js';
import { createPlatformCustomer, getPlatformActivePlans, getPlatformBillingConfiguration, getPlatformCustomerAccounts, getPlatformPlanCatalog, managePlatformCustomer, updatePlatformBillingConfiguration, updatePlatformPlan, validateSaasOrganizationSlug } from '../services/supabase.js?v=20260909-inline-filter-v4';
import { safeCreateIcons, showToast } from '../utils.js';

let platformDataLoaded = false;
let platformPlansLoaded = false;
let slugEditedManually = false;
let selectedPlatformOrganizationId = '';
let platformPlanCatalog = [];

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString('vi-VN');
}

const STATUS_LABELS = Object.freeze({
  trialing: 'Dùng thử', active: 'Đang hoạt động', past_due: 'Chậm thanh toán',
  suspended: 'Tạm ngưng', paused: 'Tạm dừng', cancelled: 'Đã hủy'
});

function statusLabel(value) {
  return STATUS_LABELS[value] || value || 'Chưa xác định';
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/đ/g, 'd')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 64);
}

function updatePlatformVisibility() {
  const nav = document.getElementById('platform-admin-nav');
  if (nav) nav.style.display = state.platformRole ? 'block' : 'none';
  const createButton = document.getElementById('btn-create-platform-customer');
  if (createButton) createButton.style.display = state.platformRole === 'platform_owner' ? 'inline-flex' : 'none';
  const planButton = document.getElementById('btn-manage-platform-plans');
  if (planButton) planButton.style.display = state.platformRole === 'platform_owner' ? 'inline-flex' : 'none';
  const billingButton = document.getElementById('btn-manage-platform-billing');
  if (billingButton) billingButton.style.display = state.platformRole === 'platform_owner' ? 'inline-flex' : 'none';
}

async function hydratePlatformPlans({ force = false } = {}) {
  if (platformPlansLoaded && !force) return state.platformPlans;
  if (!['platform_owner', 'billing'].includes(state.platformRole)) return [];
  state.platformPlans = await getPlatformActivePlans();
  platformPlansLoaded = true;
  const select = document.getElementById('platform-customer-plan');
  const planOptions = state.platformPlans.map(plan =>
      `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name || plan.id)}</option>`
    ).join('') || '<option value="starter">Starter</option>';
  if (select) {
    select.innerHTML = planOptions;
    if (state.platformPlans.some(plan => plan.id === 'starter')) select.value = 'starter';
    renderSelectedPlanNote();
  }
  const lifecycleSelect = document.getElementById('platform-lifecycle-plan');
  if (lifecycleSelect) lifecycleSelect.innerHTML = planOptions;
  return state.platformPlans;
}

export async function hydratePlatformAdmin({ force = false } = {}) {
  if (platformDataLoaded && !force) return state.platformRole || null;
  try {
    const data = await getPlatformCustomerAccounts();
    state.platformRole = String(data?.platformRole || '');
    state.platformOrganizations = Array.isArray(data?.organizations) ? data.organizations : [];
    state.platformSummary = data?.summary || null;
    platformDataLoaded = Boolean(state.platformRole);
  } catch (error) {
    if (error?.code !== '42501') console.warn('Could not load platform customer accounts:', error);
    state.platformRole = '';
    state.platformOrganizations = [];
    state.platformSummary = null;
    platformDataLoaded = false;
  }
  updatePlatformVisibility();
  renderPlatformAdmin();
  return state.platformRole || null;
}

function filteredOrganizations() {
  const query = String(document.getElementById('platform-account-search')?.value || '').trim().toLowerCase();
  const status = document.getElementById('platform-account-status')?.value || 'all';
  return state.platformOrganizations.filter(organization => {
    if (status !== 'all' && organization.status !== status && organization.subscriptionStatus !== status) return false;
    if (!query) return true;
    return [organization.name, organization.slug, organization.ownerName, organization.ownerEmail,
      organization.planName, organization.domain].some(value => String(value || '').toLowerCase().includes(query));
  });
}

function renderSummary() {
  const summary = state.platformSummary || {};
  const values = {
    'platform-total-organizations': summary.totalOrganizations || 0,
    'platform-active-organizations': summary.activeOrganizations || 0,
    'platform-trial-organizations': summary.trialOrganizations || 0,
    'platform-attention-organizations': summary.attentionOrganizations || 0
  };
  Object.entries(values).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) element.textContent = Number(value).toLocaleString('vi-VN');
  });
}

function renderDetail(organization) {
  const detail = document.getElementById('platform-account-detail');
  if (!detail || !organization) return;
  const canManage = state.platformRole === 'platform_owner' && organization.status !== 'archived';
  const isSuspended = organization.status === 'suspended' || organization.subscriptionStatus === 'paused';
  const isCancelled = organization.status === 'cancelled' || organization.subscriptionStatus === 'cancelled';
  detail.innerHTML = `
    <div class="platform-detail-heading">
      <div class="platform-account-avatar">${escapeHtml((organization.name || 'S').charAt(0).toUpperCase())}</div>
      <div><span>Hồ sơ doanh nghiệp</span><h3>${escapeHtml(organization.name)}</h3><p>${escapeHtml(organization.slug)}.sovie.vn</p></div>
    </div>
    <div class="platform-detail-grid">
      <div><span>Chủ tài khoản</span><strong>${escapeHtml(organization.ownerName || 'Chưa xác định')}</strong><small>${escapeHtml(organization.ownerEmail || '—')}${organization.ownerMembershipStatus === 'invited' ? ' · Đang chờ nhận lời mời' : ''}</small></div>
      <div><span>Gói dịch vụ</span><strong>${escapeHtml(organization.planName || organization.planId || 'Chưa có')}</strong><small>${escapeHtml(statusLabel(organization.subscriptionStatus))}</small></div>
      <div><span>Nhân sự</span><strong>${escapeHtml(organization.activeMemberCount || 0)} đang hoạt động</strong><small>${escapeHtml(organization.memberCount || 0)} tài khoản tổng cộng</small></div>
      <div><span>Tên miền</span><strong>${escapeHtml(organization.domain || `${organization.slug}.sovie.vn`)}</strong><small>${escapeHtml(statusLabel(organization.domainStatus))} · SSL ${escapeHtml(organization.sslStatus || 'pending')}</small></div>
      <div><span>Kỳ dịch vụ</span><strong>${escapeHtml(formatDate(organization.currentPeriodEnd))}</strong><small>${organization.readOnlyEndsAt ? `Chỉ đọc đến ${escapeHtml(formatDate(organization.readOnlyEndsAt))}` : 'Không có thời hạn chỉ đọc'}</small></div>
    </div>
    ${canManage ? `<div class="platform-lifecycle-actions">
      ${organization.subscriptionStatus === 'trialing' && organization.status === 'trialing' ? '<button type="button" class="btn btn-primary" data-platform-action="activate"><i data-lucide="circle-check-big"></i> Kích hoạt gói</button>' : ''}
      ${!isCancelled ? '<button type="button" class="btn btn-secondary" data-platform-action="change_plan"><i data-lucide="layers-3"></i> Đổi gói</button>' : ''}
      ${organization.subscriptionStatus === 'trialing' ? '<button type="button" class="btn btn-secondary" data-platform-action="extend_trial"><i data-lucide="calendar-plus"></i> Gia hạn trial</button>' : ''}
      ${!isCancelled && !isSuspended ? '<button type="button" class="btn btn-secondary is-warning" data-platform-action="suspend"><i data-lucide="pause-circle"></i> Tạm khóa</button>' : ''}
      ${isSuspended ? '<button type="button" class="btn btn-secondary is-success" data-platform-action="reactivate"><i data-lucide="play-circle"></i> Kích hoạt lại</button>' : ''}
      ${!isCancelled ? '<button type="button" class="btn btn-secondary is-danger" data-platform-action="cancel"><i data-lucide="ban"></i> Chấm dứt</button>' : ''}
    </div>` : ''}`;
  detail.querySelectorAll('[data-platform-action]').forEach(button => {
    button.addEventListener('click', () => void openPlatformLifecycleModal(button.dataset.platformAction, organization));
  });
  safeCreateIcons();
}

export function renderPlatformAdmin() {
  updatePlatformVisibility();
  if (!state.platformRole) return;
  renderSummary();
  const tbody = document.getElementById('platform-accounts-table-body');
  const count = document.getElementById('platform-account-result-count');
  if (!tbody) return;
  const organizations = filteredOrganizations();
  if (count) count.textContent = `${organizations.length} doanh nghiệp`;
  if (!organizations.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="platform-empty-state">Không tìm thấy doanh nghiệp phù hợp.</td></tr>';
    return;
  }
  tbody.innerHTML = organizations.map(organization => `
    <tr class="platform-account-row" data-organization-id="${escapeHtml(organization.id)}" tabindex="0">
      <td><div class="platform-account-cell"><span class="platform-account-avatar">${escapeHtml((organization.name || 'S').charAt(0).toUpperCase())}</span><div><strong>${escapeHtml(organization.name)}</strong><small>${escapeHtml(organization.slug)}.sovie.vn</small></div></div></td>
      <td><strong>${escapeHtml(organization.ownerName || 'Chưa xác định')}</strong><small>${escapeHtml(organization.ownerEmail || '—')}${organization.ownerMembershipStatus === 'invited' ? ' · Chờ xác nhận' : ''}</small></td>
      <td><span class="platform-status is-${escapeHtml(organization.subscriptionStatus || organization.status)}">${escapeHtml(organization.planName || organization.planId || 'Chưa có')} · ${escapeHtml(statusLabel(organization.subscriptionStatus || organization.status))}</span></td>
      <td><strong>${escapeHtml(organization.activeMemberCount || 0)}</strong><small>/${escapeHtml(organization.memberCount || 0)} tài khoản</small></td>
      <td><strong>${escapeHtml(organization.domain || `${organization.slug}.sovie.vn`)}</strong><small>SSL ${escapeHtml(organization.sslStatus || 'pending')}</small></td>
      <td><strong>${escapeHtml(formatDate(organization.createdAt))}</strong><small>${escapeHtml(statusLabel(organization.status))}</small></td>
    </tr>`).join('');

  const openDetail = row => {
    const organization = state.platformOrganizations.find(item => item.id === row?.dataset.organizationId);
    selectedPlatformOrganizationId = organization?.id || '';
    document.querySelectorAll('.platform-account-row').forEach(item => item.classList.toggle('is-selected', item === row));
    renderDetail(organization);
  };
  tbody.querySelectorAll('.platform-account-row').forEach(row => {
    row.addEventListener('click', () => openDetail(row));
    row.addEventListener('keydown', event => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); openDetail(row); }
    });
  });
  openDetail(tbody.querySelector(`[data-organization-id="${selectedPlatformOrganizationId}"]`) || tbody.querySelector('.platform-account-row'));
}

const LIFECYCLE_ACTIONS = Object.freeze({
  activate: {
    title: 'Kích hoạt gói dịch vụ', submit: 'Kích hoạt gói', icon: 'circle-check-big',
    warning: 'Chỉ xác nhận sau khi đã thu tiền hoặc có phê duyệt nội bộ. Gói sẽ có hiệu lực ngay và thời hạn bắt đầu từ hôm nay.'
  },
  change_plan: {
    title: 'Đổi gói dịch vụ', submit: 'Áp dụng gói mới', icon: 'layers-3',
    warning: 'Quota của doanh nghiệp được tính theo gói mới ngay sau khi xác nhận.'
  },
  extend_trial: {
    title: 'Gia hạn dùng thử', submit: 'Gia hạn trial', icon: 'calendar-plus',
    warning: 'Thời gian được cộng tiếp từ ngày hết hạn hiện tại hoặc từ hôm nay nếu trial đã quá hạn.'
  },
  suspend: {
    title: 'Tạm khóa khách hàng', submit: 'Tạm khóa', icon: 'pause-circle', danger: true,
    warning: 'Doanh nghiệp vẫn đọc và xuất dữ liệu nhưng mọi thao tác ghi sẽ bị khóa.'
  },
  reactivate: {
    title: 'Kích hoạt lại khách hàng', submit: 'Kích hoạt lại', icon: 'play-circle',
    warning: 'Quyền ghi dữ liệu được mở lại ngay theo gói dịch vụ hiện tại.'
  },
  cancel: {
    title: 'Chấm dứt khách hàng', submit: 'Chấm dứt dịch vụ', icon: 'ban', danger: true,
    warning: 'Subscription bị hủy và workspace chuyển sang chỉ đọc 30 ngày. Dữ liệu chưa bị xóa.'
  }
});

async function openPlatformLifecycleModal(action, organization) {
  if (state.platformRole !== 'platform_owner' || !organization) return;
  const config = LIFECYCLE_ACTIONS[action];
  const modal = document.getElementById('platform-lifecycle-modal');
  const form = document.getElementById('platform-lifecycle-form');
  if (!config || !modal || !form) return;
  if (['activate', 'change_plan'].includes(action)) {
    try { await hydratePlatformPlans(); }
    catch (error) { showToast(error?.message || 'Không thể tải danh mục gói.', 'danger'); return; }
  }
  form.reset();
  document.getElementById('platform-lifecycle-organization-id').value = organization.id;
  document.getElementById('platform-lifecycle-action').value = action;
  document.getElementById('platform-lifecycle-modal-title').textContent = config.title;
  document.getElementById('platform-lifecycle-customer-summary').innerHTML = `<strong>${escapeHtml(organization.name)}</strong><small>${escapeHtml(organization.slug)}.sovie.vn · ${escapeHtml(organization.planName || organization.planId || 'Chưa có')} · ${escapeHtml(statusLabel(organization.subscriptionStatus || organization.status))}</small>`;
  const planGroup = document.getElementById('platform-lifecycle-plan-group');
  const trialGroup = document.getElementById('platform-lifecycle-trial-group');
  const confirmationGroup = document.getElementById('platform-lifecycle-confirmation-group');
  const reason = document.getElementById('platform-lifecycle-reason');
  const confirmation = document.getElementById('platform-lifecycle-confirmation');
  const periodLabel = document.getElementById('platform-lifecycle-trial-days-label');
  const periodHelp = document.getElementById('platform-lifecycle-trial-days-help');
  planGroup.hidden = !['activate', 'change_plan'].includes(action);
  trialGroup.hidden = !['activate', 'extend_trial'].includes(action);
  confirmationGroup.hidden = action !== 'cancel';
  reason.required = ['activate', 'suspend', 'cancel'].includes(action);
  reason.minLength = reason.required ? 3 : 0;
  document.getElementById('platform-lifecycle-reason-required').textContent = reason.required ? '*' : '(không bắt buộc)';
  confirmation.required = action === 'cancel';
  confirmation.pattern = action === 'cancel' ? organization.slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : '';
  document.getElementById('platform-lifecycle-confirmation-help').textContent = action === 'cancel' ? `Nhập: ${organization.slug}` : '';
  if (['activate', 'change_plan'].includes(action)) document.getElementById('platform-lifecycle-plan').value = organization.planId || 'starter';
  if (action === 'activate') {
    periodLabel.textContent = 'Thời hạn gói *';
    periodHelp.textContent = 'Cấp gói từ 1 đến 3.650 ngày kể từ hôm nay.';
    document.getElementById('platform-lifecycle-trial-days').value = '30';
  } else if (action === 'extend_trial') {
    periodLabel.textContent = 'Số ngày gia hạn *';
    periodHelp.textContent = 'Cộng tiếp từ ngày hết hạn hiện tại, tối đa 60 ngày mỗi lần.';
    document.getElementById('platform-lifecycle-trial-days').value = '7';
  }
  document.getElementById('platform-lifecycle-warning').textContent = config.warning;
  const submit = document.getElementById('btn-submit-platform-lifecycle');
  submit.classList.toggle('btn-danger', Boolean(config.danger));
  submit.classList.toggle('btn-primary', !config.danger);
  submit.innerHTML = `<i data-lucide="${config.icon}"></i> ${escapeHtml(config.submit)}`;
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  safeCreateIcons();
}

function closePlatformLifecycleModal() {
  const modal = document.getElementById('platform-lifecycle-modal');
  modal?.classList.remove('active');
  modal?.setAttribute('aria-hidden', 'true');
}

async function submitPlatformLifecycle(event) {
  event.preventDefault();
  if (state.platformRole !== 'platform_owner' || !event.currentTarget.reportValidity()) return;
  const submit = document.getElementById('btn-submit-platform-lifecycle');
  const original = submit?.innerHTML || '';
  const payload = Object.fromEntries(new FormData(event.currentTarget).entries());
  if (submit) { submit.disabled = true; submit.textContent = 'Đang cập nhật...'; }
  try {
    await managePlatformCustomer(payload);
    selectedPlatformOrganizationId = payload.organizationId;
    closePlatformLifecycleModal();
    await hydratePlatformAdmin({ force: true });
    showToast('Đã cập nhật vòng đời khách hàng và ghi nhật ký quản trị.', 'success');
  } catch (error) {
    showToast(error?.message || 'Không thể cập nhật khách hàng SaaS.', 'danger');
  } finally {
    if (submit) { submit.disabled = false; submit.innerHTML = original; safeCreateIcons(); }
  }
}

function fillPlatformPlanForm(plan) {
  if (!plan) return;
  const limits = plan.limits || {};
  document.getElementById('platform-plan-id').value = plan.id;
  document.getElementById('platform-plan-name').value = plan.name || '';
  document.getElementById('platform-plan-description').value = plan.description || '';
  document.getElementById('platform-plan-price-monthly').value = Number(plan.priceMonthly || 0);
  document.getElementById('platform-plan-price-yearly').value = Number(plan.priceYearly || 0);
  document.getElementById('platform-plan-currency').value = plan.currency || 'VND';
  document.getElementById('platform-plan-users').value = Number(limits.users || 1);
  document.getElementById('platform-plan-branches').value = Number(limits.branches || 1);
  document.getElementById('platform-plan-warehouses').value = Number(limits.warehouses || 1);
  document.getElementById('platform-plan-orders').value = Number(limits.monthly_orders || 1);
  document.getElementById('platform-plan-domains').value = Number(limits.custom_domains || 0);
  document.getElementById('platform-plan-sort-order').value = Number(plan.sortOrder ?? 100);
  document.getElementById('platform-plan-active').checked = Boolean(plan.isActive);
  document.getElementById('platform-plan-public').checked = Boolean(plan.isPublic);
  updatePlatformPlanWarning();
}

function updatePlatformPlanWarning() {
  const monthly = Number(document.getElementById('platform-plan-price-monthly')?.value || 0);
  const yearly = Number(document.getElementById('platform-plan-price-yearly')?.value || 0);
  const isPublic = document.getElementById('platform-plan-public')?.checked;
  const warning = document.getElementById('platform-plan-price-warning');
  if (!warning) return;
  warning.classList.toggle('is-danger', Boolean(isPublic && (monthly <= 0 || yearly <= 0)));
  warning.textContent = isPublic && (monthly <= 0 || yearly <= 0)
    ? 'Gói đang công khai nhưng giá tháng hoặc năm vẫn bằng 0. Hãy kiểm tra kỹ trước khi lưu.'
    : 'Giá và quota mới áp dụng ngay; yêu cầu thanh toán vẫn chờ cấu hình cổng thanh toán thật.';
}

async function openPlatformPlanModal() {
  if (state.platformRole !== 'platform_owner') return;
  const modal = document.getElementById('platform-plan-modal');
  if (!modal) return;
  try {
    platformPlanCatalog = await getPlatformPlanCatalog();
  } catch (error) {
    showToast(error?.message || 'Không thể tải bảng giá SaaS.', 'danger');
    return;
  }
  const select = document.getElementById('platform-plan-id');
  select.innerHTML = platformPlanCatalog.map(plan =>
    `<option value="${escapeHtml(plan.id)}">${escapeHtml(plan.name || plan.id)}${plan.isActive ? '' : ' · Đã tắt'}</option>`
  ).join('');
  fillPlatformPlanForm(platformPlanCatalog[0]);
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
}

function closePlatformPlanModal() {
  const modal = document.getElementById('platform-plan-modal');
  modal?.classList.remove('active');
  modal?.setAttribute('aria-hidden', 'true');
}

async function submitPlatformPlan(event) {
  event.preventDefault();
  if (state.platformRole !== 'platform_owner' || !event.currentTarget.reportValidity()) return;
  const fields = Object.fromEntries(new FormData(event.currentTarget).entries());
  fields.isActive = document.getElementById('platform-plan-active').checked;
  fields.isPublic = document.getElementById('platform-plan-public').checked;
  if (fields.isPublic && !fields.isActive) {
    showToast('Gói công khai phải đồng thời ở trạng thái hoạt động.', 'danger');
    return;
  }
  const submit = document.getElementById('btn-submit-platform-plan');
  const original = submit?.innerHTML || '';
  if (submit) { submit.disabled = true; submit.textContent = 'Đang lưu...'; }
  try {
    const updated = await updatePlatformPlan(fields);
    platformPlanCatalog = platformPlanCatalog.map(plan => plan.id === updated.id ? updated : plan);
    platformPlansLoaded = false;
    await hydratePlatformAdmin({ force: true });
    fillPlatformPlanForm(updated);
    showToast(`Đã cập nhật gói ${updated.name}.`, 'success');
  } catch (error) {
    showToast(error?.message || 'Không thể cập nhật bảng giá SaaS.', 'danger');
  } finally {
    if (submit) { submit.disabled = false; submit.innerHTML = original; safeCreateIcons(); }
  }
}

function syncPlatformBillingTaxMode() {
  const isNotSubject = document.getElementById('platform-billing-tax-mode')?.value === 'not_subject';
  const group = document.getElementById('platform-billing-vat-rate-group');
  const input = document.getElementById('platform-billing-vat-rate');
  if (group) group.hidden = isNotSubject;
  if (input) {
    input.required = !isNotSubject;
    if (isNotSubject) input.value = '0';
  }
}

function renderPlatformBillingReadiness(configuration = {}) {
  const readiness = document.getElementById('platform-billing-readiness');
  if (!readiness) return;
  const rows = [
    [configuration.pricesReady, 'Giá tháng/năm của các gói công khai'],
    [configuration.taxReady, 'Chính sách VAT'],
    [Boolean(configuration.issuerName && configuration.issuerTaxCode), 'Thông tin xuất hóa đơn'],
    [configuration.billingEnabled, 'Thanh toán MoMo đang được mở']
  ];
  readiness.innerHTML = rows.map(([ready, label]) =>
    `<span class="${ready ? 'is-ready' : 'is-pending'}"><i data-lucide="${ready ? 'circle-check' : 'circle-dashed'}"></i>${escapeHtml(label)}</span>`
  ).join('');
  safeCreateIcons();
}

async function openPlatformBillingModal() {
  if (state.platformRole !== 'platform_owner') return;
  try {
    const configuration = await getPlatformBillingConfiguration();
    document.getElementById('platform-billing-tax-mode').value = configuration?.taxMode || 'exclusive';
    document.getElementById('platform-billing-vat-rate').value = configuration?.vatRate ?? '';
    document.getElementById('platform-billing-issuer-name').value = configuration?.issuerName || '';
    document.getElementById('platform-billing-tax-code').value = configuration?.issuerTaxCode || '';
    document.getElementById('platform-billing-enabled').checked = Boolean(configuration?.billingEnabled);
    syncPlatformBillingTaxMode();
    renderPlatformBillingReadiness(configuration);
    const modal = document.getElementById('platform-billing-modal');
    modal?.classList.add('active');
    modal?.setAttribute('aria-hidden', 'false');
  } catch (error) {
    showToast(error?.message || 'Không thể tải cấu hình thanh toán.', 'danger');
  }
}

function closePlatformBillingModal() {
  const modal = document.getElementById('platform-billing-modal');
  modal?.classList.remove('active');
  modal?.setAttribute('aria-hidden', 'true');
}

async function submitPlatformBilling(event) {
  event.preventDefault();
  if (state.platformRole !== 'platform_owner' || !event.currentTarget.reportValidity()) return;
  const fields = Object.fromEntries(new FormData(event.currentTarget).entries());
  fields.billingEnabled = document.getElementById('platform-billing-enabled').checked;
  const submit = document.getElementById('btn-submit-platform-billing');
  const original = submit?.innerHTML || '';
  if (submit) { submit.disabled = true; submit.textContent = 'Đang lưu...'; }
  try {
    const configuration = await updatePlatformBillingConfiguration(fields);
    renderPlatformBillingReadiness(configuration);
    showToast('Đã lưu cấu hình MoMo và chính sách thuế.', 'success');
  } catch (error) {
    showToast(error?.message || 'Không thể lưu cấu hình thanh toán.', 'danger');
  } finally {
    if (submit) { submit.disabled = false; submit.innerHTML = original; safeCreateIcons(); }
  }
}

function setSlugStatus(message, type = '') {
  const status = document.getElementById('platform-customer-slug-status');
  if (!status) return;
  status.textContent = message;
  status.className = `platform-field-status${type ? ` is-${type}` : ''}`;
}

async function validatePlatformSlug() {
  const input = document.getElementById('platform-customer-slug');
  const slug = String(input?.value || '').trim().toLowerCase();
  if (!input?.checkValidity()) {
    setSlugStatus('Tên miền cần 3–64 ký tự: chữ thường, số hoặc dấu gạch ngang.', 'danger');
    return false;
  }
  setSlugStatus('Đang kiểm tra tên miền...');
  try {
    const result = await validateSaasOrganizationSlug(slug);
    if (!result?.available) {
      setSlugStatus(result?.reserved ? 'Tên miền này được hệ thống giữ lại.' : 'Tên miền này đã được sử dụng.', 'danger');
      return false;
    }
    setSlugStatus(`${slug}.sovie.vn đang khả dụng.`, 'success');
    return true;
  } catch (error) {
    setSlugStatus(error?.message || 'Không thể kiểm tra tên miền.', 'danger');
    return false;
  }
}

function renderSelectedPlanNote() {
  const planId = document.getElementById('platform-customer-plan')?.value;
  const plan = state.platformPlans.find(item => item.id === planId);
  const note = document.getElementById('platform-customer-plan-note');
  if (!note) return;
  const limits = plan?.limits || {};
  note.textContent = plan
    ? `${Number(limits.users || 0)} người dùng · ${Number(limits.monthly_orders || 0).toLocaleString('vi-VN')} đơn/tháng`
    : '';
}

async function openPlatformCustomerModal() {
  if (state.platformRole !== 'platform_owner') return;
  const modal = document.getElementById('platform-customer-modal');
  const form = document.getElementById('platform-customer-form');
  if (!modal || !form) return;
  form.reset();
  document.getElementById('platform-customer-trial-days').value = '14';
  document.getElementById('platform-customer-industry').value = 'general';
  slugEditedManually = false;
  setSlugStatus('Dùng chữ thường, số và dấu gạch ngang.');
  try {
    await hydratePlatformPlans();
  } catch (error) {
    showToast(error?.message || 'Không thể tải danh mục gói dịch vụ.', 'danger');
    return;
  }
  modal.classList.add('active');
  modal.setAttribute('aria-hidden', 'false');
  document.getElementById('platform-customer-name')?.focus();
}

function closePlatformCustomerModal() {
  const modal = document.getElementById('platform-customer-modal');
  modal?.classList.remove('active');
  modal?.setAttribute('aria-hidden', 'true');
}

async function submitPlatformCustomer(event) {
  event.preventDefault();
  if (state.platformRole !== 'platform_owner') return;
  const form = event.currentTarget;
  if (!form.reportValidity() || !await validatePlatformSlug()) return;
  const submit = document.getElementById('btn-submit-platform-customer');
  const original = submit?.innerHTML || '';
  if (submit) { submit.disabled = true; submit.textContent = 'Đang khởi tạo...'; }
  const fields = Object.fromEntries(new FormData(form).entries());
  try {
    const result = await createPlatformCustomer(fields);
    closePlatformCustomerModal();
    const invitationText = result?.invitationSent ? 'Email thiết lập mật khẩu đã được gửi.' : 'Tài khoản đã tồn tại và được gắn lời mời workspace.';
    showToast(`Đã tạo khách hàng SaaS. ${invitationText}`, 'success');
    try {
      await hydratePlatformAdmin({ force: true });
    } catch (refreshError) {
      console.warn('Customer created but platform list refresh failed', refreshError);
      showToast('Khách hàng đã được tạo; danh sách sẽ được cập nhật ở lần tải lại tiếp theo.', 'warning');
    }
  } catch (error) {
    const rawMessage = String(error?.message || 'Không thể tạo khách hàng SaaS.');
    try {
      await hydratePlatformAdmin({ force: true });
      const normalizedSlug = String(fields.slug || '').trim().toLowerCase();
      const normalizedEmail = String(fields.ownerEmail || '').trim().toLowerCase();
      const reconciled = state.platformOrganizations.find(item =>
        String(item?.slug || '').toLowerCase() === normalizedSlug
        && String(item?.ownerEmail || '').toLowerCase() === normalizedEmail
      );
      if (reconciled) {
        closePlatformCustomerModal();
        showToast('Khách hàng đã được tạo thành công và vừa được đồng bộ lại.', 'success');
        return;
      }
    } catch (refreshError) {
      console.warn('Unable to reconcile customer creation after an uncertain response', refreshError);
    }
    const message = /rate limit/i.test(rawMessage)
      ? 'Supabase đang giới hạn gửi email. Vui lòng thử lại sau hoặc cấu hình SMTP riêng.'
      : rawMessage;
    showToast(message, 'danger');
  } finally {
    if (submit) { submit.disabled = false; submit.innerHTML = original; safeCreateIcons(); }
  }
}

export function setupPlatformAdmin() {
  document.getElementById('platform-account-search')?.addEventListener('input', renderPlatformAdmin);
  document.getElementById('platform-account-status')?.addEventListener('change', renderPlatformAdmin);
  document.getElementById('btn-create-platform-customer')?.addEventListener('click', openPlatformCustomerModal);
  document.getElementById('btn-manage-platform-plans')?.addEventListener('click', openPlatformPlanModal);
  document.getElementById('btn-manage-platform-billing')?.addEventListener('click', openPlatformBillingModal);
  document.getElementById('btn-close-platform-customer')?.addEventListener('click', closePlatformCustomerModal);
  document.getElementById('btn-cancel-platform-customer')?.addEventListener('click', closePlatformCustomerModal);
  document.getElementById('platform-customer-modal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closePlatformCustomerModal();
  });
  document.getElementById('platform-customer-form')?.addEventListener('submit', submitPlatformCustomer);
  document.getElementById('platform-customer-name')?.addEventListener('input', event => {
    if (!slugEditedManually) document.getElementById('platform-customer-slug').value = slugify(event.target.value);
  });
  document.getElementById('platform-customer-slug')?.addEventListener('input', event => {
    slugEditedManually = true;
    event.target.value = slugify(event.target.value);
    setSlugStatus('Nhấn ra ngoài để kiểm tra tên miền.');
  });
  document.getElementById('platform-customer-slug')?.addEventListener('blur', () => void validatePlatformSlug());
  document.getElementById('platform-customer-plan')?.addEventListener('change', renderSelectedPlanNote);
  document.getElementById('btn-close-platform-lifecycle')?.addEventListener('click', closePlatformLifecycleModal);
  document.getElementById('btn-cancel-platform-lifecycle')?.addEventListener('click', closePlatformLifecycleModal);
  document.getElementById('platform-lifecycle-modal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closePlatformLifecycleModal();
  });
  document.getElementById('platform-lifecycle-form')?.addEventListener('submit', submitPlatformLifecycle);
  document.getElementById('btn-close-platform-plan')?.addEventListener('click', closePlatformPlanModal);
  document.getElementById('btn-cancel-platform-plan')?.addEventListener('click', closePlatformPlanModal);
  document.getElementById('platform-plan-modal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closePlatformPlanModal();
  });
  document.getElementById('platform-plan-form')?.addEventListener('submit', submitPlatformPlan);
  document.getElementById('platform-plan-id')?.addEventListener('change', event => {
    fillPlatformPlanForm(platformPlanCatalog.find(plan => plan.id === event.target.value));
  });
  document.getElementById('platform-plan-price-monthly')?.addEventListener('input', updatePlatformPlanWarning);
  document.getElementById('platform-plan-price-yearly')?.addEventListener('input', updatePlatformPlanWarning);
  document.getElementById('platform-plan-public')?.addEventListener('change', updatePlatformPlanWarning);
  document.getElementById('btn-close-platform-billing')?.addEventListener('click', closePlatformBillingModal);
  document.getElementById('btn-cancel-platform-billing')?.addEventListener('click', closePlatformBillingModal);
  document.getElementById('platform-billing-modal')?.addEventListener('click', event => {
    if (event.target === event.currentTarget) closePlatformBillingModal();
  });
  document.getElementById('platform-billing-form')?.addEventListener('submit', submitPlatformBilling);
  document.getElementById('platform-billing-tax-mode')?.addEventListener('change', syncPlatformBillingTaxMode);
  document.getElementById('btn-refresh-platform-accounts')?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await hydratePlatformAdmin({ force: true });
      showToast('Đã cập nhật danh sách doanh nghiệp.', 'success');
    } finally {
      button.disabled = false;
    }
  });
}

export function clearPlatformAdminState() {
  platformDataLoaded = false;
  platformPlansLoaded = false;
  state.platformRole = '';
  state.platformOrganizations = [];
  state.platformSummary = null;
  state.platformPlans = [];
  selectedPlatformOrganizationId = '';
  platformPlanCatalog = [];
  updatePlatformVisibility();
}
