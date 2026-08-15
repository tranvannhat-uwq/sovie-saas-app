import { state } from './state.js';
import { COMPANY_SUPABASE_URL, COMPANY_SUPABASE_KEY, defaultProducts } from './config.js';
import { connectSupabase, disconnectSupabase, retrySupabaseConnection, syncLocalToCloud, isCloudActive, supabaseClient, loadLocalStorageBackup, backfillMultiCompanyAndRevenueData, clearSupabaseAuthStorage, fetchCloudData, getMaintenanceStatus, setMaintenanceMode } from './services/supabase.js?v=20260814-invoice-discount-label-v19';
import { setupBackupRestoreListeners } from './services/backup.js?v=20260814-invoice-discount-label-v19';
import { updateDashboardStats, setupDashboardFilters, setupDashboardQuickActions } from './components/dashboard.js?v=20260814-invoice-discount-label-v19';
import { renderProductsTable, setupExcelImportAndTemplate, setupProductManagement } from './components/products.js?v=20260814-invoice-discount-label-v19';
import { renderCustomersTable, setupCustomerManagement, populateManagedByDropdown } from './components/customers.js?v=20260814-invoice-discount-label-v19';
import { renderInvoiceTable, setupInvoiceCreator, resetInvoiceBuilder, resetInvoiceCustomer } from './components/invoice.js?v=20260814-invoice-discount-label-v19';
import { renderPricelistsTable, setupPricelistManagement, populatePricelistsDropdowns } from './components/pricelists.js?v=20260814-invoice-discount-label-v19';
import { renderUsersTable, setupUserManagement, handleLogin, handleLogout, showLoginGate, applyUserPermissions, populateCustomerEmployeeFilter, loadAuthenticatedProfile, clearAuthenticatedSessionState, startMaintenanceMonitor } from './components/users.js?v=20260814-invoice-discount-label-v19';
import { setupHistoryPanel, renderHistoryOrders } from './components/history.js?v=20260814-invoice-discount-label-v19';
import { renderBrandsTable, setupBrandsPanel } from './components/brands.js?v=20260814-invoice-discount-label-v19';
import { setupSoQuyPanel, renderSoQuyTable } from './components/so_quy.js?v=20260814-invoice-discount-label-v19';
import { renderSuppliersTable, setupSupplierManagement, populateSupplierDatalist } from './components/suppliers.js?v=20260814-invoice-discount-label-v19';
import { renderGoodsPanel, setupGoodsPanel } from './components/goods.js?v=20260814-invoice-discount-label-v19';
import { setupReportsPanel, renderDebtReport, renderReturnsReport } from './components/reports.js?v=20260814-invoice-discount-label-v19';
import { showToast, safeCreateIcons, updateDbStatusUI } from './utils.js';
import { startRealtimeSync, stopRealtimeSync } from './services/realtime.js?v=20260814-invoice-discount-label-v19';
import { setupActivityLog, renderActivityLog } from './components/activity-log.js?v=20260814-invoice-discount-label-v19';
import { setupNavigationColorSettings } from './components/navigation-theme.js?v=20260814-invoice-discount-label-v19';

const PANEL_CLOUD_DOMAINS = Object.freeze({
  'invoice-panel': ['pricelists'],
  'pricelists-panel': ['pricelists'],
  'history-panel': ['orders', 'salesReturns'],
  'so-quy-panel': ['cashbook', 'startingBalances'],
  'suppliers-panel': ['suppliers'],
  'goods-panel': ['suppliers', 'purchases']
});
let panelCloudSessionId = '';
const loadedPanelDomains = new Set();
const pendingPanelDomainLoads = new Map();

function syncPanelCloudSession() {
  const sessionId = String(state.currentUser?.authUserId || state.currentUser?.id || '');
  if (panelCloudSessionId !== sessionId) {
    panelCloudSessionId = sessionId;
    loadedPanelDomains.clear();
    pendingPanelDomainLoads.clear();
  }
}

function panelNeedsCloudData(panelId) {
  if (!state.currentUser || !isCloudActive) return false;
  syncPanelCloudSession();
  return (PANEL_CLOUD_DOMAINS[panelId] || []).some(domain => !loadedPanelDomains.has(domain));
}

