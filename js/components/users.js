import { state, resetTenantBusinessState } from '../state.js';
import { showToast, safeCreateIcons, isSameUser, getCompanyNameById } from '../utils.js';
import { dbSaveUser, dbDeleteUser, isCloudActive, supabaseClient, fetchCloudData, clearSupabaseAuthStorage, getMaintenanceStatus, loadSaasContext, clearTenantStorageContext, transferSaasOrganizationOwnership } from '../services/supabase.js?v=20260831-provisioning-v2';
import { startRealtimeSync, stopRealtimeSync } from '../services/realtime.js?v=20260831-provisioning-v2';
import { renderAll, switchTab } from '../main.js?v=20260831-provisioning-v2';
import { populateManagedByDropdown } from './customers.js?v=20260831-provisioning-v2';
import { openWorkspaceOnboarding, renderWorkspaceSwitcher, renderSubscriptionAccessNotice } from './workspaces.js?v=20260831-provisioning-v2';
import { clearPlatformAdminState, hydratePlatformAdmin } from './platform-admin.js?v=20260831-provisioning-v2';
import {
  LOGIN_ERROR,
  classifySupabaseError,
  loginErrorMessage,
  validateProfileRows
} from '../domain/auth-profile.js';

export function renderUsersTable() {
  const tableBody = document.getElementById('users-table-body');
  if (!tableBody) return;
  
  const searchInput = document.getElementById('user-search-input');
  const searchVal = searchInput ? searchInput.value.toLowerCase().trim() : '';
  
  const filtered = (state.users || []).filter(u => {
    if (!u) return false;
    const uname = (u.username || u.code || '').toLowerCase();
    const dname = (u.displayName || u.display_name || u.name || '').toLowerCase();
    return uname.includes(searchVal) || dname.includes(searchVal);
  });
  
  if (filtered.length === 0) {
    tableBody.innerHTML = `
      <tr>
        <td colspan="7" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Không tìm thấy tài khoản người dùng nào
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = filtered.map((u, index) => {
    const roleText = u.isExternal ? (u.jobTitle || (u.employmentType === 'contractor' ? 'Cộng tác viên' : u.employmentType === 'external' ? 'Đối tác ngoài' : 'Nhân sự')) :
                     (u.role === 'owner' ? 'Owner' : u.role === 'admin' ? 'Admin (Toàn quyền)' :
                      u.role === 'accounting' ? 'Kế toán' : 'Sale (Kinh doanh)');
    const roleColor = u.isExternal ? '#a0aec0' : 
                      (u.role === 'owner' ? '#f59e0b' : u.role === 'admin' ? 'var(--color-danger)' :
                       u.role === 'accounting' ? 'var(--color-secondary)' : 'var(--color-primary)');
                      
    const compName = getCompanyNameById(u.companyId || u.company_id, state.companies);
    const dName = u.displayName || u.display_name || u.name || u.username;
    const membershipStatus = u.membershipStatus || (u.isActive === false ? (u.isExternal ? 'inactive' : 'suspended') : 'active');
    const active = membershipStatus === 'active';
    const statusText = membershipStatus === 'invited' ? 'Đã gửi lời mời' : active ? 'Hoạt động' : u.isExternal ? 'Ngừng hoạt động' : 'Đã khóa';
    const statusClass = membershipStatus === 'invited' ? 'status-pending' : active ? 'status-completed' : 'status-cancelled';
    const protectedOwner = u.role === 'owner';
    const canTransferOwner = state.currentUser?.organizationRole === 'owner'
      && active && !protectedOwner && Boolean(u.authUserId);
    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${index + 1}</td>
        <td style="font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${u.username}">${u.username}</td>
        <td>${dName}</td>
        <td>
          <span style="color: ${roleColor}; font-weight: 500;">${roleText}</span>
        </td>
        <td><span class="status-badge ${statusClass}">${statusText}</span></td>
        <td style="font-size: 0.8rem; color: var(--text-secondary);">${compName}</td>
        <td style="text-align: center;">
          <div style="display: inline-flex; gap: 0.5rem; justify-content: center;">
            <button class="btn btn-secondary btn-sm btn-circle edit-user-btn" data-id="${u.id}" title="Sửa" ${protectedOwner || membershipStatus === 'invited' ? 'disabled' : ''}>
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-user-btn" data-id="${u.id}" title="Khóa khỏi workspace" ${protectedOwner || !active ? 'disabled' : ''}>
              <i data-lucide="user-x" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-warning btn-sm btn-circle transfer-owner-btn" data-id="${u.id}" title="Chuyển quyền Owner" ${!u.isExternal && canTransferOwner ? '' : 'disabled'}>
              <i data-lucide="crown" style="width: 13px; height: 13px;"></i>
            </button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
  
  document.querySelectorAll('.edit-user-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      openUserModal(id);
    });
  });
  
  document.querySelectorAll('.delete-user-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const id = btn.getAttribute('data-id');
      deleteUser(id);
    });
  });
  document.querySelectorAll('.transfer-owner-btn').forEach(btn => {
    btn.addEventListener('click', () => transferWorkspaceOwner(btn.getAttribute('data-id')));
  });
  
  safeCreateIcons();
}

function syncUserTypeFields(isExternal) {
  document.querySelectorAll('.external-person-field').forEach(field => {
    field.style.display = isExternal ? 'block' : 'none';
  });
  const passwordGroup = document.getElementById('user-password')?.closest('.form-group');
  const roleGroup = document.getElementById('user-role')?.closest('.form-group');
  const statusSelect = document.getElementById('user-membership-status');
  if (passwordGroup) passwordGroup.style.display = isExternal ? 'none' : 'block';
  if (roleGroup) roleGroup.style.display = isExternal ? 'none' : 'block';
  if (statusSelect) {
    const wasInactive = ['inactive', 'suspended'].includes(statusSelect.value);
    statusSelect.innerHTML = isExternal
      ? '<option value="active">Đang hoạt động</option><option value="inactive">Ngừng hoạt động</option>'
      : '<option value="active">Đang hoạt động</option><option value="suspended">Đã khóa</option>';
    statusSelect.value = wasInactive ? (isExternal ? 'inactive' : 'suspended') : 'active';
  }
}

export function openUserModal(userId = '') {
  const modal = document.getElementById('user-modal');
  const title = document.getElementById('user-modal-title');
  const form = document.getElementById('user-form');
  const usernameInput = document.getElementById('user-username');
  const passwordInput = document.getElementById('user-password');
  const passwordHelp = document.getElementById('user-password-help');
  const isExternalSelect = document.getElementById('user-is-external');
  const roleSelect = document.getElementById('user-role');
  const statusSelect = document.getElementById('user-membership-status');
  const statusGroup = document.getElementById('user-membership-status-group');
  
  if (!modal) return;
  modal.classList.add('active');
  form.reset();
  
  const compSelect = document.getElementById('user-company');
  if (compSelect && state.companies && state.companies.length > 0) {
    compSelect.innerHTML = state.companies.map(c => `<option value="${c.id}">${c.name}</option>`).join('');
  }
  
  if (!userId) {
    title.innerText = 'Thêm tài khoản mới';
    document.getElementById('user-edit-id').value = '';
    usernameInput.removeAttribute('disabled');
    passwordInput.removeAttribute('required');
    passwordHelp.style.display = 'block';
    
    if (isExternalSelect) isExternalSelect.value = 'false';
    syncUserTypeFields(false);
    passwordInput.disabled = false;
    if (roleSelect) roleSelect.disabled = false;
    if (statusSelect) statusSelect.value = 'active';
    if (statusGroup) statusGroup.style.display = 'none';
    if (compSelect) compSelect.value = 'ABS_NORTH';
  } else {
    title.innerText = 'Chỉnh sửa tài khoản';
    document.getElementById('user-edit-id').value = userId;
    
    const user = state.users.find(u => u.id === userId);
    if (user) {
      usernameInput.value = user.username;
      usernameInput.setAttribute('disabled', '');
      document.getElementById('user-displayname').value = user.displayName;
      if (roleSelect) roleSelect.value = user.role;
      if (statusSelect) statusSelect.value = user.membershipStatus || (user.isActive === false ? 'suspended' : 'active');
      if (statusGroup) statusGroup.style.display = 'block';
      if (compSelect) compSelect.value = user.companyId || user.company_id || 'ABS_NORTH';
      
      const isExt = user.isExternal || false;
      if (isExternalSelect) isExternalSelect.value = isExt ? 'true' : 'false';
      syncUserTypeFields(isExt);
      if (statusSelect) statusSelect.value = user.membershipStatus || (user.isActive === false ? (isExt ? 'inactive' : 'suspended') : 'active');
      document.getElementById('user-phone').value = user.phone || '';
      document.getElementById('user-job-title').value = user.jobTitle || '';
      document.getElementById('user-employment-type').value = user.employmentType || 'employee';
      if (isExt) usernameInput.removeAttribute('disabled');
      
      passwordInput.value = '';
      passwordInput.removeAttribute('required');
      
      if (isExt) {
        passwordInput.disabled = true;
        if (roleSelect) roleSelect.disabled = true;
        passwordHelp.style.display = 'none';
      } else {
        passwordInput.disabled = true;
        if (roleSelect) roleSelect.disabled = false;
        passwordHelp.style.display = 'block';
      }
    }
  }
}

export function closeUserModal() {
  const modal = document.getElementById('user-modal');
  if (modal) modal.classList.remove('active');
}

function openOwnPasswordModal() {
  if (!state.currentUser) return;
  const modal = document.getElementById('change-password-modal');
  const username = document.getElementById('change-password-username');
  const form = document.getElementById('change-password-form');
  if (!modal || !form) return;
  form.reset();
  if (username) username.innerText = state.currentUser.username;
  modal.classList.add('active');
}

function closeOwnPasswordModal() {
  document.getElementById('change-password-modal')?.classList.remove('active');
}

export function openInvitationPasswordSetup(flowType = 'invite') {
  const modal = document.getElementById('invitation-password-modal');
  const isRecovery = flowType === 'recovery';
  const title = document.getElementById('invitation-password-title');
  const intro = document.getElementById('invitation-password-intro');
  const submit = document.getElementById('btn-complete-invitation');
  if (title) title.textContent = isRecovery ? 'Đặt lại mật khẩu SoVie' : 'Hoàn tất lời mời SoVie';
  if (intro) intro.textContent = isRecovery
    ? 'Nhập mật khẩu mới cho tài khoản của bạn.'
    : 'Thiết lập mật khẩu để dùng cho những lần đăng nhập tiếp theo.';
  if (submit) submit.innerHTML = isRecovery
    ? '<i data-lucide="key-round"></i> Lưu mật khẩu mới'
    : '<i data-lucide="check-circle"></i> Hoàn tất tài khoản';
  if (modal) modal.dataset.authFlowType = flowType;
  document.getElementById('invitation-password-form')?.reset();
  modal?.classList.add('active');
  safeCreateIcons();
  document.getElementById('invitation-new-password')?.focus();
}

export async function requestPasswordReset() {
  const usernameInput = document.getElementById('login-username');
  const email = String(usernameInput?.value || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    showToast('Nhập email đã đăng ký để nhận liên kết đặt lại mật khẩu.', 'warning');
    if (usernameInput) {
      usernameInput.placeholder = 'Email đã đăng ký';
      usernameInput.focus();
    }
    return;
  }
  if (!isCloudActive || !supabaseClient) {
    showToast('Chưa kết nối được dịch vụ xác thực. Vui lòng thử lại sau.', 'danger');
    return;
  }

  const button = document.getElementById('btn-forgot-password');
  if (button) button.disabled = true;
  try {
    const redirectUrl = new URL(window.location.origin);
    redirectUrl.pathname = window.location.pathname || '/';
    redirectUrl.searchParams.set('type', 'recovery');
    const { error } = await supabaseClient.auth.resetPasswordForEmail(email, {
      redirectTo: redirectUrl.toString()
    });
    if (error) throw error;
    showToast('Nếu email tồn tại, SoVie đã gửi liên kết đặt lại mật khẩu. Hãy kiểm tra cả thư rác.', 'success');
  } catch (error) {
    const code = classifySupabaseError(error);
    showToast(code === LOGIN_ERROR.NETWORK
      ? loginErrorMessage(LOGIN_ERROR.NETWORK)
      : 'Chưa thể gửi email đặt lại mật khẩu. Vui lòng thử lại sau.', 'danger');
  } finally {
    if (button) button.disabled = false;
  }
}

async function completeInvitationPassword(event) {
  event.preventDefault();
  const password = document.getElementById('invitation-new-password')?.value || '';
  const confirmation = document.getElementById('invitation-confirm-password')?.value || '';
  if (password.length < 8) {
    showToast('Mật khẩu cần ít nhất 8 ký tự.', 'warning');
    return;
  }
  if (password !== confirmation) {
    showToast('Hai lần nhập mật khẩu không khớp.', 'warning');
    return;
  }
  const button = document.getElementById('btn-complete-invitation');
  if (button) button.disabled = true;
  try {
    const { error } = await supabaseClient.auth.updateUser({ password });
    if (error) throw error;
    const modal = document.getElementById('invitation-password-modal');
    const isRecovery = modal?.dataset.authFlowType === 'recovery';
    modal?.classList.remove('active');
    const cleanUrl = new URL(window.location.href);
    cleanUrl.hash = '';
    cleanUrl.searchParams.delete('type');
    history.replaceState(null, '', `${cleanUrl.pathname}${cleanUrl.search}`);
    showToast(isRecovery
      ? 'Đã đặt lại mật khẩu. Bạn có thể dùng mật khẩu mới từ bây giờ.'
      : 'Đã thiết lập mật khẩu. Tài khoản của bạn đã sẵn sàng.', 'success');
  } catch (error) {
    showToast(error?.message || 'Không thể thiết lập mật khẩu.', 'danger');
  } finally {
    if (button) button.disabled = false;
  }
}

async function changeOwnPassword(event) {
  event.preventDefault();
  const currentPassword = document.getElementById('current-password')?.value || '';
  const newPassword = document.getElementById('new-password')?.value || '';
  const confirmPassword = document.getElementById('confirm-password')?.value || '';
  const currentUser = state.currentUser;

  if (!currentUser) return;
  if (newPassword.length < 6) {
    showToast('Mật khẩu mới phải có ít nhất 6 ký tự.', 'warning');
    return;
  }
  if (newPassword !== confirmPassword) {
    showToast('Mật khẩu mới và phần nhập lại không khớp.', 'warning');
    return;
  }

  const submit = document.getElementById('btn-save-change-password');
  if (submit) submit.disabled = true;
  try {
    if (!isCloudActive || !supabaseClient) throw new Error('Cần kết nối Supabase Auth để đổi mật khẩu.');
    const { data: { user: authUser } } = await supabaseClient.auth.getUser();
    if (!authUser?.email) throw new Error('Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại.');
    const { error: verifyError } = await supabaseClient.auth.signInWithPassword({
      email: authUser.email,
      password: currentPassword
    });
    if (verifyError) throw new Error('Mật khẩu hiện tại không đúng.');
    const { error } = await supabaseClient.auth.updateUser({ password: newPassword });
    if (error) throw error;
    closeOwnPasswordModal();
    showToast('Đổi mật khẩu thành công.', 'success');
  } catch (error) {
    showToast(error.message || 'Không thể đổi mật khẩu.', 'danger');
  } finally {
    if (submit) submit.disabled = false;
  }
}

export async function saveUser() {
  const editId = document.getElementById('user-edit-id').value;
  const isExternalSelect = document.getElementById('user-is-external');
  const isExternal = isExternalSelect ? isExternalSelect.value === 'true' : false;
  
  let username = document.getElementById('user-username').value.trim().toLowerCase();
  if (!isExternal && username && !username.includes('@')) {
    username = `${username}@lendon.com`;
  }
  const displayName = document.getElementById('user-displayname').value.trim();
  const role = document.getElementById('user-role').value;
  const membershipStatus = document.getElementById('user-membership-status')?.value || 'active';
  const initialPassword = document.getElementById('user-password')?.value || '';
  
  if (!username || !displayName) {
    showToast('Tên đăng nhập và Tên hiển thị là bắt buộc!', 'danger');
    return;
  }
  
  let user;
  if (!editId) {
    const exists = state.users.some(u => isSameUser(u.username, username));
    if (exists) {
      showToast('Tên đăng nhập đã tồn tại trong hệ thống!', 'danger');
      return;
    }
    if (!isExternal && initialPassword.length > 0 && initialPassword.length < 8) {
      showToast('Mật khẩu khởi tạo phải có ít nhất 8 ký tự, hoặc để trống để gửi email mời.', 'warning');
      return;
    }
    
    const companyId = document.getElementById('user-company') ? document.getElementById('user-company').value : 'ABS_NORTH';
    user = {
      id: 'u-' + Date.now(),
      username,
      displayName,
      role: isExternal ? 'sale' : role,
      isExternal,
      isActive: true,
      membershipStatus: 'active',
      companyId,
      phone: isExternal ? document.getElementById('user-phone')?.value.trim() || '' : '',
      jobTitle: isExternal ? document.getElementById('user-job-title')?.value.trim() || '' : '',
      employmentType: isExternal ? document.getElementById('user-employment-type')?.value || 'employee' : ''
    };
  } else {
    const existingUser = state.users.find(u => u.id === editId);
    if (!existingUser) return;
    
    const exists = state.users.some(u => u.id !== editId && isSameUser(u.username, username));
    if (exists) {
      showToast('Tên đăng nhập đã tồn tại trong hệ thống!', 'danger');
      return;
    }
    
    const companyId = document.getElementById('user-company') ? document.getElementById('user-company').value : 'ABS_NORTH';
    user = {
      ...existingUser,
      username,
      displayName,
      role: isExternal ? 'sale' : role,
      isExternal,
      isActive: membershipStatus === 'active',
      membershipStatus,
      companyId,
      phone: isExternal ? document.getElementById('user-phone')?.value.trim() || '' : '',
      jobTitle: isExternal ? document.getElementById('user-job-title')?.value.trim() || '' : '',
      employmentType: isExternal ? document.getElementById('user-employment-type')?.value || 'employee' : ''
    };
  }
  
  const saved = await dbSaveUser(user, { initialPassword });
  if (saved) {
    // Profile/role chỉ lấy từ database; không lưu bản sao quyền trong browser.
    const idx = state.users.findIndex(u => u.id === user.id);
    if (idx !== -1) {
      state.users[idx] = user;
    } else {
      state.users.push(user);
    }

    // Cập nhật lại UI Header nếu chỉnh sửa đúng tài khoản đang đăng nhập
    if (state.currentUser && state.currentUser.id === user.id) {
      state.currentUser = user;
      document.getElementById('header-user-display').innerText = `${user.displayName} (${user.role === 'admin' ? 'Admin' : user.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
      applyUserPermissions(user);
    }
    
    closeUserModal();
    renderAll();
    showToast(
      user.isExternal ? 'Đã lưu nhân sự vào danh bạ workspace, không tạo tài khoản đăng nhập.'
        : user.invitationSent ? 'Đã gửi email mời tham gia workspace.'
        : user.existingAccount ? 'Đã thêm tài khoản Supabase hiện có vào workspace.'
          : 'Lưu thông tin thành viên thành công!',
      'success'
    );
  }
}

async function transferWorkspaceOwner(userId) {
  const user = state.users.find(item => item.id === userId);
  if (!user?.authUserId || state.currentUser?.organizationRole !== 'owner') return;
  const confirmed = confirm(
    `Chuyển toàn bộ quyền Owner workspace cho "${user.displayName}"? `
    + 'Sau thao tác này, tài khoản của bạn sẽ trở thành Admin.'
  );
  if (!confirmed) return;
  try {
    await transferSaasOrganizationOwnership(user.authUserId);
    showToast('Đã chuyển quyền Owner. Đang tải lại quyền workspace...', 'success');
    window.location.reload();
  } catch (error) {
    showToast(error?.message || 'Không thể chuyển quyền Owner.', 'danger');
  }
}

export async function deleteUser(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  if (state.currentUser && state.currentUser.id === userId) {
    showToast('Không thể tự khóa membership đang đăng nhập!', 'danger');
    return;
  }
  
  if (user.role === 'owner') {
    showToast('Owner không thể bị khóa từ màn hình quản trị thành viên.', 'danger');
    return;
  }
  
  const question = user.isExternal
    ? `Chuyển nhân sự "${user.displayName}" sang trạng thái ngừng hoạt động?`
    : `Khóa thành viên "${user.displayName}" khỏi workspace hiện tại? Tài khoản ở doanh nghiệp khác không bị ảnh hưởng.`;
  if (confirm(question)) {
    const deleted = await dbDeleteUser(userId);
    if (deleted) {
      if (user.isExternal) {
        user.isActive = false;
        user.membershipStatus = 'inactive';
      } else {
        state.users = state.users.filter(u => u.id !== userId);
      }
      renderAll();
      showToast(user.isExternal ? 'Đã ngừng hoạt động nhân sự.' : 'Đã khóa thành viên khỏi workspace hiện tại.', 'warning');
    }
  }
}

export function populateCustomerEmployeeFilter() {
  const select = document.getElementById('customer-managed-filter');
  const wrapper = document.getElementById('cust-managed-filter-wrapper');
  if (!select) return;
  
  if (state.currentUser && state.currentUser.role === 'sale') {
    if (wrapper) wrapper.style.display = 'none';
    return;
  } else {
    if (wrapper) wrapper.style.display = 'block';
  }
  
  const currentVal = select.value;
  
  select.innerHTML = `
    <option value="">-- Tất cả nhân viên --</option>
    <option value="unassigned">-- Chưa có người quản lý --</option>
    <option value="unassigned_pricelist">-- Chưa áp bảng giá chuẩn --</option>
    ${state.users.map(u => `
      <option value="${u.username}">${u.displayName} (${u.isExternal ? 'Kinh doanh ngoài' : (u.role === 'admin' ? 'Admin' : u.role === 'accounting' ? 'Kế toán' : 'Sale')})</option>
    `).join('')}
  `;
  
  select.value = currentVal;
}

let isLoggingIn = false;
let maintenanceMonitor = null;

function setMaintenanceNotice(message = '', visible = false) {
  const notice = document.getElementById('login-maintenance-notice');
  if (!notice) return;
  notice.textContent = message || loginErrorMessage(LOGIN_ERROR.MAINTENANCE);
  notice.style.display = visible ? 'block' : 'none';
}

export function stopMaintenanceMonitor() {
  if (maintenanceMonitor) clearInterval(maintenanceMonitor);
  maintenanceMonitor = null;
}

async function enforceMaintenanceForActiveEmployee() {
  if (!state.currentUser || state.currentUser.role === 'admin') return;
  try {
    const status = await getMaintenanceStatus();
    if (!status.enabled) return;
    stopMaintenanceMonitor();
    await stopRealtimeSync();
    try { await supabaseClient?.auth.signOut(); } catch (_) { /* clear local session below */ }
    clearAuthenticatedSessionState();
    clearSupabaseAuthStorage();
    showLoginGate();
    setMaintenanceNotice(status.message, true);
    showToast(status.message, 'warning');
  } catch (error) {
    console.warn('Maintenance status check failed; keeping the current session until the next check.', error);
  }
}

export function startMaintenanceMonitor() {
  stopMaintenanceMonitor();
  if (!state.currentUser || state.currentUser.role === 'admin') return;
  maintenanceMonitor = setInterval(() => void enforceMaintenanceForActiveEmployee(), 15000);
}

function createLoginFlowError(code) {
  const error = new Error(loginErrorMessage(code));
  error.loginCode = code;
  return error;
}

export function clearAuthenticatedSessionState() {
  clearPlatformAdminState();
  clearTenantStorageContext();
  resetTenantBusinessState();
  state.currentUser = null;
  state.saasContext = null;
  state.businessCapabilities = null;
  state.activeOrganizationId = '';
  state.pricingSnapshotActorId = '';
  state.pricingSnapshotRole = '';
  state.pricingSnapshotSource = '';
  state.pricingSnapshotCachedAt = '';
  state.selectedPriceListIds = [];
}

export async function loadAuthenticatedProfile(authUserId) {
  const { data: profileRows, error: profileError } = await supabaseClient
    .from('profiles')
    .select('id,auth_user_id,username,display_name,role,company_id,is_external,is_active')
    .eq('auth_user_id', authUserId)
    .limit(2);

  if (profileError) {
    throw createLoginFlowError(classifySupabaseError(profileError));
  }

  if (!profileRows || profileRows.length === 0) {
    // A SELECT blocked by RLS also returns zero rows. This narrow SECURITY
    // DEFINER probe reveals only whether the caller's own link exists, so the
    // UI can distinguish a missing link from a broken self-read policy.
    const { data: linkStatus, error: linkError } = await supabaseClient
      .rpc('rpc_my_profile_link_status');
    if (linkError) {
      throw createLoginFlowError(classifySupabaseError(linkError));
    }
    if (linkStatus?.profile_exists === true) {
      throw createLoginFlowError(LOGIN_ERROR.PROFILE_ACCESS_DENIED);
    }
  }

  const validation = validateProfileRows(profileRows || []);
  if (!validation.ok) throw createLoginFlowError(validation.code);
  return validation.profile;
}

export function createPlatformOnlyUser(profile) {
  return {
    id: profile.id,
    authUserId: profile.auth_user_id,
    username: profile.username,
    displayName: profile.display_name,
    role: 'platform',
    organizationRole: '',
    organizationId: '',
    organizationName: '',
    organizationSlug: '',
    companyId: profile.company_id || '',
    isExternal: false,
    isActive: profile.is_active !== false
  };
}

export async function handleLogin(e) {
  e.preventDefault();
  if (isLoggingIn) return;
  isLoggingIn = true;

  const usernameInput = document.getElementById('login-username').value.trim().toLowerCase();
  const passwordInput = document.getElementById('login-password').value.trim();

  const submitBtn = document.getElementById('btn-login-submit') || e.target.querySelector('button[type="submit"]');
  const originalBtnHTML = submitBtn ? submitBtn.innerHTML : '';
  const usernameField = document.getElementById('login-username');
  const passwordField = document.getElementById('login-password');

  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.innerHTML = `<span style="display: inline-block; width: 14px; height: 14px; border: 2px solid #fff; border-top: 2px solid transparent; border-radius: 50%; animation: spin 1s linear infinite; margin-right: 6px; vertical-align: middle;"></span> ĐANG ĐĂNG NHẬP...`;
  }
  if (usernameField) usernameField.disabled = true;
  if (passwordField) passwordField.disabled = true;

  const resetFormState = () => {
    isLoggingIn = false;
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerHTML = originalBtnHTML;
    }
    if (usernameField) usernameField.disabled = false;
    if (passwordField) passwordField.disabled = false;
  };

  let authEstablished = false;
  try {
    if (!isCloudActive || !supabaseClient) {
      throw new Error('Cần kết nối Supabase để đăng nhập an toàn. Chế độ đăng nhập ngoại tuyến đã bị tắt.');
    }

    const rememberedEmailKey = `billing_system_login_email:${usernameInput}`;
    const rememberedEmail = usernameInput.includes('@') ? '' : (localStorage.getItem(rememberedEmailKey) || '');
    const candidates = usernameInput.includes('@')
      ? [usernameInput]
      : [...new Set([rememberedEmail, `${usernameInput}@lendon.com`, `${usernameInput}@gmail.com`].filter(Boolean))];
    let authUser = null;
    let loginError = null;
    for (const email of candidates) {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email, password: passwordInput });
      if (!error && data?.session?.user) {
        authUser = data.session.user;
        authEstablished = true;
        if (!usernameInput.includes('@')) localStorage.setItem(rememberedEmailKey, email);
        break;
      }
      if (classifySupabaseError(error) === LOGIN_ERROR.NETWORK) {
        throw createLoginFlowError(LOGIN_ERROR.NETWORK);
      }
      loginError = error;
    }
    if (!authUser) {
      const authErrorCode = classifySupabaseError(loginError) === LOGIN_ERROR.NETWORK
        ? LOGIN_ERROR.NETWORK
        : LOGIN_ERROR.AUTH_FAILED;
      throw createLoginFlowError(authErrorCode);
    }

    const profile = await loadAuthenticatedProfile(authUser.id);
    const tenantContext = await loadSaasContext({ allowMissingOrganization: true });
    if (!tenantContext) {
      const platformRole = await hydratePlatformAdmin();
      if (platformRole) {
        state.currentUser = createPlatformOnlyUser(profile);
        state.saasContext = null;
        state.businessCapabilities = null;
        state.activeOrganizationId = '';

        document.getElementById('login-screen').style.display = 'none';
        const landingPage = document.getElementById('landing-page');
        if (landingPage) landingPage.style.display = 'none';
        document.getElementById('app-layout').classList.remove('auth-hidden');
        const userInfoHeader = document.getElementById('user-info-header');
        if (userInfoHeader) userInfoHeader.style.display = 'flex';
        const logoutBtn = document.getElementById('btn-logout');
        if (logoutBtn) logoutBtn.style.display = 'inline-flex';
        const userDisplay = document.getElementById('header-user-display');
        if (userDisplay) userDisplay.innerText = `${state.currentUser.displayName} (Quản trị nền tảng)`;
        applyUserPermissions(state.currentUser);
        setMaintenanceNotice('', false);
        switchTab('platform-admin-panel');
        showToast(`Đăng nhập thành công! Chào mừng ${state.currentUser.displayName}!`, 'success');
        return;
      }
      state.currentUser = {
        id: profile.id,
        authUserId: profile.auth_user_id,
        username: profile.username,
        displayName: profile.display_name,
        role: 'admin',
        organizationRole: 'owner',
        organizationId: '',
        organizationName: '',
        organizationSlug: '',
        companyId: profile.company_id || 'ABS_NORTH',
        isExternal: profile.is_external === true,
        isActive: profile.is_active !== false
      };
      openWorkspaceOnboarding({ required: true });
      showToast('Tài khoản chưa có doanh nghiệp. Hãy tạo workspace đầu tiên.', 'warning');
      return;
    }

    const user = {
      id: profile.id,
      authUserId: profile.auth_user_id,
      username: profile.username,
      displayName: profile.display_name,
      role: tenantContext.applicationRole,
      organizationRole: tenantContext.organizationRole,
      organizationId: tenantContext.organizationId,
      organizationName: tenantContext.organizationName,
      organizationSlug: tenantContext.organizationSlug,
      companyId: profile.company_id || 'ABS_NORTH',
      isExternal: profile.is_external === true,
      isActive: profile.is_active !== false
    };
    state.saasContext = tenantContext;
    state.businessCapabilities = tenantContext.capabilities;
    state.activeOrganizationId = tenantContext.organizationId;
    const maintenance = await getMaintenanceStatus();
    if (maintenance.enabled && user.role !== 'admin') {
      const error = createLoginFlowError(LOGIN_ERROR.MAINTENANCE);
      error.message = maintenance.message || error.message;
      throw error;
    }
    state.currentUser = user;
    const cloudLoad = await fetchCloudData({
      deferSecondary: true,
      hydrateCustomerHistory: false,
      leanBootstrap: true
    });
    const loadedUser = state.users.find(item => item.authUserId === authUser.id || item.id === profile.id);
    state.currentUser = loadedUser ? {
      ...user,
      ...loadedUser,
      role: user.role,
      organizationRole: user.organizationRole,
      organizationId: user.organizationId,
      organizationName: user.organizationName,
      organizationSlug: user.organizationSlug
    } : user;
    await hydratePlatformAdmin();

    document.getElementById('login-screen').style.display = 'none';
    const landingPage = document.getElementById('landing-page');
    if (landingPage) landingPage.style.display = 'none';
    document.getElementById('app-layout').classList.remove('auth-hidden');
    const userInfoHeader = document.getElementById('user-info-header');
    if (userInfoHeader) userInfoHeader.style.display = 'flex';
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.style.display = 'inline-flex';
    const userDisplay = document.getElementById('header-user-display');
    if (userDisplay) {
      const roleLabel = state.platformRole ? 'Quản trị nền tảng' : state.currentUser.role === 'admin' ? 'Admin' : state.currentUser.role === 'accounting' ? 'Kế toán' : 'Sale';
      userDisplay.innerText = `${state.currentUser.displayName} (${roleLabel})`;
    }
    applyUserPermissions(state.currentUser);
    renderWorkspaceSwitcher();
    renderSubscriptionAccessNotice();
    setMaintenanceNotice('', false);
    switchTab(state.platformRole ? 'platform-admin-panel' : state.currentUser.role === 'sale' ? 'invoice-panel' : 'dashboard-panel');
    void startRealtimeSync(renderAll);
    startMaintenanceMonitor();
    showToast(`Đăng nhập thành công! Chào mừng ${state.currentUser.displayName}!`, 'success');

    const loginUserId = String(state.currentUser.authUserId || state.currentUser.id || '');
    if (cloudLoad?.background) {
      void cloudLoad.background.then(loaded => {
        const activeUserId = String(state.currentUser?.authUserId || state.currentUser?.id || '');
        if (loaded && activeUserId === loginUserId) renderAll();
      });
    }
  } catch (err) {
    await stopRealtimeSync();
    if (authEstablished && isCloudActive && supabaseClient) {
      try {
        await supabaseClient.auth.signOut();
      } catch (_) {
        // Local session storage is cleared below even if the network sign-out fails.
      }
    }
    clearAuthenticatedSessionState();
    if (authEstablished) clearSupabaseAuthStorage();
    const errorCode = err?.loginCode || classifySupabaseError(err);
    console.warn('Login flow rejected', { code: errorCode });
    const userMessage = errorCode === LOGIN_ERROR.MAINTENANCE ? err.message : loginErrorMessage(errorCode);
    setMaintenanceNotice(userMessage, errorCode === LOGIN_ERROR.MAINTENANCE);
    showToast(userMessage, errorCode === LOGIN_ERROR.MAINTENANCE ? 'warning' : 'danger');
  } finally {
    resetFormState();
  }
}

