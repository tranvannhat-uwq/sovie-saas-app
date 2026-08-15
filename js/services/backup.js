import { state } from '../state.js';
import { showToast } from '../utils.js';
import { deserializeBackupRows, serializeBackupRows } from './backup-serialization.js?v=20260814-invoice-discount-label-v19';
import { mapWithConcurrency } from '../domain/async-pool.js?v=20260814-invoice-discount-label-v19';
import { 
  supabaseClient, 
  isCloudActive,
  tableProductsName,
  tableCustomersName,
  tableOrdersName,
  tableDraftOrdersName,
  tablePricelistsName,
  tableCashbookTransactionsName,
  tableStartingBalancesName,
  tableProductionLogsName,
  tableFinishedGoodsStockName,
  tableSalesReturnsName,
  tableSalesReturnItemsName,
  tableOrderItemsName,
  tableCustomerDebtTransactionsName,
  tableCommissionTransactionsName,
  tableUsersName,
  tableBrandsName,
  fetchCloudData
} from './supabase.js?v=20260814-invoice-discount-label-v19';

async function deleteAllRows(tableName, key = 'id') {
  const { error } = await supabaseClient
    .from(tableName)
    .delete()
    .not(key, 'is', null);
  if (error) throw error;
}

async function restoreCustomerBaselines() {
  const [
    { data: customers, error: customerError },
    { data: orders, error: orderError },
    { data: returns, error: returnError },
    { data: debtTransactions, error: debtError }
  ] = await Promise.all([
    supabaseClient.from(tableCustomersName).select('id,total_transaction,total_return,net_revenue,debt'),
    supabaseClient.from(tableOrdersName).select('customer_id,total_payable,total_amount'),
    supabaseClient.from(tableSalesReturnsName).select('customer_id,total_refund,created_at'),
    supabaseClient
      .from(tableCustomerDebtTransactionsName)
      .select('customer_id,balance_before,transaction_date,created_at')
      .order('transaction_date', { ascending: true })
      .order('created_at', { ascending: true })
  ]);

  const loadError = customerError || orderError || returnError || debtError;
  if (loadError) throw loadError;

  const orderTotals = new Map();
  (orders || []).forEach(order => {
    if (!order.customer_id) return;
    const amount = Number(order.total_payable ?? order.total_amount ?? 0) || 0;
    orderTotals.set(order.customer_id, (orderTotals.get(order.customer_id) || 0) + amount);
  });

  const returnTotals = new Map();
  (returns || []).forEach(item => {
    if (!item.customer_id) return;
    const amount = Number(item.total_refund || 0) || 0;
    returnTotals.set(item.customer_id, (returnTotals.get(item.customer_id) || 0) + amount);
  });

  const initialDebt = new Map();
  (debtTransactions || []).forEach(transaction => {
    if (transaction.customer_id && !initialDebt.has(transaction.customer_id)) {
      initialDebt.set(transaction.customer_id, Number(transaction.balance_before || 0) || 0);
    }
  });

  const affectedCustomerIds = new Set([
    ...orderTotals.keys(),
    ...returnTotals.keys(),
    ...initialDebt.keys()
  ]);

  for (const customer of customers || []) {
    if (!affectedCustomerIds.has(customer.id)) continue;
    const orderTotal = orderTotals.get(customer.id) || 0;
    const returnTotal = returnTotals.get(customer.id) || 0;
    const changes = {
      total_transaction: Math.max(0, (Number(customer.total_transaction || 0) || 0) - orderTotal),
      total_return: Math.max(0, (Number(customer.total_return || 0) || 0) - returnTotal),
      net_revenue: Math.max(0, (Number(customer.net_revenue || 0) || 0) - orderTotal + returnTotal),
      debt: initialDebt.has(customer.id) ? initialDebt.get(customer.id) : (Number(customer.debt || 0) || 0)
    };
    const { error } = await supabaseClient
      .from(tableCustomersName)
      .update(changes)
      .eq('id', customer.id);
    if (error) throw error;
  }
}

export async function clearTestData() {
  showToast('Chức năng xóa hàng loạt đã bị tắt để bảo toàn lịch sử nghiệp vụ. Hãy dùng giao dịch hủy/đảo theo từng chứng từ.', 'warning');
  return false;
}