function panelHasPricingSnapshot(panelId) {
  if (!['invoice-panel', 'pricelists-panel'].includes(panelId)) return false;
  const actorId = String(state.currentUser?.authUserId || state.currentUser?.id || '');
  return Boolean(
    actorId &&
    state.pricingSnapshotActorId === actorId &&
    state.pricingSnapshotRole === String(state.currentUser?.role || '') &&
    state.pricingSnapshotSource
  );
}

function renderPanelCloudLoading(panelId) {
  const targets = {
    'invoice-panel': ['invoice-items-body', '<tr><td colspan="8" style="text-align:center;padding:3rem;color:var(--text-muted);">Đang tải dữ liệu bảng giá…</td></tr>'],
    'pricelists-panel': ['pricelists-table-body', '<tr><td colspan="8" style="text-align:center;padding:3rem;color:var(--text-muted);">Đang tải chi tiết bảng giá…</td></tr>'],
    'history-panel': ['history-orders-container', '<div class="empty-state"><div class="empty-state-title">Đang tải lịch sử giao dịch…</div></div>'],
    'so-quy-panel': ['so-quy-table-body', '<tr><td colspan="8" style="text-align:center;padding:3rem;color:var(--text-muted);">Đang tải dữ liệu Sổ quỹ…</td></tr>'],
    'suppliers-panel': ['suppliers-table-body', '<tr><td colspan="10" style="text-align:center;padding:3rem;color:var(--text-muted);">Đang tải nhà cung cấp…</td></tr>']
  };
  const target = targets[panelId];
  if (!target) return;
  const element = document.getElementById(target[0]);
  if (element) element.innerHTML = target[1];
}

export async function ensurePanelCloudData(panelId, { force = false, domains: domainOverride = null } = {}) {
  if (!state.currentUser || !isCloudActive) return false;
  syncPanelCloudSession();

  const panelDomains = PANEL_CLOUD_DOMAINS[panelId] || [];
  const requestedDomains = Array.isArray(domainOverride)
    ? domainOverride.filter(domain => panelDomains.includes(domain))
    : panelDomains;
  const domains = force
    ? requestedDomains
    : requestedDomains.filter(domain => !loadedPanelDomains.has(domain));
  if (domains.length === 0) return false;

  const loadKey = [...domains].sort().join('|');
  if (!force && pendingPanelDomainLoads.has(loadKey)) return pendingPanelDomainLoads.get(loadKey);

  const load = fetchCloudData({
    onlyDomains: domains,
    hydrateCustomerHistory: false
  }).then(result => {
    domains.forEach(domain => loadedPanelDomains.add(domain));
    if (state.currentTab === panelId) renderAll();
    return result;
  }).finally(() => pendingPanelDomainLoads.delete(loadKey));
  pendingPanelDomainLoads.set(loadKey, load);
  return load;
}

// Chỉ render panel đang nhìn thấy. Các panel khác sẽ render khi người dùng
// chuyển tab, tránh dựng hàng nghìn dòng DOM ẩn trong mỗi lần cập nhật.
export function renderAll() {
  // Never render or query business modules before an authenticated database
  // profile has been established. This also prevents dashboard RPC noise on
  // the login screen and avoids leaking stale cached business data.
  if (!state.currentUser) {
    safeCreateIcons();
    return;
  }

  backfillMultiCompanyAndRevenueData();

  switch (state.currentTab) {
    case 'products-panel':
      renderProductsTable();
      break;
    case 'customers-panel':
      populateCustomerEmployeeFilter();
      renderCustomersTable();
      break;
    case 'suppliers-panel':
      renderSuppliersTable();
      populateSupplierDatalist();
      break;
    case 'invoice-panel':
      renderInvoiceTable();
      populatePricelistsDropdowns();
      break;
    case 'pricelists-panel':
      renderPricelistsTable();
      break;
    case 'history-panel':
      renderHistoryOrders();
      break;
    case 'so-quy-panel':
      renderSoQuyTable();
      break;
    case 'users-panel':
      renderUsersTable();
      break;
    case 'brands-panel':
      renderBrandsTable();
      break;
    case 'goods-panel':
      renderGoodsPanel();
      break;
    case 'reports-panel': {
      populateCustomerEmployeeFilter();
      const activeReport = document.querySelector('.report-subtab-btn.active')?.getAttribute('data-subtab') || 'debt';
      if (activeReport === 'returns') renderReturnsReport();
      else renderDebtReport();
      break;
    }
    case 'activity-log-panel':
      renderActivityLog();
      break;
    case 'dashboard-panel':
    default:
      updateDashboardStats();
      break;
  }

  safeCreateIcons();
}