export async function handleLogout() {
  stopMaintenanceMonitor();
  // Remove obsolete pre-P0 markers; they are never read for authorization.
  await stopRealtimeSync();
  sessionStorage.removeItem('billing_system_auth');
  sessionStorage.removeItem('billing_system_username');
  clearAuthenticatedSessionState();
  if (isCloudActive && supabaseClient) {
    try {
      await supabaseClient.auth.signOut();
    } catch (err) {
      console.error('Sign out error:', err);
    }
  }
  clearSupabaseAuthStorage();
  location.reload();
}

export function showLoginGate() {
  const loginScreen = document.getElementById('login-screen');
  const appLayout = document.getElementById('app-layout');
  const userInfoHeader = document.getElementById('user-info-header');
  const logoutBtn = document.getElementById('btn-logout');
  const landingPage = document.getElementById('landing-page');

  if (landingPage) landingPage.style.display = 'block';
  if (loginScreen) loginScreen.style.display = 'none';
  if (appLayout) {
    appLayout.classList.add('auth-hidden');
    delete appLayout.dataset.uiRole;
  }
  if (userInfoHeader) userInfoHeader.style.display = 'none';
  if (logoutBtn) logoutBtn.style.display = 'none';
}

export function applyUserPermissions(user) {
  if (!user) return;
  const role = user.role;
  const platformOnly = Boolean(state.platformRole && !user.organizationId);
  const appLayout = document.getElementById('app-layout');
  const visualRole = platformOnly ? 'platform' : ['admin', 'accounting', 'sale'].includes(role) ? role : 'admin';
  if (appLayout) appLayout.dataset.uiRole = visualRole;
  const roleChip = document.getElementById('header-role-chip');
  if (roleChip) {
    const labels = { platform: 'Nền tảng', admin: 'Quản lý', accounting: 'Kế toán', sale: 'Bán hàng' };
    roleChip.querySelector('span').textContent = labels[visualRole];
    roleChip.setAttribute('aria-label', `Không gian ${labels[visualRole]}`);
  }
  const activityButton = document.getElementById('btn-activity-log');
  if (activityButton) activityButton.closest('.activity-header-wrap').style.display = !platformOnly && ['admin', 'accounting'].includes(role) ? 'block' : 'none';

  const invoiceDateGroup = document.getElementById('invoice-business-date-group');
  const invoiceDateInput = document.getElementById('invoice-business-date');
  const canAdjustInvoiceDate = role === 'admin' || role === 'accounting';
  if (invoiceDateGroup) invoiceDateGroup.style.display = canAdjustInvoiceDate ? 'block' : 'none';
  if (invoiceDateInput) invoiceDateInput.disabled = !canAdjustInvoiceDate;

  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    const target = link.getAttribute('data-target');
    const navItem = link.parentElement;
    if (!target) return;
    if (platformOnly) {
      navItem.style.display = target === 'platform-admin-panel' ? 'block' : 'none';
      return;
    }
    if (target === 'platform-admin-panel') {
      navItem.style.display = state.platformRole ? 'block' : 'none';
      return;
    }
    
    if (role === 'sale') {
      if (target === 'invoice-panel' || target === 'customers-panel' || target === 'history-panel' || target === 'brands-panel') {
        navItem.style.display = 'block';
      } else {
        navItem.style.display = 'none';
      }
    } else if (role === 'accounting') {
      if (target === 'settings-panel' || target === 'users-panel') {
        navItem.style.display = 'none';
      } else {
        navItem.style.display = 'block';
      }
    } else {
      navItem.style.display = 'block';
    }
  });

  const purchaseNavItem = document.querySelector('.purchase-nav-item');
  if (purchaseNavItem) {
    purchaseNavItem.style.display = platformOnly || role === 'sale' ? 'none' : 'block';
  }
  const staffNavItem = document.querySelector('.staff-nav-item');
  if (staffNavItem) {
    staffNavItem.style.display = platformOnly || role === 'sale' ? 'none' : 'block';
  }

  const workspaceSwitcher = document.querySelector('.workspace-switcher');
  if (workspaceSwitcher) workspaceSwitcher.style.display = platformOnly ? 'none' : '';

  // Hiding dropdown items based on role
  const dropdownNavLinks = document.querySelectorAll('.dropdown-nav-link');
  dropdownNavLinks.forEach(link => {
    const target = link.getAttribute('data-target');
    if (platformOnly) {
      link.style.display = 'none';
      return;
    }
    if (role === 'sale' || role === 'accounting') {
      if (target === 'users-panel' || target === 'settings-panel') {
        link.style.display = 'none';
      } else {
        link.style.display = 'flex';
      }
    } else {
      link.style.display = 'flex';
    }
  });

  if (role === 'sale') {
    switchTab('invoice-panel');
  }

  // Handle Dashboard Sale Filter dropdown visibility and population
  const dashSaleFilterGroup = document.getElementById('dashboard-sale-filter-group');
  const dashSaleFilter = document.getElementById('dashboard-sale-filter');
  
  if (dashSaleFilterGroup && dashSaleFilter) {
    if (role === 'admin' || role === 'accounting') {
      dashSaleFilterGroup.style.display = 'flex';
      
      const saleUsers = state.users.filter(u => u.role === 'sale');
      dashSaleFilter.innerHTML = `
        <option value="all">-- Tất cả nhân viên --</option>
        ${saleUsers.map(u => `<option value="${u.username}">${u.displayName}</option>`).join('')}
      `;
      if (!state.dashboardFilter.saleUser) {
        state.dashboardFilter.saleUser = 'all';
      }
      dashSaleFilter.value = state.dashboardFilter.saleUser;
    } else {
      dashSaleFilterGroup.style.display = 'none';
      state.dashboardFilter.saleUser = user.username;
    }
  }

  populateManagedByDropdown();

  const managedBySection = document.getElementById('cust-managed-by-section');
  if (managedBySection) {
    managedBySection.style.display = role === 'sale' ? 'none' : 'block';
  }

  const custDebtInput = document.getElementById('cust-debt');
  if (custDebtInput) {
    if (role === 'sale') custDebtInput.setAttribute('disabled', 'true');
    else custDebtInput.removeAttribute('disabled');
  }

  const styleTagId = 'role-based-css-rules';
  let styleTag = document.getElementById(styleTagId);
  if (!styleTag) {
    styleTag = document.createElement('style');
    styleTag.id = styleTagId;
    document.head.appendChild(styleTag);
  }

  if (role === 'sale') {
    styleTag.innerHTML = `
      #btn-save-order { display: none !important; }
      #btn-print-type-processing, #btn-print-type-warehouse { display: none !important; }
      .delete-cust-btn, .pay-debt-btn { display: none !important; }
      .edit-cust-btn { display: inline-flex !important; }
      #btn-open-add-product-modal, #btn-open-excel-modal, #btn-download-excel-template, .edit-product-btn, .delete-prod-btn { display: none !important; }
      #products-panel th:last-child, #products-panel td:last-child { display: none !important; }
      .col-delete-prod { display: none !important; }
      .delete-order-btn { display: none !important; }
      #btn-clear-history { display: none !important; }
      #btn-open-add-pricelist-modal, #btn-import-pricelist-excel, #btn-save-price-matrix { display: none !important; }
      #btn-open-add-brand-modal, .edit-brand-btn, .delete-brand-btn { display: none !important; }
      #brands-panel th:last-child, #brands-panel td:last-child { display: none !important; }
      #dash-btn-add-product { display: none !important; }
    `;
  } else if (role === 'accounting') {
    styleTag.innerHTML = `
      .delete-cust-btn { display: inline-flex !important; }
      .edit-cust-btn { display: inline-flex !important; }
      .pay-debt-btn { display: inline-flex !important; }
      #btn-open-add-product-modal, .edit-product-btn, .delete-product-btn { display: none !important; }
      .delete-order-btn { display: none !important; }
    `;
  } else {
    styleTag.innerHTML = '';
  }
}