async function legacyClearTestDataDisabled(onCompleteCallback) {
  const confirmed = confirm(
    'XÓA DỮ LIỆU THỬ NGHIỆM?\n\n' +
    'Sẽ xóa: đơn bán, đơn nháp, trả hàng, phiếu nhập hàng, Sổ quỹ, số dư đầu kỳ, tồn kho phát sinh, nhật ký sản xuất, hoa hồng và lịch sử công nợ phát sinh.\n\n' +
    'Sẽ giữ nguyên: sản phẩm, bảng giá, khách hàng, tài khoản, nhà cung cấp, nhãn sơn và danh mục nguyên vật liệu.\n\n' +
    'Thao tác này không thể hoàn tác nếu chưa có file sao lưu.'
  );
  if (!confirmed) {
    return;
  }

  const clearButton = document.getElementById('btn-clear-sample-data');
  if (clearButton) clearButton.disabled = true;
  showToast('Đang xóa dữ liệu thử nghiệm...', 'info');

  // Clear local operational data while preserving all master-data collections.
  state.savedOrders = [];
  state.productionLogs = [];
  state.finishedGoodsStock = [];
  state.salesReturns = [];

  localStorage.setItem('billing_system_orders', JSON.stringify([]));
  localStorage.setItem('billing_system_sales_returns', JSON.stringify([]));
  localStorage.setItem('billing_system_cashbook_transactions', JSON.stringify([]));
  localStorage.setItem('billing_system_cashbook_start_balances', JSON.stringify({ cash: 0, bank: 0, wallet: 0 }));
  localStorage.setItem('billing_system_production_logs', JSON.stringify([]));
  localStorage.setItem('billing_system_finished_goods_stock', JSON.stringify([]));
  [
    'billing_system_goods_receipts',
    'billing_system_purchase_orders',
    'billing_system_purchases',
    'billing_system_purchase_receipts',
    'billing_system_supplier_returns',
    'billing_system_purchase_returns',
    'billing_system_goods_return_to_suppliers'
  ].forEach(key => localStorage.setItem(key, JSON.stringify([])));

  try {
    if (isCloudActive && supabaseClient) {
      await restoreCustomerBaselines();
      await deleteAllRows(tableCommissionTransactionsName);
      await deleteAllRows(tableCustomerDebtTransactionsName);
      await deleteAllRows(tableSalesReturnItemsName);
      await deleteAllRows(tableSalesReturnsName);
      await deleteAllRows(tableOrderItemsName);
      await deleteAllRows(tableDraftOrdersName);
      await deleteAllRows(tableOrdersName);
      await deleteAllRows(tableCashbookTransactionsName);
      await deleteAllRows(tableStartingBalancesName);
      await deleteAllRows(tableProductionLogsName);
      await deleteAllRows(tableFinishedGoodsStockName, 'product_code');
      await fetchCloudData();
    }

    showToast('Đã xóa dữ liệu thử nghiệm; các danh mục chính được giữ nguyên.', 'success');
    if (typeof onCompleteCallback === 'function') onCompleteCallback();
  } catch (err) {
    console.error('Không thể xóa hết dữ liệu thử nghiệm:', err);
    showToast('Không thể xóa hết dữ liệu thử nghiệm: ' + (err.message || err), 'danger');
  } finally {
    if (clearButton) clearButton.disabled = false;
  }
}

export const clearAllSampleData = clearTestData;

const PHASE6_BACKUP_VERSION = 'phase6-v1';
const BACKUP_FETCH_CONCURRENCY = 3;
let activeBackupExport = null;
const PHASE6_BACKUP_TABLES = [
  { sheet: 'San_Pham', table: 'products' },
  { sheet: 'Khach_Hang', table: 'customers' },
  { sheet: 'Don_Hang', table: 'orders' },
  { sheet: 'Chi_Tiet_Don', table: 'order_items' },
  { sheet: 'Don_Hang_Nhap', table: 'draft_orders' },
  { sheet: 'Bang_Gia', table: 'pricelists' },
  { sheet: 'Chi_Tiet_Bang_Gia', table: 'price_list_items' },
  { sheet: 'Hang_Son', table: 'brands', cursor: 'name' },
  { sheet: 'Thanh_Toan', table: 'payments' },
  { sheet: 'So_Quy', table: 'cashbook_transactions' },
  { sheet: 'So_Du_Dau_Ky', table: 'starting_balances' },
  { sheet: 'Cong_No_Khach', table: 'customer_debt_transactions' },
  { sheet: 'Tra_Hang', table: 'sales_returns' },
  { sheet: 'Chi_Tiet_Tra_Hang', table: 'sales_return_items' },
  { sheet: 'Nha_Cung_Cap', table: 'suppliers' },
  { sheet: 'Phieu_Mua', table: 'purchases' },
  { sheet: 'Chi_Tiet_Phieu_Mua', table: 'purchase_items' },
  { sheet: 'Thanh_Toan_NCC', table: 'purchase_payments' },
  { sheet: 'Cong_No_NCC', table: 'supplier_debt_transactions' },
  { sheet: 'Ho_So_Nhan_Vien', table: 'profiles' }
];

