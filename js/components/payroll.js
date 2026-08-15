import { state } from '../state.js';
import { formatCurrency, safeCreateIcons, showToast } from '../utils.js';
import { dbFetchPayrollPeriod, dbSavePayrollAdjustment, dbSetPayrollPeriodLock } from '../services/supabase.js';

let currentPayroll = null;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function getSalaryPeriods() {
  return currentPayroll ? { [currentPayroll.period]: currentPayroll } : {};
}

export function saveSalaryPeriods() {
  throw new Error('Kỳ lương chỉ được lưu bởi database.');
}

export function getSelectedSalaryPeriod() {
  const selected = document.getElementById('payroll-period-select')?.value;
  if (selected) return selected;
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

export function calculatePayrollData() {
  return currentPayroll?.rows || [];
}

export function getPayrollAdjustments() { return {}; }
export function savePayrollAdjustments() { throw new Error('Điều chỉnh lương chỉ được lưu bởi database.'); }

function canManagePayroll() {
  return ['admin', 'accounting'].includes(state.currentUser?.role);
}

function renderStatus(payload) {
  const isLocked = Boolean(payload.isLocked);
  const badge = document.getElementById('payroll-lock-status-badge');
  const button = document.getElementById('btn-lock-payroll-period');
  if (badge) {
    badge.className = `db-status-badge ${isLocked ? 'status-cloud' : 'status-local'}`;
    badge.style.color = isLocked ? '#ef4444' : '#10b981';
    badge.innerText = isLocked ? `ĐÃ KHÓA KỲ LƯƠNG (${payload.lockedBy || 'hệ thống'})` : 'KỲ LƯƠNG MỞ';
  }
  if (button) {
    button.disabled = !canManagePayroll();
    button.className = isLocked ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm';
    button.innerHTML = isLocked
      ? '<i data-lucide="unlock"></i> Mở khóa kỳ lương'
      : `<i data-lucide="lock"></i> Khóa kỳ lương ${payload.period}`;
  }
}

function renderRows(payload) {
  const tbody = document.getElementById('payroll-table-body');
  if (!tbody) return;
  const rows = payload.rows || [];
  renderStatus(payload);
  const totalElement = document.getElementById('stat-total-payroll-period');
  if (totalElement) totalElement.innerText = formatCurrency(rows.reduce((sum, row) => sum + Number(row.netSalary || 0), 0));
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--text-muted)">Không có nhân viên đang hoạt động trong kỳ lương.</td></tr>';
    safeCreateIcons();
    return;
  }
  tbody.innerHTML = rows.map(row => `
    <tr>
      <td style="font-weight:600">${escapeHtml(row.userCode)}</td>
      <td style="font-weight:600;color:var(--text-primary)">${escapeHtml(row.userName)}</td>
      <td>${escapeHtml(row.position)}</td>
      <td style="text-align:right">${formatCurrency(row.baseSalary)}</td>
      <td style="text-align:right;color:var(--color-primary)">${formatCurrency(row.commissionAmt)}</td>
      <td style="text-align:right;color:var(--color-success)">${formatCurrency(row.kpiBonus)}</td>
      <td style="text-align:right;color:var(--color-danger)">${formatCurrency(row.returnDeduction)}</td>
      <td style="text-align:right;color:var(--color-warning)">${formatCurrency(row.deductions)}</td>
      <td style="text-align:right;font-weight:700;color:var(--color-primary)">${formatCurrency(row.netSalary)}</td>
      <td style="text-align:center">${payload.isLocked
        ? '<span style="font-size:.8rem;color:var(--text-muted)">Đã khóa</span>'
        : `<button class="btn btn-secondary btn-xs payroll-edit-btn" data-user-id="${escapeHtml(row.userId)}"><i data-lucide="edit-3"></i> Sửa</button>`}
      </td>
    </tr>`).join('');
  tbody.querySelectorAll('.payroll-edit-btn').forEach(button => {
    button.addEventListener('click', () => editEmployeePayroll(button.dataset.userId, payload.period));
  });
  safeCreateIcons();
}