// Chuyển đổi giữa các phân hệ (Tab)
export function switchTab(panelId) {
  if (panelId === 'payroll-panel') panelId = 'dashboard-panel';
  if (state.currentUser?.role === 'sale' && ['products-panel', 'pricelists-panel'].includes(panelId)) {
    panelId = 'invoice-panel';
  }
  if (state.currentUser?.role === 'sale' && panelId === 'dashboard-panel') {
    panelId = 'invoice-panel';
  }

  state.currentTab = panelId;
  
  document.querySelectorAll('.nav-link').forEach(l => {
    if (l.classList.contains('purchase-menu-trigger')) {
      l.classList.toggle('active', panelId === 'suppliers-panel' || panelId === 'goods-panel');
      return;
    }
    if (l.classList.contains('staff-menu-trigger')) {
      l.classList.toggle('active', panelId === 'users-panel' || panelId === 'reports-panel');
      return;
    }
    if (l.getAttribute('data-target') === panelId) {
      l.classList.add('active');
    } else {
      l.classList.remove('active');
    }
  });

  document.querySelectorAll('.panel').forEach(p => {
    if (p.id === panelId) {
      p.classList.add('active');
    } else {
      p.classList.remove('active');
    }
  });

  const heading = document.getElementById('page-title-heading');
  if (panelId === 'dashboard-panel') heading.innerText = 'Tổng quan hệ thống';
  else if (panelId === 'products-panel') heading.innerText = 'Quản lý sản phẩm';
  else if (panelId === 'invoice-panel') heading.innerText = 'Lập hóa đơn bán hàng';
  else if (panelId === 'history-panel') heading.innerText = 'Lịch sử giao dịch';
  else if (panelId === 'so-quy-panel') heading.innerText = 'Sổ quỹ thu chi';
  else if (panelId === 'customers-panel') heading.innerText = 'Danh sách khách hàng & Đại lý';
  else if (panelId === 'suppliers-panel') heading.innerText = 'Danh sách nhà cung cấp';
  else if (panelId === 'pricelists-panel') heading.innerText = 'Quản lý Bảng giá & Chiết khấu';
  else if (panelId === 'users-panel') heading.innerText = 'Quản lý tài khoản người dùng';
  else if (panelId === 'settings-panel') heading.innerText = 'Cấu hình đám mây';
  else if (panelId === 'goods-panel') heading.innerText = 'Phiếu mua hàng';
  else if (panelId === 'reports-panel') heading.innerText = 'Báo cáo nghiệp vụ';
  else if (panelId === 'activity-log-panel') heading.innerText = 'Lịch sử hoạt động';
  
  // Tự động làm mới dữ liệu và thống kê trên tất cả các tab khi chuyển đổi
  const waitForCloud = panelNeedsCloudData(panelId);
  if (waitForCloud && !panelHasPricingSnapshot(panelId)) renderPanelCloudLoading(panelId);
  else renderAll();
  void ensurePanelCloudData(panelId);
  if (panelId === 'settings-panel') void refreshMaintenanceSettings();
}

async function refreshMaintenanceSettings() {
  const section = document.getElementById('maintenance-mode-section');
  const statusLabel = document.getElementById('maintenance-status-label');
  const toggleButton = document.getElementById('btn-toggle-maintenance');
  const messageInput = document.getElementById('maintenance-message');
  if (!section || state.currentUser?.role !== 'admin') {
    if (section) section.style.display = 'none';
    return;
  }
  section.style.display = 'block';
  try {
    const status = await getMaintenanceStatus();
    if (status.available === false) {
      section.dataset.enabled = 'false';
      statusLabel.textContent = 'Chưa cài bản cập nhật bảo trì trên Cloud.';
      statusLabel.className = 'maintenance-status is-enabled';
      toggleButton.disabled = true;
      return;
    }
    toggleButton.disabled = false;
    section.dataset.enabled = status.enabled ? 'true' : 'false';
    statusLabel.textContent = status.enabled ? 'Đang bật — nhân viên bị chặn truy cập' : 'Đang tắt — mọi tài khoản truy cập bình thường';
    statusLabel.className = status.enabled ? 'maintenance-status is-enabled' : 'maintenance-status';
    toggleButton.textContent = status.enabled ? 'Tắt chế độ bảo trì' : 'Bật chế độ bảo trì';
    toggleButton.className = status.enabled ? 'btn btn-secondary' : 'btn btn-danger';
    if (messageInput && status.message) messageInput.value = status.message;
  } catch (error) {
    statusLabel.textContent = 'Không thể tải trạng thái bảo trì.';
    console.warn('Could not load maintenance status:', error);
  }
}

