import { state } from '../state.js';
import { showToast, safeCreateIcons } from '../utils.js';
import {
  createSaasOrganization,
  disableSaasCustomDomain,
  getSaasCustomDomainVerification,
  provisionSaasCustomDomain,
  requestSaasCustomDomain,
  requestSaasOrganizationArchive,
  requestSaasPlanChange,
  saveSaasBranch,
  saveSaasWarehouse,
  setPrimarySaasCustomDomain,
  verifySaasCustomDomainDns,
  validateSaasOrganizationSlug
} from '../services/supabase.js?v=20260831-provisioning-v2';

let onboardingRequired = false;
let slugWasEdited = false;
let slugValidationSequence = 0;

function normalizeSlug(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function setSlugStatus(message = '', tone = 'muted') {
  const status = document.getElementById('workspace-slug-status');
  if (!status) return;
  const colors = { success: '#22c55e', danger: '#ef4444', muted: 'var(--text-secondary)' };
  status.textContent = message;
  status.style.color = colors[tone] || colors.muted;
}

async function validateSlugInput({ quiet = false } = {}) {
  const slugInput = document.getElementById('workspace-slug');
  const slug = normalizeSlug(slugInput?.value);
  if (slugInput) slugInput.value = slug;
  if (slug.length < 3) {
    if (!quiet) setSlugStatus('Tên miền cần ít nhất 3 ký tự.', 'danger');
    return false;
  }

  const sequence = ++slugValidationSequence;
  if (!quiet) setSlugStatus('Đang kiểm tra tên miền...', 'muted');
  try {
    const result = await validateSaasOrganizationSlug(slug);
    if (sequence !== slugValidationSequence) return false;
    if (!result?.validFormat) {
      setSlugStatus('Chỉ dùng chữ thường, số và dấu gạch ngang.', 'danger');
      return false;
    }
    if (result?.reserved) {
      setSlugStatus('Tên miền này được hệ thống giữ lại.', 'danger');
      return false;
    }
    if (!result?.available) {
      setSlugStatus('Tên miền này đã được sử dụng.', 'danger');
      return false;
    }
    setSlugStatus(`${slug}.sovie.vn đang khả dụng.`, 'success');
    return true;
  } catch (error) {
    if (sequence === slugValidationSequence) {
      setSlugStatus(error?.message || 'Không thể kiểm tra tên miền.', 'danger');
    }
    return false;
  }
}

export function renderWorkspaceSwitcher() {
  const nameLabel = document.getElementById('workspace-current-name');
  const domainLabel = document.getElementById('workspace-current-domain');
  const usageLabel = document.getElementById('workspace-plan-usage');

  if (nameLabel) nameLabel.textContent = state.saasContext?.organizationName || 'Chưa có doanh nghiệp';
  if (domainLabel) {
    domainLabel.textContent = state.saasContext?.organizationSlug
      ? `${state.saasContext.organizationSlug}.sovie.vn`
      : 'Thiết lập workspace để bắt đầu';
  }
  if (usageLabel) {
    const usage = state.saasContext?.planUsage || {};
    const orders = usage.orders || {};
    const members = usage.members || {};
    const formatLimit = value => Number(value) < 0 ? 'Không giới hạn' : Number(value || 0).toLocaleString('vi-VN');
    usageLabel.textContent = usage.planId
      ? `${String(usage.planId).toUpperCase()} · Đơn ${Number(orders.used || 0).toLocaleString('vi-VN')}/${formatLimit(orders.limit)} · Thành viên ${Number(members.used || 0).toLocaleString('vi-VN')}/${formatLimit(members.limit)}`
      : '';
  }
  const backupSection = document.getElementById('backup-section');
  if (backupSection) {
    backupSection.style.display = ['owner','admin'].includes(state.currentUser?.organizationRole)
      ? 'block' : 'none';
  }
  renderCustomDomainManagement();
  renderBillingManagement();
  renderLocationManagement();
  renderOrganizationArchiveManagement();
}

export function renderSubscriptionAccessNotice() {
  const notice = document.getElementById('subscription-access-notice');
  const access = state.saasContext?.subscriptionAccess || {};
  const mode = String(access.accessMode || 'full');
  document.body.dataset.subscriptionAccess = mode;
  if (!notice) return;

  if (mode === 'full') {
    notice.style.display = 'none';
    notice.textContent = '';
    return;
  }

  notice.style.display = 'block';
  notice.className = `subscription-access-notice is-${mode}`;
  if (mode === 'grace') {
    const deadline = access.graceEndsAt ? new Date(access.graceEndsAt).toLocaleDateString('vi-VN') : '7 ngày tới';
    notice.textContent = `Gói dịch vụ đang quá hạn thanh toán. Workspace vẫn được ghi dữ liệu đến ${deadline}; Owner cần gia hạn để tránh chuyển sang chỉ đọc.`;
  } else {
    notice.textContent = 'Workspace đang ở chế độ chỉ đọc do gói dịch vụ tạm dừng hoặc đã hủy. Dữ liệu và chức năng xuất vẫn được giữ; các thao tác ghi bị database chặn.';
  }
}

export function renderCustomDomainManagement() {
  const section = document.getElementById('custom-domain-section');
  const list = document.getElementById('custom-domain-list');
  const input = document.getElementById('custom-domain-hostname');
  const submit = document.getElementById('btn-request-custom-domain');
  const isOwner = state.currentUser?.organizationRole === 'owner';
  const domainLimit = Number(state.businessCapabilities?.planLimits?.custom_domains || 0);
  const domains = Array.isArray(state.businessCapabilities?.domains)
    ? state.businessCapabilities.domains
    : [];
  if (section) section.style.display = isOwner ? 'block' : 'none';
  if (!isOwner || !list) return;

  const customDomains = domains.filter(domain => domain.domain_type === 'custom' && domain.status !== 'disabled');
  list.innerHTML = customDomains.length ? customDomains.map(domain => `
    <div class="custom-domain-row">
      <div><strong>${domain.hostname}</strong><small>${domain.status} · SSL ${domain.ssl_status}${domain.is_primary ? ' · Tên miền chính' : ''}</small></div>
      <div class="custom-domain-actions">
        ${domain.status !== 'active' ? `<button type="button" class="btn btn-secondary btn-xs domain-verification-btn" data-id="${domain.id}">Bản ghi TXT</button>` : ''}
        ${['pending','failed'].includes(domain.status) ? `<button type="button" class="btn btn-primary btn-xs domain-dns-check-btn" data-id="${domain.id}">Kiểm tra DNS</button>` : ''}
        ${domain.status === 'verified' ? `<button type="button" class="btn btn-primary btn-xs domain-ssl-btn" data-id="${domain.id}">Cấp/kiểm tra SSL</button>` : ''}
        ${domain.status === 'active' && domain.ssl_status === 'active' && !domain.is_primary ? `<button type="button" class="btn btn-primary btn-xs domain-primary-btn" data-id="${domain.id}">Đặt làm chính</button>` : ''}
        <button type="button" class="btn btn-danger btn-xs domain-disable-btn" data-id="${domain.id}">Vô hiệu hóa</button>
      </div>
    </div>
  `).join('') : '<p class="custom-domain-empty">Chưa đăng ký custom domain.</p>';

  const remaining = Math.max(0, domainLimit - customDomains.length);
  if (input) input.disabled = remaining < 1;
  if (submit) {
    submit.disabled = remaining < 1;
    submit.textContent = domainLimit < 1 ? 'Plan hiện tại chưa hỗ trợ' : `Đăng ký (${remaining} còn lại)`;
  }

  list.querySelectorAll('.domain-verification-btn').forEach(button => button.addEventListener('click', async () => {
    try {
      const result = await getSaasCustomDomainVerification(button.dataset.id);
      const verification = result?.verification || {};
      const output = document.getElementById('custom-domain-verification-output');
      if (output) {
        output.style.display = 'block';
        output.textContent = `Tạo bản ghi ${verification.type || 'TXT'}\nTên: ${verification.name || ''}\nGiá trị: ${verification.value || ''}`;
      }
    } catch (error) {
      showToast(error?.message || 'Không thể tải hướng dẫn xác minh.', 'danger');
    }
  }));
  list.querySelectorAll('.domain-primary-btn').forEach(button => button.addEventListener('click', async () => {
    try {
      await setPrimarySaasCustomDomain(button.dataset.id);
      showToast('Đã đổi tên miền chính. Đang tải lại cấu hình...', 'success');
      window.location.reload();
    } catch (error) {
      showToast(error?.message || 'Không thể đổi tên miền chính.', 'danger');
    }
  }));
  list.querySelectorAll('.domain-dns-check-btn').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await verifySaasCustomDomainDns(button.dataset.id);
      if (result?.verified) {
        showToast('DNS đã được xác minh. SSL đang chờ cấp phát.', 'success');
        window.location.reload();
      } else {
        showToast('Chưa tìm thấy TXT chính xác. Hãy kiểm tra DNS và thử lại sau một phút.', 'warning');
      }
    } catch (error) {
      button.disabled = false;
      showToast(error?.message || 'Không thể kiểm tra DNS.', 'danger');
    }
  }));
  list.querySelectorAll('.domain-ssl-btn').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await provisionSaasCustomDomain(button.dataset.id);
      const output = document.getElementById('custom-domain-verification-output');
      if (result?.ready) {
        showToast('Cloudflare đã kích hoạt hostname và SSL.', 'success');
        window.location.reload();
      } else {
        if (output) {
          output.style.display = 'block';
          output.textContent = `SSL đang xử lý.\nCNAME cần trỏ tới: ${result?.cnameTarget || 'chưa cấu hình'}\nHostname: ${result?.hostnameStatus || 'pending'}\nSSL: ${result?.sslStatus || 'pending'}`;
        }
        showToast('Đã gửi yêu cầu cấp SSL. Hãy cấu hình CNAME rồi kiểm tra lại.', 'warning');
        button.disabled = false;
      }
    } catch (error) {
      button.disabled = false;
      showToast(error?.message || 'Không thể cấp SSL.', 'danger');
    }
  }));
  list.querySelectorAll('.domain-disable-btn').forEach(button => button.addEventListener('click', async () => {
    if (!confirm('Vô hiệu hóa custom domain này? Subdomain sovie.vn vẫn được giữ.')) return;
    try {
      await disableSaasCustomDomain(button.dataset.id);
      showToast('Đã vô hiệu hóa custom domain.', 'warning');
      window.location.reload();
    } catch (error) {
      showToast(error?.message || 'Không thể vô hiệu hóa tên miền.', 'danger');
    }
  }));
}

