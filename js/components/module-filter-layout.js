const FILTER_LAYOUT_READY = 'filterLayoutReady';

function createFilterHeading(label) {
  const heading = document.createElement('div');
  heading.className = 'module-filter-heading';
  heading.innerHTML = `
    <span class="module-filter-heading-icon"><i data-lucide="list-filter"></i></span>
    <span><strong>Bộ lọc</strong><small>${label}</small></span>`;
  return heading;
}

function setupSplitSurface({ root, filterSelectors, label = 'Tinh chỉnh dữ liệu hiển thị' }) {
  if (!root || root.dataset[FILTER_LAYOUT_READY] === 'true') return;
  const filterNodes = filterSelectors
    .map(selector => root.querySelector(selector))
    .filter((node, index, nodes) => node && nodes.indexOf(node) === index);
  if (filterNodes.length === 0) return;

  const preservedHeaders = new Set([...root.children].filter(child => child.classList.contains('panel-header')));
  const layout = document.createElement('div');
  layout.className = 'module-split-layout';
  const sidebar = document.createElement('aside');
  sidebar.className = 'module-filter-sidebar';
  sidebar.setAttribute('aria-label', 'Bộ lọc dữ liệu');
  sidebar.append(createFilterHeading(label));
  const content = document.createElement('div');
  content.className = 'module-filter-content';

  filterNodes.forEach(node => sidebar.append(node));
  [...root.children].forEach(child => {
    if (!preservedHeaders.has(child) && child !== layout && child !== sidebar && child !== content) content.append(child);
  });
  layout.append(sidebar, content);
  root.append(layout);
  root.dataset[FILTER_LAYOUT_READY] = 'true';
}

function setupPanelSurface(panelId, filterSelectors, label) {
  const panel = document.getElementById(panelId);
  const root = panel?.querySelector(':scope > .glass-panel');
  setupSplitSurface({ root, filterSelectors, label });
}

function setupCustomerSurface() {
  const panel = document.getElementById('customers-panel');
  const root = panel?.querySelector(':scope > .glass-panel');
  const advancedFilter = document.getElementById('customer-advanced-filter-panel');
  setupSplitSurface({
    root,
    filterSelectors: [
      '.customer-query-toolbar',
      '.customer-sort-toolbar',
      '#customer-advanced-filter-panel'
    ],
    label: 'Khách hàng và phân loại'
  });
  const activeFilterCount = document.getElementById('customer-active-filter-count');
  const filterHeading = root?.querySelector('.module-filter-heading');
  if (activeFilterCount && filterHeading) filterHeading.append(activeFilterCount);
  setupCompactCustomerFilterGroups(advancedFilter);
  document.getElementById('customer-filter-drawer-backdrop')?.setAttribute('hidden', '');
}

function setupCompactCustomerFilterGroups(filterPanel) {
  const body = filterPanel?.querySelector('.customer-filter-modal-body');
  if (!body || body.dataset.compactGroupsReady === 'true') return;

  [...body.querySelectorAll(':scope > .customer-filter-section')].forEach((section, index) => {
    const title = section.querySelector(':scope > strong');
    if (!title) return;

    const group = document.createElement('details');
    group.className = `customer-filter-section customer-filter-compact-group${section.classList.contains('customer-filter-span-2') ? ' customer-filter-span-2' : ''}`;
    const summary = document.createElement('summary');
    summary.className = 'customer-filter-compact-summary';
    summary.innerHTML = `<span>${title.textContent.trim()}</span><span class="customer-filter-compact-chevron" aria-hidden="true"></span>`;
    const fields = document.createElement('div');
    fields.className = 'customer-filter-compact-fields';

    [...section.children].forEach(child => {
      if (child !== title) fields.append(child);
    });
    group.append(summary, fields);
    group.open = index === 0;
    section.replaceWith(group);
  });

  body.dataset.compactGroupsReady = 'true';
}

function setupReportSurfaces() {
  setupSplitSurface({
    root: document.getElementById('report-subtab-debt'),
    filterSelectors: ['.report-debt-filter-row'],
    label: 'Báo cáo công nợ'
  });
  setupSplitSurface({
    root: document.getElementById('report-subtab-returns'),
    filterSelectors: ['.report-return-filter-row'],
    label: 'Báo cáo trả hàng'
  });
}

function setupPlatformAdminSurface() {
  const panel = document.getElementById('platform-admin-panel');
  const root = panel?.querySelector('.platform-accounts-card');
  setupSplitSurface({
    root,
    filterSelectors: ['.platform-account-filters'],
    label: 'Danh sách doanh nghiệp SaaS'
  });
}

function setupGoodsSurfaces() {
  [
    ['inv-raw-tab', 'Nguyên liệu'],
    ['inv-semi-tab', 'Bán thành phẩm'],
    ['inv-finished-tab', 'Thành phẩm']
  ].forEach(([tabId, label]) => {
    const root = document.getElementById(tabId)?.querySelector(':scope > .glass-panel');
    setupSplitSurface({ root, filterSelectors: ['.controls-row'], label });
  });
}

export function setupModuleFilterLayouts() {
  setupPanelSurface('products-panel', ['.controls-row'], 'Danh sách sản phẩm');
  setupPanelSurface('history-panel', ['.controls-row'], 'Lịch sử đơn hàng');
  setupCustomerSurface();
  setupPanelSurface('suppliers-panel', ['.controls-row'], 'Danh sách nhà cung cấp');
  setupPanelSurface('pricelists-panel', ['.controls-row'], 'Ma trận bảng giá');
  setupPanelSurface('users-panel', ['.controls-row'], 'Thành viên và nhân sự');
  setupPanelSurface('activity-log-panel', ['.activity-filters'], 'Nhật ký hoạt động');
  setupPlatformAdminSurface();
  setupReportSurfaces();
  setupGoodsSurfaces();
}