async function fetchBackupTableRows(spec, onPage) {
  const rows = [];
  const pageSize = 1000;
  const cursorColumn = spec.cursor || 'id';
  let cursorValue = null;
  for (;;) {
    let query = supabaseClient
      .from(spec.table)
      .select('*')
      .order(cursorColumn, { ascending: true })
      .limit(pageSize);
    if (cursorValue !== null) query = query.gt(cursorColumn, cursorValue);

    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    if (controller && typeof query.abortSignal === 'function') query = query.abortSignal(controller.signal);
    const timeoutId = controller ? setTimeout(() => controller.abort(), 30000) : null;
    let data;
    let error;
    try {
      ({ data, error } = await query);
    } catch (requestError) {
      data = null;
      error = requestError;
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
    if (error) {
      const timedOut = error.name === 'AbortError' || /abort|timeout/i.test(error.message || '');
      throw new Error(`${spec.table}: ${timedOut ? 'quá 30 giây khi tải một trang dữ liệu' : (error.message || error)}`);
    }
    rows.push(...(data || []));
    if (typeof onPage === 'function') onPage(rows.length);
    if (!data || data.length < pageSize) break;
    const nextCursor = data[data.length - 1]?.[cursorColumn];
    if (nextCursor == null || String(nextCursor) === String(cursorValue)) {
      throw new Error(`${spec.table}: không thể tiếp tục phân trang theo ${cursorColumn}`);
    }
    cursorValue = nextCursor;
  }
  return rows;
}

function updateBackupExportButtons(message = '', busy = false) {
  if (typeof document === 'undefined') return;
  const buttons = [document.getElementById('btn-export-backup')].filter(Boolean);

  buttons.forEach(button => {
    if (busy) {
      if (!button.dataset.backupOriginalHtml) button.dataset.backupOriginalHtml = button.innerHTML;
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
      button.textContent = message;
      return;
    }
    button.disabled = false;
    button.removeAttribute('aria-busy');
    if (button.dataset.backupOriginalHtml) {
      button.innerHTML = button.dataset.backupOriginalHtml;
      delete button.dataset.backupOriginalHtml;
    }
  });
}

function nextBrowserPaint() {
  return new Promise(resolve => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

async function performBackupExport() {
  if (!isCloudActive || !supabaseClient) {
    showToast('Không thể xuất dữ liệu vì chưa kết nối Supabase.', 'warning');
    return false;
  }
  if (state.currentUser?.role !== 'admin') {
    showToast('Chỉ Admin được xuất bản sao dữ liệu toàn hệ thống.', 'danger');
    return false;
  }

  try {
    showToast('Đang đọc dữ liệu Cloud theo từng trang...', 'info');
    updateBackupExportButtons(`Đang sao lưu 0/${PHASE6_BACKUP_TABLES.length}...`, true);
    const workbook = XLSX.utils.book_new();
    const manifest = [];
    let completedTables = 0;
    const tableRows = await mapWithConcurrency(
      PHASE6_BACKUP_TABLES,
      spec => fetchBackupTableRows(spec, rowCount => {
        updateBackupExportButtons(
          `Đang sao lưu ${completedTables}/${PHASE6_BACKUP_TABLES.length}: ${spec.sheet} (${rowCount.toLocaleString('vi-VN')} dòng)...`,
          true
        );
      }),
      {
        limit: BACKUP_FETCH_CONCURRENCY,
        onProgress: ({ completed, total }) => {
          completedTables = completed;
          updateBackupExportButtons(`Đang sao lưu ${completed}/${total}...`, true);
        }
      }
    );

    PHASE6_BACKUP_TABLES.forEach((spec, index) => {
      const rows = tableRows[index];
      manifest.push({ sheet: spec.sheet, table_name: spec.table, row_count: rows.length });
      const worksheet = rows.length > 0
        ? XLSX.utils.json_to_sheet(serializeBackupRows(rows))
        : XLSX.utils.aoa_to_sheet([['__empty_table__']]);
      XLSX.utils.book_append_sheet(workbook, worksheet, spec.sheet);
    });

    const metadata = [{
      schema_version: PHASE6_BACKUP_VERSION,
      created_at: new Date().toISOString(),
      created_by_profile: state.currentUser.id || '',
      source: 'supabase-authoritative-read',
      scope: 'sales-debt-cashbook-returns-purchases',
      restore_policy: 'new-staging-only'
    }];
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(metadata), '_Metadata');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(manifest), '_Manifest');

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    updateBackupExportButtons('Đang tạo file Excel...', true);
    await nextBrowserPaint();
    XLSX.writeFile(workbook, `weblendon_phase6_${timestamp}.xlsx`);
    localStorage.setItem('weblendon_last_backup_date', new Date().toLocaleDateString('vi-VN'));
    showToast('Đã xuất bản dữ liệu có version và manifest thành công.', 'success');
    return true;
  } catch (error) {
    console.error('Phase 6 backup export failed:', error);
    showToast(`Không thể xuất bản dữ liệu: ${error.message || error}`, 'danger');
    return false;
  } finally {
    updateBackupExportButtons('', false);
  }
}

export function exportBackupToExcel() {
  if (activeBackupExport) return activeBackupExport;
  activeBackupExport = performBackupExport().finally(() => {
    activeBackupExport = null;
  });
  return activeBackupExport;
}

function findDuplicateBackupKeys(rows) {
  const seen = new Set();
  let duplicates = 0;
  (rows || []).forEach(row => {
    const key = row.id ?? row.code ?? row.name;
    if (key == null || key === '') return;
    const normalized = String(key).trim().toLowerCase();
    if (seen.has(normalized)) duplicates += 1;
    else seen.add(normalized);
  });
  return duplicates;
}

export async function importBackupFromExcel(file) {
  if (!isCloudActive || !supabaseClient) {
    showToast('Không thể kiểm tra file vì chưa kết nối Supabase.', 'warning');
    return false;
  }
  if (state.currentUser?.role !== 'admin') {
    showToast('Chỉ Admin được kiểm tra và chuẩn bị khôi phục dữ liệu.', 'danger');
    return false;
  }
  if (!file || file.size > 50 * 1024 * 1024) {
    showToast('File sao lưu không hợp lệ hoặc vượt quá 50 MB.', 'danger');
    return false;
  }

  try {
    const workbook = XLSX.read(new Uint8Array(await file.arrayBuffer()), { type: 'array' });
    const metadataSheet = workbook.Sheets._Metadata;
    const metadata = metadataSheet ? XLSX.utils.sheet_to_json(metadataSheet)[0] : null;
    if (!metadata || metadata.schema_version !== PHASE6_BACKUP_VERSION) {
      throw new Error(`Sai hoặc thiếu version ${PHASE6_BACKUP_VERSION}`);
    }

    const summary = [];
    let missingSheets = 0;
    let totalRows = 0;
    let totalDuplicates = 0;
    for (const spec of PHASE6_BACKUP_TABLES) {
      const worksheet = workbook.Sheets[spec.sheet];
      if (!worksheet) {
        missingSheets += 1;
        summary.push(`${spec.sheet}: thiếu sheet`);
        continue;
      }
      const rows = deserializeBackupRows(
        XLSX.utils.sheet_to_json(worksheet).filter(row => !row.__empty_table__)
      );
      const duplicates = findDuplicateBackupKeys(rows);
      totalRows += rows.length;
      totalDuplicates += duplicates;
      summary.push(`${spec.sheet}: ${rows.length} dòng, ${duplicates} trùng khóa`);
    }

    alert(
      `DRY-RUN GIAI ĐOẠN 6\n\nVersion: ${metadata.schema_version}\n` +
      `Tổng dòng: ${totalRows}\nSheet thiếu: ${missingSheets}\nKhóa trùng: ${totalDuplicates}\n\n` +
      `${summary.join('\n')}\n\nKhông có dữ liệu Cloud nào bị thay đổi. ` +
      'Khôi phục đầy đủ phải thực hiện vào một database staging mới bằng scripts/restore-phase6-staging.ps1.'
    );
    showToast('Dry-run hoàn tất. Không có dữ liệu Cloud nào bị thay đổi.', missingSheets ? 'warning' : 'success');
    return { totalRows, missingSheets, totalDuplicates, summary };
  } catch (error) {
    console.error('Backup dry-run failed:', error);
    showToast(`File sao lưu không đạt kiểm tra: ${error.message || error}`, 'danger');
    return false;
  }
}

// Xuất file sao lưu Excel (nhiều trang chứa dữ liệu các bảng)
async function legacyExportBackupToExcelDisabled() {
  if (!isCloudActive || !supabaseClient) {
    showToast('Vui lòng kết nối với Supabase trước!', 'warning');
    return;
  }
  
  try {
    showToast('Đang khởi tạo file sao lưu dữ liệu...', 'info');
    
    const [
      { data: products },
      { data: customers },
      { data: orders },
      { data: drafts },
      { data: pricelists },
      { data: users },
      { data: brands }
    ] = await Promise.all([
      supabaseClient.from(tableProductsName).select('*'),
      supabaseClient.from(tableCustomersName).select('*'),
      supabaseClient.from(tableOrdersName).select('*'),
      supabaseClient.from(tableDraftOrdersName).select('*'),
      supabaseClient.from(tablePricelistsName).select('*'),
      supabaseClient.from(tableUsersName).select('*'),
      supabaseClient.from(tableBrandsName).select('*')
    ]);

    const wb = XLSX.utils.book_new();

    const sheets = [
      { name: "San_Pham", data: products || [] },
      { name: "Khach_Hang", data: customers || [] },
      { name: "Don_Hang", data: orders || [] },
      { name: "Don_Hang_Nhap", data: drafts || [] },
      { name: "Bang_Gia", data: pricelists || [] },
      { name: "Nguoi_Dung", data: users || [] },
      { name: "Hang_Son", data: brands || [] }
    ];

    sheets.forEach(sheet => {
      // Chuyển các trường object (như JSONB) thành string để lưu trong Excel
      const processedData = sheet.data.map(row => {
        const newRow = { ...row };
        Object.keys(newRow).forEach(key => {
          if (typeof newRow[key] === 'object' && newRow[key] !== null) {
            newRow[key] = JSON.stringify(newRow[key]);
          }
        });
        return newRow;
      });
      const ws = XLSX.utils.json_to_sheet(processedData);
      XLSX.utils.book_append_sheet(wb, ws, sheet.name);
    });

    const timestamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `weblendon_backup_${timestamp}.xlsx`);
    showToast('Đã xuất và tải xuống file sao lưu Excel thành công!', 'success');
  } catch (err) {
    console.error('Backup export failed:', err);
    showToast('Lỗi khi xuất file sao lưu: ' + err.message, 'danger');
  }
}