function escapeWorkspaceText(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[character]);
}

export function renderBillingManagement() {
  const section = document.getElementById('billing-management-section');
  const content = document.getElementById('billing-management-content');
  const isOwner = state.currentUser?.organizationRole === 'owner';
  if (section) section.style.display = isOwner ? 'block' : 'none';
  if (!isOwner || !content) return;
  const summary = state.saasContext?.billingSummary || {};
  const subscription = summary.subscription || {};
  const plans = Array.isArray(summary.plans) ? summary.plans : [];
  const invoices = Array.isArray(summary.invoices) ? summary.invoices : [];
  const currentPlan = String(subscription.plan_id || 'starter');
  const money = (value, currency = 'VND') => new Intl.NumberFormat('vi-VN', {
    style: 'currency', currency: String(currency || 'VND')
  }).format(Number(value || 0));
  content.innerHTML = `
    <p class="billing-current">Gói hiện tại: <strong>${escapeWorkspaceText(currentPlan.toUpperCase())}</strong> · ${escapeWorkspaceText(subscription.status || 'chưa kích hoạt')}</p>
    <div class="billing-plan-grid">${plans.map(plan => `
      <div class="billing-plan-card"><strong>${escapeWorkspaceText(plan.name)}</strong>
        <small>${escapeWorkspaceText(plan.description || '')}</small>
        <span>${money(plan.priceMonthly, plan.currency)}/tháng</span>
        <span>${money(plan.priceYearly, plan.currency)}/năm</span>
        <div class="billing-plan-actions">
          <button type="button" class="btn btn-primary btn-xs billing-plan-btn" data-plan="${escapeWorkspaceText(plan.id)}" data-cycle="monthly" ${plan.id === currentPlan || Number(plan.priceMonthly || 0) <= 0 ? 'disabled' : ''}>${plan.id === currentPlan ? 'Đang dùng' : 'Đăng ký tháng'}</button>
          <button type="button" class="btn btn-secondary btn-xs billing-plan-btn" data-plan="${escapeWorkspaceText(plan.id)}" data-cycle="yearly" ${plan.id === currentPlan || Number(plan.priceYearly || 0) <= 0 ? 'disabled' : ''}>${plan.id === currentPlan ? 'Đang dùng' : 'Đăng ký năm'}</button>
        </div>
      </div>`).join('')}</div>
    <div class="billing-invoice-list">${invoices.length ? invoices.map(invoice => `
      <div class="billing-invoice-row"><span><strong>${escapeWorkspaceText(invoice.invoice_number || invoice.provider_invoice_id)}</strong><small>${escapeWorkspaceText(invoice.status)}</small></span><strong>${money(invoice.total, invoice.currency)}</strong></div>
    `).join('') : '<p class="custom-domain-empty">Chưa có hóa đơn.</p>'}</div>`;
  content.querySelectorAll('.billing-plan-btn').forEach(button => button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const result = await requestSaasPlanChange(button.dataset.plan, button.dataset.cycle || 'monthly');
      if (!result?.checkout?.payUrl) throw new Error('MoMo không trả về đường dẫn thanh toán.');
      button.textContent = 'Đang mở MoMo...';
      window.location.assign(result.checkout.payUrl);
    } catch (error) {
      button.disabled = false;
      showToast(error?.message || 'Không thể gửi yêu cầu đổi gói.', 'danger');
    }
  }));
}

