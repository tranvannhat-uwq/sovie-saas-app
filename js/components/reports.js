import { state } from '../state.js';
import { formatCurrency, safeCreateIcons, formatDateTime, getUserDisplayName, getManagerDisplayName, getCustomerName, getProvinceNameByCode } from '../utils.js';
import { dbFetchPhase5Report } from '../services/supabase.js';
import { buildCustomerDebtDisplayHistory, getCustomerDebtPostingDate } from '../domain/customer-debt.js?v=20260814-invoice-discount-label-v19';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function setupReportsPanel() {
  const tabBtns = document.querySelectorAll('.report-subtab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      const subtab = e.currentTarget.getAttribute('data-subtab');
      switchReportSubtab(subtab);
    });
  });

  const debtSearch = document.getElementById('report-debt-search');
  if (debtSearch) {
    debtSearch.addEventListener('input', () => renderDebtReport());
  }

  const returnFilter = document.getElementById('report-return-filter');
  if (returnFilter) {
    returnFilter.addEventListener('change', () => renderReturnsReport());
  }
}

export function switchReportSubtab(subtab) {
  if (subtab === 'kpi') subtab = 'debt';
  document.querySelectorAll('.report-subtab-btn').forEach(btn => {
    if (btn.getAttribute('data-subtab') === subtab) btn.classList.add('active');
    else btn.classList.remove('active');
  });

  document.querySelectorAll('.report-subtab-content').forEach(content => {
    if (content.id === `report-subtab-${subtab}`) content.style.display = 'block';
    else content.style.display = 'none';
  });

  renderActiveReportSubtab(subtab);
}

function renderActiveReportSubtab(subtab) {
  if (subtab === 'debt') renderDebtReport();
  else if (subtab === 'returns') renderReturnsReport();
  else if (subtab === 'kpi') renderKpiReport();
}