function setupMaintenanceSettings() {
  const button = document.getElementById('btn-toggle-maintenance');
  const section = document.getElementById('maintenance-mode-section');
  const messageInput = document.getElementById('maintenance-message');
  if (!button || !section) return;
  button.addEventListener('click', async () => {
    if (state.currentUser?.role !== 'admin') return;
    const enabling = section.dataset.enabled !== 'true';
    const question = enabling
      ? 'Bật chế độ bảo trì? Các phiên nhân viên đang mở sẽ bị đưa về màn hình đăng nhập.'
      : 'Tắt chế độ bảo trì để nhân viên truy cập lại?';
    if (!confirm(question)) return;
    button.disabled = true;
    try {
      await setMaintenanceMode(enabling, messageInput?.value || '');
      await refreshMaintenanceSettings();
      showToast(enabling ? 'Đã bật chế độ bảo trì.' : 'Đã tắt chế độ bảo trì.', 'success');
    } catch (error) {
      console.error('Maintenance toggle failed:', error);
      showToast('Không thể thay đổi chế độ bảo trì. Vui lòng thử lại.', 'danger');
    } finally {
      button.disabled = false;
    }
  });
}

// Trình quản lý thanh điều hướng
function setupNavigation() {
  // Tự động xóa trạng thái thu nhỏ cũ để tránh ẩn thanh điều hướng trên máy khách
  localStorage.removeItem('sidebar_collapsed');

  const navLinks = document.querySelectorAll('.nav-link');
  navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
      const targetPanel = link.getAttribute('data-target');
      if (!targetPanel) return;
      e.preventDefault();
      switchTab(targetPanel);
      closeMobileSidebar();
    });
  });

  const sidebarOverlay = document.getElementById('sidebar-overlay');

  if (sidebarOverlay) {
    sidebarOverlay.addEventListener('click', () => {
      closeMobileSidebar();
    });
  }

  window.addEventListener('resize', () => {
    if (window.innerWidth > 768) {
      closeMobileSidebar();
    }
  });

  const staffMenuTrigger = document.querySelector('.staff-menu-trigger');
  const staffMenu = document.querySelector('.staff-menu');
  const positionStaffMenu = () => {
    if (!staffMenuTrigger || !staffMenu) return;
    const triggerRect = staffMenuTrigger.getBoundingClientRect();
    const menuWidth = staffMenu.offsetWidth || 230;
    const left = Math.min(
      Math.max(8, triggerRect.left),
      Math.max(8, window.innerWidth - menuWidth - 8)
    );
    staffMenu.style.left = `${left}px`;
    staffMenu.style.right = 'auto';
    staffMenu.style.top = `${triggerRect.bottom + 4}px`;
  };
  const openAndPositionStaffMenu = () => {
    positionStaffMenu();
    requestAnimationFrame(positionStaffMenu);
  };
  ['pointerenter', 'focus', 'click'].forEach(eventName => {
    staffMenuTrigger?.addEventListener(eventName, openAndPositionStaffMenu);
  });
  document.querySelector('.nav-menu')?.addEventListener('scroll', positionStaffMenu, { passive: true });
  window.addEventListener('resize', positionStaffMenu);

  // Toggle global settings dropdown
  const settingsMenu = document.getElementById('global-settings-menu');
  
  window.toggleSettingsDropdown = function(e) {
    if (e) e.stopPropagation();
    if (settingsMenu) {
      const isHidden = settingsMenu.style.display === 'none' || settingsMenu.style.display === '';
      settingsMenu.style.display = isHidden ? 'block' : 'none';
    }
  };

  if (settingsMenu) {
    document.addEventListener('click', (e) => {
      const isToggleClick = e.target.closest('#btn-settings-toggle');
      const isMenuClick = e.target.closest('#global-settings-menu');
      if (!isToggleClick && !isMenuClick) {
        settingsMenu.style.display = 'none';
      }
    });

    // Handle clicks on dropdown navigation links
    const dropdownLinks = document.querySelectorAll('.dropdown-nav-link');
    dropdownLinks.forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const targetPanel = link.getAttribute('data-target');
        switchTab(targetPanel);

        // Update active nav-link highlighting in the main navbar
        document.querySelectorAll('.nav-link').forEach(nl => {
          if (nl.getAttribute('data-target') === targetPanel) {
            nl.classList.add('active');
          } else {
            nl.classList.remove('active');
          }
        });

        // Close dropdown
        settingsMenu.style.display = 'none';
      });
    });
  }
}