function locationLimitText(used, limit) {
  return `${used}/${Number(limit) < 0 ? 'Không giới hạn' : Number(limit || 0).toLocaleString('vi-VN')}`;
}

function populateLocationForm(kind, row) {
  const prefix = kind === 'branch' ? 'branch' : 'warehouse';
  const form = document.getElementById(`${prefix}-management-form`);
  if (!form || !row) return;
  form.querySelector(`[name="${prefix}_id"]`).value = row.id || '';
  form.querySelector(`[name="${prefix}_code"]`).value = row.code || '';
  form.querySelector(`[name="${prefix}_name"]`).value = row.name || '';
  form.querySelector(`[name="${prefix}_address"]`).value = row.address || '';
  if (kind === 'warehouse') form.querySelector('[name="warehouse_branch_id"]').value = row.branch_id || '';
  form.querySelector('button[type="submit"]').textContent = 'Lưu thay đổi';
  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

export function renderLocationManagement() {
  const section = document.getElementById('location-management-section');
  const branchList = document.getElementById('branch-management-list');
  const warehouseList = document.getElementById('warehouse-management-list');
  const branchCount = document.getElementById('branch-management-count');
  const warehouseCount = document.getElementById('warehouse-management-count');
  const role = state.currentUser?.organizationRole;
  const canManage = role === 'owner' || role === 'admin';
  if (section) section.style.display = canManage ? 'block' : 'none';
  if (!canManage || !branchList || !warehouseList) return;

  const capabilities = state.businessCapabilities || {};
  const branches = Array.isArray(capabilities.branches) ? capabilities.branches : [];
  const warehouses = Array.isArray(capabilities.warehouses) ? capabilities.warehouses : [];
  const branchLimit = Number(capabilities.planLimits?.branches ?? 1);
  const warehouseLimit = Number(capabilities.planLimits?.warehouses ?? 1);
  if (branchCount) branchCount.textContent = locationLimitText(branches.length, branchLimit);
  if (warehouseCount) warehouseCount.textContent = locationLimitText(warehouses.length, warehouseLimit);

  const branchSelect = document.querySelector('#warehouse-management-form [name="warehouse_branch_id"]');
  if (branchSelect) branchSelect.innerHTML = `<option value="">Không gắn chi nhánh</option>${branches.map(branch =>
    `<option value="${escapeWorkspaceText(branch.id)}">${escapeWorkspaceText(branch.code)} · ${escapeWorkspaceText(branch.name)}</option>`
  ).join('')}`;

  branchList.innerHTML = branches.length ? branches.map(branch => `<div class="location-row">
    <div><strong>${escapeWorkspaceText(branch.code)} · ${escapeWorkspaceText(branch.name)}</strong><small>${escapeWorkspaceText(branch.address || 'Chưa có địa chỉ')}${branch.is_default ? ' · Mặc định' : ''}</small></div>
    <div class="location-actions"><button type="button" class="btn btn-secondary btn-xs location-edit" data-kind="branch" data-id="${escapeWorkspaceText(branch.id)}">Sửa</button>${branch.is_default ? '' : `<button type="button" class="btn btn-primary btn-xs location-default" data-kind="branch" data-id="${escapeWorkspaceText(branch.id)}">Đặt mặc định</button><button type="button" class="btn btn-danger btn-xs location-disable" data-kind="branch" data-id="${escapeWorkspaceText(branch.id)}">Ngừng dùng</button>`}</div>
  </div>`).join('') : '<p class="custom-domain-empty">Chưa có chi nhánh hoạt động.</p>';

  warehouseList.innerHTML = warehouses.length ? warehouses.map(warehouse => {
    const branch = branches.find(item => String(item.id) === String(warehouse.branch_id));
    return `<div class="location-row"><div><strong>${escapeWorkspaceText(warehouse.code)} · ${escapeWorkspaceText(warehouse.name)}</strong><small>${escapeWorkspaceText(warehouse.address || 'Chưa có địa chỉ')}${branch ? ` · ${escapeWorkspaceText(branch.name)}` : ''}${warehouse.is_default ? ' · Mặc định' : ''}</small></div>
      <div class="location-actions"><button type="button" class="btn btn-secondary btn-xs location-edit" data-kind="warehouse" data-id="${escapeWorkspaceText(warehouse.id)}">Sửa</button>${warehouse.is_default ? '' : `<button type="button" class="btn btn-primary btn-xs location-default" data-kind="warehouse" data-id="${escapeWorkspaceText(warehouse.id)}">Đặt mặc định</button><button type="button" class="btn btn-danger btn-xs location-disable" data-kind="warehouse" data-id="${escapeWorkspaceText(warehouse.id)}">Ngừng dùng</button>`}</div></div>`;
  }).join('') : '<p class="custom-domain-empty">Chưa có kho hoạt động.</p>';

  section.querySelectorAll('.location-edit').forEach(button => button.addEventListener('click', () => {
    const rows = button.dataset.kind === 'branch' ? branches : warehouses;
    populateLocationForm(button.dataset.kind, rows.find(row => String(row.id) === button.dataset.id));
  }));
  section.querySelectorAll('.location-default, .location-disable').forEach(button => button.addEventListener('click', async () => {
    const isBranch = button.dataset.kind === 'branch';
    const rows = isBranch ? branches : warehouses;
    const row = rows.find(item => String(item.id) === button.dataset.id);
    if (!row) return;
    button.disabled = true;
    try {
      const payload = { ...row, isDefault: button.classList.contains('location-default') || row.is_default, isActive: !button.classList.contains('location-disable') };
      await (isBranch ? saveSaasBranch(payload) : saveSaasWarehouse(payload));
      showToast('Đã cập nhật cấu hình chi nhánh/kho.', 'success');
      window.location.reload();
    } catch (error) {
      button.disabled = false;
      showToast(error?.message || 'Không thể cập nhật chi nhánh/kho.', 'danger');
    }
  }));
}

export function renderOrganizationArchiveManagement() {
  const section = document.getElementById('organization-archive-section');
  const status = document.getElementById('organization-archive-status');
  const submit = document.querySelector('#organization-archive-form button[type="submit"]');
  const isOwner = state.currentUser?.organizationRole === 'owner';
  if (section) section.style.display = isOwner ? 'block' : 'none';
  if (!isOwner || !status) return;
  const access = state.saasContext?.subscriptionAccess || {};
  const cancelled = access.status === 'cancelled';
  const eligibleAt = access.readOnlyEndsAt ? new Date(access.readOnlyEndsAt) : null;
  const eligible = cancelled && eligibleAt && eligibleAt.getTime() <= Date.now();
  status.textContent = !cancelled
    ? 'Chỉ có thể yêu cầu lưu trữ sau khi subscription đã hủy.'
    : eligible
      ? `Đã hết thời gian chỉ đọc. Nhập chính xác “${state.saasContext?.organizationSlug || ''}” và mã/file backup đã kiểm tra.`
      : `Workspace còn quyền đọc/xuất đến ${eligibleAt?.toLocaleDateString('vi-VN') || 'hết 30 ngày sau hủy'}.`;
  if (submit) submit.disabled = !eligible;
}

export function openWorkspaceOnboarding({ required = false } = {}) {
  onboardingRequired = required;
  slugWasEdited = false;
  const modal = document.getElementById('workspace-onboarding-modal');
  const form = document.getElementById('workspace-onboarding-form');
  const closeButton = document.getElementById('btn-close-workspace-onboarding');
  const cancelButton = document.getElementById('btn-cancel-workspace-onboarding');
  const intro = document.getElementById('workspace-onboarding-intro');
  if (form) form.reset();
  if (closeButton) closeButton.style.display = required ? 'none' : '';
  if (cancelButton) cancelButton.style.display = required ? 'none' : '';
  if (intro) {
    intro.textContent = required
      ? 'Tạo workspace đầu tiên để bắt đầu dùng SoVie. Bạn được dùng thử gói Starter trong 14 ngày.'
      : 'Tạo thêm một workspace độc lập cho doanh nghiệp hoặc thương hiệu khác.';
  }
  setSlugStatus('Địa chỉ truy cập sẽ có dạng ten-doanh-nghiep.sovie.vn.');
  modal?.classList.add('active');
  document.getElementById('workspace-name')?.focus();
  safeCreateIcons();
}

function closeWorkspaceOnboarding() {
  if (onboardingRequired) return;
  document.getElementById('workspace-onboarding-modal')?.classList.remove('active');
}

export function setupWorkspaceManagement() {
  const form = document.getElementById('workspace-onboarding-form');
  const nameInput = document.getElementById('workspace-name');
  const slugInput = document.getElementById('workspace-slug');
  const domainForm = document.getElementById('custom-domain-form');
  const branchForm = document.getElementById('branch-management-form');
  const warehouseForm = document.getElementById('warehouse-management-form');
  const archiveForm = document.getElementById('organization-archive-form');

  document.getElementById('btn-close-workspace-onboarding')?.addEventListener('click', closeWorkspaceOnboarding);
  document.getElementById('btn-cancel-workspace-onboarding')?.addEventListener('click', closeWorkspaceOnboarding);

  nameInput?.addEventListener('input', () => {
    if (!slugWasEdited && slugInput) slugInput.value = normalizeSlug(nameInput.value);
  });
  slugInput?.addEventListener('input', () => {
    slugWasEdited = true;
    slugInput.value = normalizeSlug(slugInput.value);
    setSlugStatus('Nhấn ra ngoài ô để kiểm tra tên miền.');
  });
  slugInput?.addEventListener('blur', () => void validateSlugInput());
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const submitButton = form.querySelector('button[type="submit"]');
    if (!await validateSlugInput()) return;
    if (submitButton) submitButton.disabled = true;
    try {
      await createSaasOrganization({
        name: document.getElementById('workspace-name')?.value,
        slug: document.getElementById('workspace-slug')?.value,
        businessType: document.getElementById('workspace-business-type')?.value,
        industryKey: document.getElementById('workspace-industry')?.value
      });
      showToast('Workspace đã được tạo. Đang khởi tạo dữ liệu doanh nghiệp...', 'success');
      window.location.reload();
    } catch (error) {
      showToast(error?.message || 'Không thể tạo workspace.', 'danger');
      if (submitButton) submitButton.disabled = false;
    }
  });

  domainForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const hostname = document.getElementById('custom-domain-hostname')?.value || '';
    const button = document.getElementById('btn-request-custom-domain');
    if (button) button.disabled = true;
    try {
      const result = await requestSaasCustomDomain(hostname);
      const verification = result?.verification || {};
      const output = document.getElementById('custom-domain-verification-output');
      if (output) {
        output.style.display = 'block';
        output.textContent = `Tạo bản ghi ${verification.type || 'TXT'}\nTên: ${verification.name || ''}\nGiá trị: ${verification.value || ''}`;
      }
      showToast('Đã đăng ký tên miền. Hãy tạo bản ghi TXT để xác minh.', 'success');
    } catch (error) {
      showToast(error?.message || 'Không thể đăng ký custom domain.', 'danger');
    } finally {
      if (button) button.disabled = false;
    }
  });

  branchForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = branchForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const branchId = branchForm.elements.branch_id.value || null;
      const existing = (state.businessCapabilities?.branches || []).find(row => String(row.id) === String(branchId));
      await saveSaasBranch({
        id: branchId,
        code: branchForm.elements.branch_code.value,
        name: branchForm.elements.branch_name.value,
        address: branchForm.elements.branch_address.value,
        phone: existing?.phone,
        email: existing?.email,
        taxCode: existing?.tax_code,
        isDefault: existing?.is_default === true,
        isActive: existing?.is_active !== false
      });
      showToast('Đã lưu chi nhánh.', 'success');
      window.location.reload();
    } catch (error) {
      submit.disabled = false;
      showToast(error?.message || 'Không thể lưu chi nhánh.', 'danger');
    }
  });

  warehouseForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = warehouseForm.querySelector('button[type="submit"]');
    submit.disabled = true;
    try {
      const warehouseId = warehouseForm.elements.warehouse_id.value || null;
      const existing = (state.businessCapabilities?.warehouses || []).find(row => String(row.id) === String(warehouseId));
      await saveSaasWarehouse({
        id: warehouseId,
        branchId: warehouseForm.elements.warehouse_branch_id.value || null,
        code: warehouseForm.elements.warehouse_code.value,
        name: warehouseForm.elements.warehouse_name.value,
        address: warehouseForm.elements.warehouse_address.value,
        isDefault: existing?.is_default === true,
        isActive: existing?.is_active !== false
      });
      showToast('Đã lưu kho.', 'success');
      window.location.reload();
    } catch (error) {
      submit.disabled = false;
      showToast(error?.message || 'Không thể lưu kho.', 'danger');
    }
  });

  archiveForm?.addEventListener('submit', async event => {
    event.preventDefault();
    const submit = archiveForm.querySelector('button[type="submit"]');
    if (!confirm('Gửi yêu cầu soft-archive workspace? Dữ liệu không bị xóa nhưng mọi thành viên sẽ mất quyền truy cập sau khi back-office duyệt.')) return;
    submit.disabled = true;
    try {
      const result = await requestSaasOrganizationArchive({
        confirmationSlug: archiveForm.elements.archive_confirmation_slug.value,
        backupReference: archiveForm.elements.archive_backup_reference.value,
        reason: archiveForm.elements.archive_reason.value
      });
      showToast(result?.duplicate ? 'Yêu cầu lưu trữ đang chờ xử lý.' : 'Đã gửi yêu cầu lưu trữ để back-office kiểm tra.', 'success');
    } catch (error) {
      submit.disabled = false;
      showToast(error?.message || 'Không thể gửi yêu cầu lưu trữ.', 'danger');
    }
  });

  renderWorkspaceSwitcher();
  renderSubscriptionAccessNotice();
}