export async function renderPayrollTable() {
  const tbody = document.getElementById('payroll-table-body');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:2rem">Đang tính lương trên máy chủ...</td></tr>';
  try {
    currentPayroll = await dbFetchPayrollPeriod(getSelectedSalaryPeriod());
    renderRows(currentPayroll);
  } catch (error) {
    currentPayroll = null;
    console.error('Payroll RPC error:', error);
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:2rem;color:var(--color-danger)">Không tải được bảng lương. Kiểm tra migration 0012 và kết nối Cloud.</td></tr>';
    showToast('Không tải được bảng lương chính xác từ cơ sở dữ liệu.', 'danger');
  }
}

export async function toggleLockPayrollPeriod() {
  if (!canManagePayroll()) {
    showToast('Chỉ Admin hoặc Kế toán được quản lý kỳ lương.', 'danger');
    return;
  }
  const period = getSelectedSalaryPeriod();
  const lock = !currentPayroll?.isLocked;
  let reason = null;
  if (!lock) {
    if (state.currentUser?.role !== 'admin') {
      showToast('Chỉ Admin được mở khóa kỳ lương.', 'danger');
      return;
    }
    reason = prompt('Nhập lý do mở khóa kỳ lương:')?.trim();
    if (!reason) return;
  }
  if (!confirm(`${lock ? 'Khóa' : 'Mở khóa'} kỳ lương ${period}?`)) return;
  try {
    currentPayroll = await dbSetPayrollPeriodLock(period, lock, reason);
    renderRows(currentPayroll);
    showToast(`${lock ? 'Đã khóa' : 'Đã mở khóa'} kỳ lương ${period}.`, 'success');
  } catch (error) {
    console.error('Payroll lock error:', error);
    showToast(error?.message || 'Không thay đổi được trạng thái kỳ lương.', 'danger');
  }
}

async function editEmployeePayroll(userId, period) {
  if (!canManagePayroll() || currentPayroll?.isLocked) return;
  const row = currentPayroll?.rows?.find(item => String(item.userId) === String(userId));
  if (!row) return;
  const bonusInput = prompt(`Thưởng KPI cho ${row.userName}:`, String(row.kpiBonus || 0));
  if (bonusInput === null) return;
  const deductionInput = prompt(`Khấu trừ khác cho ${row.userName}:`, String(row.deductions || 0));
  if (deductionInput === null) return;
  const notes = prompt('Lý do điều chỉnh (bắt buộc):', '')?.trim();
  if (!notes) return showToast('Phải nhập lý do điều chỉnh để lưu audit log.', 'danger');
  const kpiBonus = Number(bonusInput);
  const deduction = Number(deductionInput);
  if (!Number.isFinite(kpiBonus) || kpiBonus < 0 || !Number.isFinite(deduction) || deduction < 0) {
    return showToast('Tiền thưởng và khấu trừ phải là số không âm.', 'danger');
  }
  try {
    await dbSavePayrollAdjustment({ period, employee_id: userId, adjustment_type: 'kpi_bonus', amount: kpiBonus, notes });
    await dbSavePayrollAdjustment({ period, employee_id: userId, adjustment_type: 'deduction', amount: deduction, notes });
    await renderPayrollTable();
    showToast('Đã lưu điều chỉnh lương và audit log.', 'success');
  } catch (error) {
    console.error('Payroll adjustment error:', error);
    showToast(error?.message || 'Không lưu được điều chỉnh lương.', 'danger');
  }
}

window.editEmployeePayroll = editEmployeePayroll;

export function setupPayrollPanel() {
  document.getElementById('payroll-period-select')?.addEventListener('change', renderPayrollTable);
  document.getElementById('btn-lock-payroll-period')?.addEventListener('click', toggleLockPayrollPeriod);
}