// Khôi phục dữ liệu từ file sao lưu Excel tải lên
async function legacyImportBackupFromExcelDisabled(file, onCompleteCallback) {
  if (!isCloudActive || !supabaseClient) {
    showToast('Vui lòng kết nối với Supabase trước!', 'warning');
    return;
  }
  
  const restoreMode = document.querySelector('input[name="backup-restore-mode"]:checked').value;
  const confirmMsg = restoreMode === 'overwrite'
    ? 'CẢNH BÁO: Chế độ "Ghi đè" sẽ XÓA SẠCH dữ liệu hiện tại trên Cloud trước khi nạp. Bạn có chắc chắn muốn tiếp tục?'
    : 'Bạn có chắc chắn muốn khôi phục dữ liệu từ file sao lưu này? (Chế độ Gộp thêm)';
    
  if (!confirm(confirmMsg)) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      showToast('Đang phân tích file sao lưu...', 'info');
      const data = new Uint8Array(e.target.result);
      const workbook = XLSX.read(data, { type: 'array' });
      
      const tablesMap = {
        "San_Pham": tableProductsName,
        "Khach_Hang": tableCustomersName,
        "Don_Hang": tableOrdersName,
        "Don_Hang_Nhap": tableDraftOrdersName,
        "Bang_Gia": tablePricelistsName,
        "Nguoi_Dung": tableUsersName,
        "Hang_Son": tableBrandsName
      };

      const parseRow = (row) => {
        const parsed = { ...row };
        Object.keys(parsed).forEach(key => {
          const val = parsed[key];
          if (typeof val === 'string' && (val.startsWith('{') || val.startsWith('['))) {
            try {
              parsed[key] = JSON.parse(val);
            } catch (e) {
              // giữ nguyên dạng chuỗi nếu parse lỗi
            }
          }
        });
        return parsed;
      };

      for (const sheetName of workbook.SheetNames) {
        const tableName = tablesMap[sheetName];
        if (!tableName) continue;
        
        const worksheet = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json(worksheet);
        const rows = rawRows.map(parseRow);

        if (restoreMode === 'overwrite') {
          showToast(`Đang dọn sạch bảng ${sheetName}...`, 'info');
          if (sheetName === "San_Pham") {
            const { error: delErr } = await supabaseClient.from(tableName).delete().neq('code', 'temp_none');
            if (delErr) throw delErr;
          } else if (sheetName === "Hang_Son") {
            const { error: delErr } = await supabaseClient.from(tableName).delete().neq('name', 'temp_none');
            if (delErr) throw delErr;
          } else {
            const { error: delErr } = await supabaseClient.from(tableName).delete().neq('id', 'temp_none');
            if (delErr) throw delErr;
          }
        }

        if (rows.length > 0) {
          showToast(`Đang khôi phục ${rows.length} dòng cho bảng ${sheetName}...`, 'info');
          
          // Gửi dữ liệu theo các lô nhỏ để tránh lỗi vượt quá dung lượng
          const chunkSize = 100;
          for (let i = 0; i < rows.length; i += chunkSize) {
            const chunk = rows.slice(i, i + chunkSize);
            const { error: upsertErr } = await supabaseClient
              .from(tableName)
              .upsert(chunk);
              
            if (upsertErr) throw upsertErr;
          }
        }
      }

      showToast('Khôi phục dữ liệu từ file sao lưu thành công!', 'success');
      
      // Reset giao diện file input
      document.getElementById('backup-file-input').value = '';
      document.getElementById('backup-file-name').innerText = 'Chưa chọn file';
      document.getElementById('btn-restore-backup').style.display = 'none';

      // Đồng bộ lại dữ liệu lên State
      await fetchCloudData();
      
      if (typeof onCompleteCallback === 'function') {
        onCompleteCallback();
      }
    } catch (err) {
      console.error('Restore failed:', err);
      showToast('Lỗi khi khôi phục dữ liệu: ' + err.message, 'danger');
    }
  };
  reader.readAsArrayBuffer(file);
}