function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar && overlay) {
    const isOpen = sidebar.classList.contains('open');
    if (isOpen) {
      closeMobileSidebar();
    } else {
      sidebar.classList.add('open');
      overlay.classList.add('active');
    }
  }
}

function closeMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const overlay = document.getElementById('sidebar-overlay');
  if (sidebar) sidebar.classList.remove('open');
  if (overlay) overlay.classList.remove('active');
}

// Quản lý tab Cấu hình đám mây
function setupSupabaseSettings() {
  const form = document.getElementById('supabase-config-form');
  const disconnectBtn = document.getElementById('btn-disconnect-db');
  const syncBtn = document.getElementById('btn-sync-to-cloud');
  if (!form) return;

  const savedUrl = localStorage.getItem('billing_supabase_url');
  const savedKey = localStorage.getItem('billing_supabase_key');
  if (savedUrl) {
    document.getElementById('db-url').value = savedUrl;
  }
  if (savedKey) {
    document.getElementById('db-anon-key').value = savedKey;
  }
  if (savedUrl && savedKey) {
    disconnectBtn.style.display = 'inline-flex';
    document.getElementById('sync-section').style.display = 'block';
    if (document.getElementById('backup-section')) {
      document.getElementById('backup-section').style.display = 'block';
    }
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const url = document.getElementById('db-url').value.trim();
    const anonKey = document.getElementById('db-anon-key').value.trim();
    
    updateDbStatusUI('connecting');
    const success = await connectSupabase(url, anonKey, true);
    if (success) {
      renderAll();
    } else {
      if (isCloudActive) updateDbStatusUI('cloud');
      else updateDbStatusUI('local', 'Kết nối thất bại');
    }
  });

  disconnectBtn.addEventListener('click', async () => {
    await stopRealtimeSync();
    disconnectSupabase();
  });
  syncBtn.addEventListener('click', syncLocalToCloud);
}

// loadLocalStorageBackup đã được chuyển sang services/supabase.js để tối ưu hóa

