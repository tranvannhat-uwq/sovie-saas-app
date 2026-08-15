import { state } from '../state.js';
import { showToast, safeCreateIcons, isSameUser, getCompanyNameById } from '../utils.js';
import { dbSaveUser, dbDeleteUser, isCloudActive, supabaseClient, fetchCloudData, clearSupabaseAuthStorage, getMaintenanceStatus } from '../services/supabase.js?v=20260814-invoice-discount-label-v19';
import { startRealtimeSync, stopRealtimeSync } from '../services/realtime.js?v=20260814-invoice-discount-label-v19';
import { renderAll, switchTab } from '../main.js?v=20260814-invoice-discount-label-v19';
import { populateManagedByDropdown } from './customers.js?v=20260814-invoice-discount-label-v19';
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
        <td colspan="5" style="text-align: center; color: var(--text-muted); padding: 2rem;">
          Không tìm thấy tài khoản người dùng nào
        </td>
      </tr>
    `;
    return;
  }
  
  tableBody.innerHTML = filtered.map((u, index) => {
    const roleText = u.isExternal ? 'Kinh doanh ngoài' : 
                     (u.role === 'admin' ? 'Admin (Toàn quyền)' : 
                      u.role === 'accounting' ? 'Kế toán' : 'Sale (Kinh doanh)');
    const roleColor = u.isExternal ? '#a0aec0' : 
                      (u.role === 'admin' ? 'var(--color-danger)' : 
                       u.role === 'accounting' ? 'var(--color-secondary)' : 'var(--color-primary)');
                      
    const compName = getCompanyNameById(u.companyId || u.company_id, state.companies);
    const dName = u.displayName || u.display_name || u.name || u.username;
    return `
      <tr>
        <td style="text-align: center; color: var(--text-muted);">${index + 1}</td>
        <td style="font-weight: 600; color: #fff; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;" title="${u.username}">${u.username}</td>
        <td>${dName}</td>
        <td>
          <span style="color: ${roleColor}; font-weight: 500;">${roleText}</span>
        </td>
        <td style="font-size: 0.8rem; color: var(--text-secondary);">${compName}</td>
        <td style="text-align: center;">
          <div style="display: inline-flex; gap: 0.5rem; justify-content: center;">
            <button class="btn btn-secondary btn-sm btn-circle edit-user-btn" data-id="${u.id}" title="Sửa">
              <i data-lucide="edit-2" style="width: 13px; height: 13px;"></i>
            </button>
            <button class="btn btn-danger btn-sm btn-circle delete-user-btn" data-id="${u.id}" title="Xóa">
              <i data-lucide="trash-2" style="width: 13px; height: 13px;"></i>
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
  
  safeCreateIcons();
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
    passwordInput.setAttribute('required', '');
    passwordHelp.style.display = 'block';
    
    if (isExternalSelect) isExternalSelect.value = 'false';
    passwordInput.disabled = false;
    if (roleSelect) roleSelect.disabled = false;
    if (compSelect) compSelect.value = 'ABS_NORTH';
  } else {
    title.innerText = 'Chỉnh sửa tài khoản';
    document.getElementById('user-edit-id').value = userId;
    
    const user = state.users.find(u => u.id === userId);
    if (user) {
      usernameInput.value = user.username;
      usernameInput.removeAttribute('disabled');
      document.getElementById('user-displayname').value = user.displayName;
      if (roleSelect) roleSelect.value = user.role;
      if (compSelect) compSelect.value = user.companyId || user.company_id || 'ABS_NORTH';
      
      const isExt = user.isExternal || false;
      if (isExternalSelect) isExternalSelect.value = isExt ? 'true' : 'false';
      
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
  if (username && !username.includes('@')) {
    username = `${username}@lendon.com`;
  }
  const displayName = document.getElementById('user-displayname').value.trim();
  const role = document.getElementById('user-role').value;
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
    if (!isExternal && initialPassword.length < 8) {
      showToast('Mật khẩu khởi tạo phải có ít nhất 8 ký tự.', 'warning');
      return;
    }
    
    const companyId = document.getElementById('user-company') ? document.getElementById('user-company').value : 'ABS_NORTH';
    user = {
      id: 'u-' + Date.now(),
      username,
      displayName,
      role: isExternal ? 'sale' : role,
      isExternal,
      companyId
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
      companyId
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
    showToast('Lưu thông tin tài khoản thành công!', 'success');
  }
}

export async function deleteUser(userId) {
  const user = state.users.find(u => u.id === userId);
  if (!user) return;
  
  if (state.currentUser && state.currentUser.id === userId) {
    showToast('Không thể tự xóa tài khoản của chính bạn đang đăng nhập!', 'danger');
    return;
  }
  
  if (user.username === 'admin' || user.username === 'nhat') {
    if (state.users.filter(u => u.role === 'admin').length <= 1) {
      showToast('Phải giữ lại ít nhất một tài khoản Admin hệ thống!', 'danger');
      return;
    }
  }
  
  if (confirm(`Bạn có chắc chắn muốn xóa tài khoản "${user.displayName}" (${user.username})?`)) {
    const deleted = await dbDeleteUser(userId);
    if (deleted) {
      state.users = state.users.filter(u => u.id !== userId);
      renderAll();
      showToast('Xóa tài khoản thành công!', 'warning');
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
  state.currentUser = null;
  state.users = [];
  state.pricelists = [];
  state.allPricelists = [];
  state.priceListItems = [];
  state.allPriceListItems = [];
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

    const user = {
      id: profile.id,
      authUserId: profile.auth_user_id,
      username: profile.username,
      displayName: profile.display_name,
      role: profile.role,
      companyId: profile.company_id || 'ABS_NORTH',
      isExternal: profile.is_external === true,
      isActive: profile.is_active !== false
    };
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
    state.currentUser = state.users.find(item => item.authUserId === authUser.id || item.id === profile.id) || user;

    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-layout').classList.remove('auth-hidden');
    const userInfoHeader = document.getElementById('user-info-header');
    if (userInfoHeader) userInfoHeader.style.display = 'flex';
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.style.display = 'inline-flex';
    const userDisplay = document.getElementById('header-user-display');
    if (userDisplay) {
      const roleLabel = state.currentUser.role === 'admin' ? 'Admin' : state.currentUser.role === 'accounting' ? 'Kế toán' : 'Sale';
      userDisplay.innerText = `${state.currentUser.displayName} (${roleLabel})`;
    }
    applyUserPermissions(state.currentUser);
    setMaintenanceNotice('', false);
    switchTab(state.currentUser.role === 'sale' ? 'invoice-panel' : 'dashboard-panel');
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

  if (loginScreen) loginScreen.style.display = 'flex';
  if (appLayout) appLayout.classList.add('auth-hidden');
  if (userInfoHeader) userInfoHeader.style.display = 'none';
  if (logoutBtn) logoutBtn.style.display = 'none';
}

export function applyUserPermissions(user) {
  if (!user) return;
  const role = user.role;
  const activityButton = document.getElementById('btn-activity-log');
  if (activityButton) activityButton.closest('.activity-header-wrap').style.display = ['admin', 'accounting'].includes(role) ? 'block' : 'none';

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
    purchaseNavItem.style.display = role === 'sale' ? 'none' : 'block';
  }
  const staffNavItem = document.querySelector('.staff-nav-item');
  if (staffNavItem) {
    staffNavItem.style.display = role === 'sale' ? 'none' : 'block';
  }

  // Hiding dropdown items based on role
  const dropdownNavLinks = document.querySelectorAll('.dropdown-nav-link');
  dropdownNavLinks.forEach(link => {
    const target = link.getAttribute('data-target');
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
  
  if (isExternalSelect) {
    isExternalSelect.addEventListener('change', () => {
      const isExt = isExternalSelect.value === 'true';
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
          if (isNew) passwordInput.setAttribute('required', '');
          else passwordInput.removeAttribute('required');
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