// Đăng ký sự kiện nút Sao lưu & Khôi phục dữ liệu
export function setupBackupRestoreListeners(onRestoreComplete) {
  const exportBtn = document.getElementById('btn-export-backup');
  const browseBtn = document.getElementById('btn-browse-backup');
  const fileInput = document.getElementById('backup-file-input');
  const fileNameSpan = document.getElementById('backup-file-name');
  const restoreBtn = document.getElementById('btn-restore-backup');

  if (exportBtn) {
    exportBtn.addEventListener('click', () => exportBackupToExcel());
  }

  if (browseBtn && fileInput) {
    browseBtn.addEventListener('click', () => {
      fileInput.click();
    });
  }

  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (fileInput.files.length > 0) {
        const file = fileInput.files[0];
        fileNameSpan.innerText = file.name;
        restoreBtn.style.display = 'inline-flex';
      } else {
        fileNameSpan.innerText = 'Chưa chọn file';
        restoreBtn.style.display = 'none';
      }
    });
  }

  if (restoreBtn && fileInput) {
    restoreBtn.addEventListener('click', () => {
      if (fileInput.files.length > 0) {
        importBackupFromExcel(fileInput.files[0], onRestoreComplete);
      }
    });
  }

  const clearSampleBtn = document.getElementById('btn-clear-sample-data');
  if (clearSampleBtn) {
    clearSampleBtn.addEventListener('click', () => {
      clearTestData(onRestoreComplete);
    });
  }

}