export async function renderDebtReport() {
  const tbody = document.getElementById('report-debt-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem">Đang tải công nợ từ máy chủ...</td></tr>';
  try {
    const report = await dbFetchPhase5Report({ type: 'debt', search: document.getElementById('report-debt-search')?.value || '', limit: 200, offset: 0 });
    document.getElementById('report-debt-total-stat').innerText = formatCurrency(report.summary?.total_debt);
    document.getElementById('report-debt-overdue-stat').innerText = formatCurrency(report.summary?.overdue_debt);
    tbody.innerHTML = report.rows?.length ? report.rows.map(row => `<tr><td style="font-weight:600">${escapeHtml(row.code)}</td><td style="font-weight:600">${escapeHtml(row.name)}</td><td>${escapeHtml(row.phone || '---')}</td><td>${escapeHtml(getManagerDisplayName(row.managed_by, 'Chưa bàn giao', state.users))}</td><td>${row.last_order_at ? formatDateTime(row.last_order_at) : 'Chưa có'}</td><td>${row.last_payment_at ? formatDateTime(row.last_payment_at) : 'Chưa có'}</td><td style="text-align:right;font-weight:700;color:${Number(row.debt) > 0 ? 'var(--color-danger)' : 'var(--color-success)'}">${formatCurrency(row.debt)}</td><td style="text-align:center"><span title="Số liệu từ ledger máy chủ">Đã đối soát</span></td></tr>`).join('')
      : '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--text-muted)">Không có dữ liệu công nợ</td></tr>';
    safeCreateIcons();
  } catch (error) {
    console.error('Debt report RPC error:', error);
    tbody.innerHTML = '<tr><td colspan="8" style="text-align:center;padding:2rem;color:var(--color-danger)">Không tải được báo cáo công nợ. Kiểm tra migration 0012.</td></tr>';
  }
}

function renderDebtReportLegacy() {
  const tbody = document.getElementById('report-debt-table-body');
  if (!tbody) return;

  const searchVal = (document.getElementById('report-debt-search')?.value || '').toLowerCase().trim();
  const customers = state.customers || [];

  let totalDebtAll = 0;
  let overdueDebtAll = 0;

  const now = new Date();

  const filtered = customers.filter(c => {
    const code = (c.code || '').toLowerCase();
    const name = (c.name || '').toLowerCase();
    const phone = (c.phone || '').toLowerCase();
    return !searchVal || code.includes(searchVal) || name.includes(searchVal) || phone.includes(searchVal);
  });

  filtered.forEach(c => {
    const debt = parseFloat(c.debt || 0);
    totalDebtAll += debt;

    // Check overdue debt (>30 days since last payment or order)
    if (debt > 0 && c.lastOrderAt) {
      const days = Math.floor((now - new Date(c.lastOrderAt)) / (1000 * 60 * 60 * 24));
      if (days > 30) overdueDebtAll += debt;
    }
  });

  const statTotalEl = document.getElementById('report-debt-total-stat');
  if (statTotalEl) statTotalEl.innerText = formatCurrency(totalDebtAll);

  const statOverdueEl = document.getElementById('report-debt-overdue-stat');
  if (statOverdueEl) statOverdueEl.innerText = formatCurrency(overdueDebtAll);

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không tìm thấy dữ liệu công nợ</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map(c => {
    const debt = parseFloat(c.debt || 0);
    const lastOrderStr = c.lastOrderAt ? formatDateTime(c.lastOrderAt) : 'Chưa có';
    const lastPayStr = c.lastPaymentAt ? formatDateTime(c.lastPaymentAt) : 'Chưa có';
    const managerName = getManagerDisplayName(c.managedBy, 'Chưa bàn giao', state.users);

    return `
      <tr>
        <td style="font-weight: 600;">${c.code}</td>
        <td style="font-weight: 600; color: var(--text-primary);">${c.name}</td>
        <td>${c.phone || '---'}</td>
        <td>${managerName}</td>
        <td>${lastOrderStr}</td>
        <td>${lastPayStr}</td>
        <td style="text-align: right; font-weight: 700; color: ${debt > 0 ? 'var(--color-danger)' : 'var(--color-success)'};">${formatCurrency(debt)}</td>
        <td style="text-align: center;">
          <button class="btn btn-secondary btn-xs" onclick="window.viewCustomerDebtHistory('${c.id}')" title="Xem biến động công nợ">
            <i data-lucide="history" style="width: 14px; height: 14px;"></i> Lịch sử
          </button>
        </td>
      </tr>
    `;
  }).join('');

  safeCreateIcons();
}

window.viewCustomerDebtHistory = function(customerId) {
  const cust = (state.customers || []).find(c => c.id === customerId);
  if (!cust) return;

  const modal = document.getElementById('debt-history-modal');
  const modalTitle = document.getElementById('debt-history-modal-title');
  const modalBody = document.getElementById('debt-history-modal-body');
  if (!modal) return;

  if (modalTitle) modalTitle.innerText = `Lịch sử biến động công nợ - ${cust.name} (${cust.code})`;

  const history = buildCustomerDebtDisplayHistory(cust.debtHistory || [], cust.debt)
    .reverse();
  if (history.length === 0) {
    modalBody.innerHTML = `<div style="text-align: center; padding: 2rem; color: var(--text-muted);">Khách hàng chưa phát sinh biến động công nợ</div>`;
  } else {
    modalBody.innerHTML = `
      <table class="table" style="width: 100%;">
        <thead>
          <tr>
            <th>Thời gian ghi sổ</th>
            <th>Loại biến động</th>
            <th style="text-align: right;">Ghi nợ / Phát sinh</th>
            <th style="text-align: right;">Số dư sau phát sinh</th>
            <th>Ghi chú / Mã đơn</th>
          </tr>
        </thead>
        <tbody>
          ${history.map(item => {
            const isCharge = item.type === 'charge' || item.type === 'order';
            const isPay = item.type === 'payment';
            const typeLabel = isCharge ? 'Phát sinh đơn hàng' : isPay ? 'Thu tiền nợ' : item.type === 'return' ? 'Khấu trừ trả hàng' : 'Điều chỉnh thủ công';
            const colorClass = isCharge ? 'var(--color-danger)' : isPay ? 'var(--color-success)' : 'var(--color-primary)';

            return `
              <tr>
                <td>${formatDateTime(getCustomerDebtPostingDate(item))}</td>
                <td><span style="font-weight: 600; color: ${colorClass};">${typeLabel}</span></td>
                <td style="text-align: right; font-weight: 600; color: ${colorClass};">${isPay || item.type === 'return' ? '-' : '+'}${formatCurrency(item.amount)}</td>
                <td style="text-align: right; font-weight: 700;">${formatCurrency(item.debtAfter)}</td>
                <td style="font-size: 0.85rem; color: var(--text-secondary);">${item.notes || item.note || item.id || ''}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
    `;
  }

  modal.classList.add('active');
};

export function closeDebtHistoryModal() {
  const modal = document.getElementById('debt-history-modal');
  if (modal) modal.classList.remove('active');
}
window.closeDebtHistoryModal = closeDebtHistoryModal;

export async function renderReturnsReport() {
  const tbody = document.getElementById('report-return-table-body');
  const thead = document.getElementById('report-return-table-head');
  if (!tbody || !thead) return;
  const mode = document.getElementById('report-return-filter')?.value || 'product';
  thead.innerHTML = mode === 'product'
    ? '<tr><th>Mã SKU</th><th>Tên sản phẩm</th><th style="text-align:right">Số lượng trả</th><th style="text-align:right">Giá trị trả</th></tr>'
    : mode === 'customer'
      ? '<tr><th>Mã khách</th><th>Tên khách hàng / Đại lý</th><th style="text-align:right">Số lượt trả</th><th style="text-align:right">Giá trị trả</th></tr>'
      : '<tr><th>Nhân viên bán hàng</th><th style="text-align:right">Số lượt trả</th><th style="text-align:right">Giá trị trừ doanh số</th></tr>';
  tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem">Đang tải trả hàng từ máy chủ...</td></tr>';
  try {
    const report = await dbFetchPhase5Report({ type: 'returns', mode, limit: 200, offset: 0 });
    tbody.innerHTML = report.rows?.length ? report.rows.map(row => mode === 'product'
      ? `<tr><td style="font-weight:600">${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td style="text-align:right">${Number(row.quantity || 0)}</td><td style="text-align:right;font-weight:700;color:var(--color-danger)">${formatCurrency(row.amount)}</td></tr>`
      : mode === 'customer'
        ? `<tr><td style="font-weight:600">${escapeHtml(row.code)}</td><td>${escapeHtml(row.name)}</td><td style="text-align:right">${Number(row.count || 0)}</td><td style="text-align:right;font-weight:700;color:var(--color-danger)">${formatCurrency(row.amount)}</td></tr>`
        : `<tr><td style="font-weight:600">${escapeHtml(getUserDisplayName(row.key, 'Chưa phân công', state.users))}</td><td style="text-align:right">${Number(row.count || 0)}</td><td style="text-align:right;font-weight:700;color:var(--color-danger)">${formatCurrency(row.amount)}</td></tr>`).join('')
      : '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--text-muted)">Không có dữ liệu trả hàng</td></tr>';
  } catch (error) {
    console.error('Returns report RPC error:', error);
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--color-danger)">Không tải được báo cáo trả hàng. Kiểm tra migration 0012.</td></tr>';
  }
}

function renderReturnsReportLegacy() {
  const mode = document.getElementById('report-return-filter')?.value || 'product';
  const tbody = document.getElementById('report-return-table-body');
  const thead = document.getElementById('report-return-table-head');
  if (!tbody || !thead) return;

  const validReturns = (state.salesReturns || []).filter(r => r.status !== 'cancelled');

  if (mode === 'product') {
    thead.innerHTML = `
      <tr>
        <th>Mã SP</th>
        <th>Tên sản phẩm</th>
        <th style="text-align: right;">Số lượng trả</th>
        <th style="text-align: right;">Tổng giá trị hoàn tiền</th>
      </tr>
    `;

    const productMap = {};
    validReturns.forEach(r => {
      (r.items || []).forEach(item => {
        const code = item.productId || 'Unknown';
        const name = item.productName || code;
        const qty = Number(item.quantity || 0);
        const refund = Number(item.subtotal || (item.refundPrice * qty) || 0);

        if (!productMap[code]) productMap[code] = { code, name, qty: 0, refund: 0 };
        productMap[code].qty += qty;
        productMap[code].refund += refund;
      });
    });

    const entries = Object.values(productMap);
    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không có dữ liệu trả hàng theo sản phẩm</td></tr>`;
      return;
    }

    tbody.innerHTML = entries.map(e => `
      <tr>
        <td style="font-weight: 600;">${e.code}</td>
        <td>${e.name}</td>
        <td style="text-align: right; font-weight: 600;">${e.qty}</td>
        <td style="text-align: right; font-weight: 700; color: var(--color-danger);">${formatCurrency(e.refund)}</td>
      </tr>
    `).join('');

  } else if (mode === 'customer') {
    thead.innerHTML = `
      <tr>
        <th>Mã KH</th>
        <th>Tên khách hàng</th>
        <th style="text-align: right;">Số lượt trả</th>
        <th style="text-align: right;">Tổng tiền trả hàng</th>
      </tr>
    `;

    const custMap = {};
    validReturns.forEach(r => {
      const cId = r.customerId || 'Khách lẻ';
      const cObj = (state.customers || []).find(c => c.id === cId);
      const name = cObj ? cObj.name : getCustomerName(cId, state.customers);
      const code = cObj ? cObj.code : cId;
      const refund = Number(r.totalRefund || r.totalReturnAmount || 0);

      if (!custMap[cId]) custMap[cId] = { code, name, count: 0, refund: 0 };
      custMap[cId].count += 1;
      custMap[cId].refund += refund;
    });

    const entries = Object.values(custMap);
    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không có dữ liệu trả hàng theo khách hàng</td></tr>`;
      return;
    }

    tbody.innerHTML = entries.map(e => `
      <tr>
        <td style="font-weight: 600;">${e.code}</td>
        <td style="font-weight: 600; color: var(--text-primary);">${e.name}</td>
        <td style="text-align: right; font-weight: 600;">${e.count}</td>
        <td style="text-align: right; font-weight: 700; color: var(--color-danger);">${formatCurrency(e.refund)}</td>
      </tr>
    `).join('');

  } else if (mode === 'employee') {
    thead.innerHTML = `
      <tr>
        <th>Nhân viên</th>
        <th style="text-align: right;">Số lượt trả</th>
        <th style="text-align: right;">Tổng tiền trừ doanh số</th>
      </tr>
    `;

    const empMap = {};
    validReturns.forEach(r => {
      const empId = r.createdBy || r.salespersonId || 'admin';
      const empName = getUserDisplayName(empId, state.users);
      const refund = Number(r.totalRefund || r.totalReturnAmount || 0);

      if (!empMap[empId]) empMap[empId] = { empName, count: 0, refund: 0 };
      empMap[empId].count += 1;
      empMap[empId].refund += refund;
    });

    const entries = Object.values(empMap);
    if (entries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="3" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không có dữ liệu trả hàng theo nhân viên</td></tr>`;
      return;
    }

    tbody.innerHTML = entries.map(e => `
      <tr>
        <td style="font-weight: 600; color: var(--text-primary);">${e.empName}</td>
        <td style="text-align: right; font-weight: 600;">${e.count}</td>
        <td style="text-align: right; font-weight: 700; color: var(--color-danger);">${formatCurrency(e.refund)}</td>
      </tr>
    `).join('');
  }
}