export function setupUserManagement() {
  const addBtn = document.getElementById('btn-open-add-user-modal');
  const closeBtn = document.getElementById('btn-close-user-modal');
  const cancelBtn = document.getElementById('btn-cancel-user');
  const userForm = document.getElementById('user-form');
  const searchInput = document.getElementById('user-search-input');
  const isExternalSelect = document.getElementById('user-is-external');
  const passwordInput = document.getElementById('user-password');
  const roleSelect = document.getElementById('user-role');
  const changePasswordBtn = document.getElementById('btn-change-own-password');

  if (addBtn) addBtn.addEventListener('click', () => openUserModal());
  if (closeBtn) closeBtn.addEventListener('click', closeUserModal);
  if (cancelBtn) cancelBtn.addEventListener('click', closeUserModal);
  if (changePasswordBtn) changePasswordBtn.addEventListener('click', openOwnPasswordModal);
  document.getElementById('btn-close-change-password')?.addEventListener('click', closeOwnPasswordModal);
  document.getElementById('btn-cancel-change-password')?.addEventListener('click', closeOwnPasswordModal);
  document.getElementById('change-password-form')?.addEventListener('submit', changeOwnPassword);
  document.getElementById('invitation-password-form')?.addEventListener('submit', completeInvitationPassword);
  document.getElementById('btn-forgot-password')?.addEventListener('click', requestPasswordReset);
  
  if (isExternalSelect) {
    isExternalSelect.addEventListener('change', () => {
      const isExt = isExternalSelect.value === 'true';
      syncUserTypeFields(isExt);
      if (isExt) {
        if (passwordInput) {
          passwordInput.removeAttribute('required');
          passwordInput.value = '';
          passwordInput.disabled = true;
        }
        if (roleSelect) {
          roleSelect.value = 'sale';
          roleSelect.disabled = true;
        }
      } else {
        if (passwordInput) {
          const isNew = !document.getElementById('user-edit-id')?.value;
          passwordInput.removeAttribute('required');
          passwordInput.value = '';
          passwordInput.disabled = !isNew;
        }
        if (roleSelect) roleSelect.disabled = false;
      }
    });
  }

  if (userForm) {
    userForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      await saveUser();
    });
  }
  
  if (searchInput) {
    searchInput.addEventListener('input', renderUsersTable);
  }
}