// Khởi chạy ứng dụng
async function initApp() {
  if (window.__app_initialized) return;
  window.__app_initialized = true;

  const today = new Date();
  const dateLbl = document.getElementById('current-date-lbl');
  if (dateLbl) dateLbl.innerText = today.toLocaleDateString('vi-VN');

  setupNavigationColorSettings();
  setupNavigation();
  setupProductManagement();
  setupCustomerManagement();
  setupSupplierManagement();
  setupPricelistManagement();
  setupInvoiceCreator();
  setupHistoryPanel();
  setupSoQuyPanel();
  setupDashboardQuickActions();
  setupDashboardFilters();
  setupExcelImportAndTemplate();
  setupSupabaseSettings();
  setupMaintenanceSettings();
  setupUserManagement();
  setupBrandsPanel();
  setupGoodsPanel();
  setupReportsPanel();
  setupActivityLog();
  setupBackupRestoreListeners(renderAll);

  let savedUrl = localStorage.getItem('billing_supabase_url');
  let savedKey = localStorage.getItem('billing_supabase_key');
  
  // Nếu chưa có cấu hình trong LocalStorage, tự động dùng cấu hình đám mây mặc định của công ty
  if (!savedUrl || !savedKey) {
    savedUrl = COMPANY_SUPABASE_URL;
    savedKey = COMPANY_SUPABASE_KEY;
    localStorage.setItem('billing_supabase_url', savedUrl);
    localStorage.setItem('billing_supabase_key', savedKey);
  }
  
  if (savedUrl && savedKey) {
    let connected = false;
    // Không chặn màn hình đăng nhập bởi các lần retry tải dữ liệu Cloud.
    // connectSupabase đã có fallback LocalStorage khi Cloud không phản hồi.
    const retries = 1;
    
    for (let i = 1; i <= retries; i++) {
      updateDbStatusUI('connecting', `Kết nối Cloud (Lần ${i}/${retries})...`);
      connected = await connectSupabase(savedUrl, savedKey, false);
      if (connected) break;
      
    }
    
    if (!connected) {
      loadLocalStorageBackup();
      updateDbStatusUI('local_failed');
      showToast('Không thể kết nối Cloud, đã chuyển về chế độ offline.', 'warning');
    }
  } else {
    loadLocalStorageBackup();
    updateDbStatusUI('local');
  }
  
  const loginForm = document.getElementById('login-form');
  if (loginForm) {
    loginForm.addEventListener('submit', handleLogin);
  }

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', handleLogout);
  }

  let activeUser = null;
  if (isCloudActive && supabaseClient) {
    try {
      const { data: { session } } = await supabaseClient.auth.getSession();
      if (session && session.user) {
        const profile = await loadAuthenticatedProfile(session.user.id);
        activeUser = {
          id: profile.id,
          authUserId: profile.auth_user_id,
          username: profile.username,
          displayName: profile.display_name,
          role: profile.role,
          companyId: profile.company_id || 'ABS_NORTH',
          isExternal: profile.is_external === true,
          isActive: profile.is_active === true
        };
        const maintenance = await getMaintenanceStatus();
        if (maintenance.enabled && activeUser.role !== 'admin') {
          throw new Error(maintenance.message || 'Hệ thống đang bảo trì. Chỉ admin có thể truy cập.');
        }
      }
    } catch (err) {
      console.warn('Session recovery rejected');
      try { await supabaseClient.auth.signOut(); } catch (_) { /* clear local state below */ }
      clearAuthenticatedSessionState();
      clearSupabaseAuthStorage();
      if (err?.message) showToast(err.message, 'danger');
    }
  }
  
  let recoveredCloudLoad = null;
  if (activeUser) {
    state.currentUser = activeUser;
    recoveredCloudLoad = await fetchCloudData({
      deferSecondary: true,
      hydrateCustomerHistory: false,
      leanBootstrap: true
    });
    state.currentUser = state.users.find(item =>
      item.authUserId === activeUser.authUserId || item.id === activeUser.id
    ) || activeUser;
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-layout').classList.remove('auth-hidden');
    const userInfoHeader = document.getElementById('user-info-header');
    if (userInfoHeader) userInfoHeader.style.display = 'flex';
    const logoutBtn = document.getElementById('btn-logout');
    if (logoutBtn) logoutBtn.style.display = 'inline-flex';
    const userDisplay = document.getElementById('header-user-display');
    if (userDisplay) {
      userDisplay.innerText = `${state.currentUser.displayName} (${state.currentUser.role === 'admin' ? 'Admin' : state.currentUser.role === 'accounting' ? 'Kế toán' : 'Sale'})`;
    }
    applyUserPermissions(state.currentUser);
    startMaintenanceMonitor();
  } else {
    showLoginGate();
  }

  populatePricelistsDropdowns();



  if (activeUser) switchTab(activeUser.role === 'sale' ? 'invoice-panel' : 'dashboard-panel');
  else renderAll();
  if (activeUser) {
    void startRealtimeSync(renderAll);
    const recoveredUserId = String(state.currentUser?.authUserId || state.currentUser?.id || '');
    if (recoveredCloudLoad?.background) {
      void recoveredCloudLoad.background.then(loaded => {
        const currentUserId = String(state.currentUser?.authUserId || state.currentUser?.id || '');
        if (loaded && currentUserId === recoveredUserId) renderAll();
      });
    }
  }
}

// Xử lý khi nhấn nút kết nối lại trên Badge trạng thái
document.addEventListener('click', async (e) => {
  if (e.target.closest('#btn-retry-connection')) {
    const success = await retrySupabaseConnection();
    if (success) {
      renderAll();
      if (state.currentUser) void startRealtimeSync(renderAll);
    }
  }
});

// Bắt và xử lý các lỗi Uncaught Promise Rejection từ extension hoặc script bên ngoài (như onboarding.js)
window.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason || {};
  const message = typeof reason === 'string' ? reason : reason.message || '';
  const stack = reason.stack || '';
  if (String(message).includes('getImageNode') || String(stack).includes('onboarding.js')) {
    console.warn('Đã xử lý an toàn lỗi Uncaught Promise Rejection từ Extension/Script bên ngoài:', event.reason?.message || event.reason);
    event.preventDefault(); // Ngăn chặn lỗi đỏ hiển thị ra Console
  }
});

window.addEventListener('DOMContentLoaded', initApp);