export async function renderKpiReport() {
  const tbody = document.getElementById('report-kpi-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem">Đang tính KPI trên máy chủ...</td></tr>';
  try {
    const report = await dbFetchPhase5Report({ type: 'kpi' });
    const summary = report.summary || {};
    document.getElementById('kpi-gross-sales-stat').innerText = formatCurrency(summary.gross_sales);
    document.getElementById('kpi-net-sales-stat').innerText = formatCurrency(summary.net_sales);
    document.getElementById('kpi-cash-collected-stat').innerText = formatCurrency(summary.collected);
    document.getElementById('kpi-new-debt-stat').innerText = formatCurrency(summary.debt_issued);
    document.getElementById('kpi-debt-collected-stat').innerText = formatCurrency(summary.debt_collected);
    tbody.innerHTML = report.kpi_by_employee?.length ? report.kpi_by_employee.map(row => `<tr><td style="font-weight:600">${escapeHtml(getUserDisplayName(row.key, 'Chưa phân công', state.users))}</td><td style="text-align:right">${formatCurrency(row.gross_sales)}</td><td style="text-align:right;color:var(--color-danger)">${formatCurrency(row.returns)}</td><td style="text-align:right;font-weight:700;color:var(--color-primary)">${formatCurrency(row.net_sales)}</td><td style="text-align:right;color:var(--color-success)">${formatCurrency(row.collected)}</td><td style="text-align:right">${formatCurrency(row.debt_issued)}</td></tr>`).join('')
      : '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--text-muted)">Không có dữ liệu KPI</td></tr>';
  } catch (error) {
    console.error('KPI report RPC error:', error);
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;padding:2rem;color:var(--color-danger)">Không tải được KPI. Kiểm tra migration 0012.</td></tr>';
  }
}

function renderKpiReportLegacy() {
  const tbody = document.getElementById('report-kpi-table-body');
  if (!tbody) return;

  const orders = state.savedOrders || [];
  const returns = (state.salesReturns || []).filter(r => r.status !== 'cancelled');
  const cashbook = state.cashbookTransactions || [];

  let totalGrossSales = 0;
  orders.forEach(o => { totalGrossSales += (o.totalPayable || o.totalAmount || 0); });

  let totalReturns = 0;
  returns.forEach(r => { totalReturns += (r.totalRefund || r.totalReturnAmount || 0); });

  const totalNetRevenue = Math.max(0, totalGrossSales - totalReturns);

  let totalCashCollected = 0;
  cashbook.forEach(tx => {
    if (tx.type === 'thu' && tx.status !== 'cancelled') {
      totalCashCollected += (tx.value || 0);
    }
  });

  let totalNewDebt = totalGrossSales;
  let totalCollectedDebt = totalCashCollected;

  document.getElementById('kpi-gross-sales-stat').innerText = formatCurrency(totalGrossSales);
  document.getElementById('kpi-net-sales-stat').innerText = formatCurrency(totalNetRevenue);
  document.getElementById('kpi-cash-collected-stat').innerText = formatCurrency(totalCashCollected);
  document.getElementById('kpi-new-debt-stat').innerText = formatCurrency(totalNewDebt);
  document.getElementById('kpi-debt-collected-stat').innerText = formatCurrency(totalCollectedDebt);

  // Group performance by Salesperson / Employee
  const empMap = {};
  orders.forEach(o => {
    const empId = o.salespersonId || o.createdBy || 'admin';
    if (!empMap[empId]) empMap[empId] = { empId, gross: 0, returns: 0, cash: 0, debtNew: 0 };
    const amt = o.totalPayable || 0;
    empMap[empId].gross += amt;
    empMap[empId].debtNew += amt;
  });

  returns.forEach(r => {
    const empId = r.salespersonId || r.createdBy || 'admin';
    if (!empMap[empId]) empMap[empId] = { empId, gross: 0, returns: 0, cash: 0, debtNew: 0 };
    empMap[empId].returns += (r.totalRefund || 0);
  });

  cashbook.forEach(tx => {
    if (tx.type === 'thu' && tx.status !== 'cancelled') {
      const empId = tx.created_by || tx.creator || 'admin';
      if (!empMap[empId]) empMap[empId] = { empId, gross: 0, returns: 0, cash: 0, debtNew: 0 };
      empMap[empId].cash += (tx.value || 0);
    }
  });

  const empList = Object.values(empMap);
  if (empList.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 2rem;">Không có dữ liệu hiệu suất KPI nhân viên</td></tr>`;
    return;
  }

  tbody.innerHTML = empList.map(e => {
    const net = Math.max(0, e.gross - e.returns);
    const empName = getUserDisplayName(e.empId, state.users);

    return `
      <tr>
        <td style="font-weight: 600; color: var(--text-primary);">${empName}</td>
        <td style="text-align: right; font-weight: 600;">${formatCurrency(e.gross)}</td>
        <td style="text-align: right; font-weight: 600; color: var(--color-danger);">${formatCurrency(e.returns)}</td>
        <td style="text-align: right; font-weight: 700; color: var(--color-primary);">${formatCurrency(net)}</td>
        <td style="text-align: right; font-weight: 600; color: var(--color-success);">${formatCurrency(e.cash)}</td>
        <td style="text-align: right; font-weight: 600;">${formatCurrency(e.debtNew)}</td>
      </tr>
    `;
  }).join('');
}
