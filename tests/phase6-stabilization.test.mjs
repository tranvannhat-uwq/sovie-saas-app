import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const service = read('js/services/supabase.js');
const backup = read('js/services/backup.js');
const html = read('index.html');
const restoreScript = read('scripts/restore-phase6-staging.ps1');

test('browser synchronization only refreshes from authoritative Cloud', () => {
  const safeSync = service.slice(
    service.indexOf('export async function syncLocalToCloud'),
    service.indexOf('async function legacyLocalUploadDisabled')
  );
  assert.match(safeSync, /await fetchCloudData\(\{ leanBootstrap: true, hydrateCustomerHistory: false \}\)/);
  assert.doesNotMatch(safeSync, /localStorage|\.getItem\(|\.upsert\(|\.insert\(|\.update\(|\.delete\(/);
});

test('Phase 6 export is versioned, paginated and excludes inventory/production', () => {
  const safeBackup = backup.slice(
    backup.indexOf("const PHASE6_BACKUP_VERSION"),
    backup.indexOf('async function legacyExportBackupToExcelDisabled')
  );
  assert.match(safeBackup, /phase6-v1/);
  assert.match(safeBackup, /\.order\(cursorColumn, \{ ascending: true \}\)/);
  assert.match(safeBackup, /\.gt\(cursorColumn, cursorValue\)/);
  assert.match(safeBackup, /\.limit\(pageSize\)/);
  assert.match(safeBackup, /customer_debt_transactions/);
  assert.match(safeBackup, /supplier_debt_transactions/);
  assert.doesNotMatch(safeBackup, /audit_logs|Nhat_Ky_Audit/);
  assert.doesNotMatch(safeBackup, /finished_goods_stock|raw_materials|production_logs|recipes/);
});

test('Excel restore UI is dry-run only and has no overwrite mode', () => {
  const dryRun = backup.slice(
    backup.indexOf('export async function importBackupFromExcel'),
    backup.indexOf('async function legacyExportBackupToExcelDisabled')
  );
  assert.match(dryRun, /Không có dữ liệu Cloud nào bị thay đổi/);
  assert.doesNotMatch(dryRun, /\.from\(|\.upsert\(|\.delete\(/);
  const backupUi = html.slice(html.indexOf('id="backup-section"'), html.indexOf('<!-- Báo cáo & KPI Panel -->'));
  assert.doesNotMatch(backupUi, /value="overwrite"|Xóa sạch DB trước khi nạp/);
  assert.match(backupUi, /Kiểm tra file \(Dry-run\)/);
});

test('bulk deletion of operational history is disabled', () => {
  const safeClear = backup.slice(
    backup.indexOf('export async function clearTestData'),
    backup.indexOf('async function legacyClearTestDataDisabled')
  );
  assert.match(safeClear, /đã bị tắt/);
  assert.doesNotMatch(safeClear, /\.delete\(|deleteAllRows/);
  assert.match(html, /id="clear-sample-data-section"[^>]*data-feature-status="disabled-for-data-safety"/);
});

test('full restore refuses non-empty targets and requires explicit staging confirmation', () => {
  assert.match(restoreScript, /PHASE6_RESTORE_CONFIRM/);
  assert.match(restoreScript, /RESTORE_NEW_STAGING/);
  assert.match(restoreScript, /Target public schema is not empty/);
  assert.match(restoreScript, /Get-FileHash -Algorithm SHA256/);
  assert.match(restoreScript, /pg_restore --exit-on-error/);
});

test('financial cancellation refresh is scoped to the affected customer', () => {
  assert.match(service, /export async function dbRefreshCustomerFinancialState\(customerId, \{ includeHistory = true \} = \{\}\)/);
  assert.match(service, /\.eq\('customer_id', customerId\)/);
  assert.match(service, /fetchCustomerDebtRows\(customerId\)/);
  assert.match(service, /\.range\(from, from \+ pageSize - 1\)/);
});

test('standalone UI harnesses do not bootstrap the full authenticated app', () => {
  for (const file of ['ui-harness.html', 'invoice-variant-harness.html', 'history-financials-harness.html', 'purchases-ui-harness.html']) {
    assert.match(read(`tests/${file}`), /window\.__app_initialized\s*=\s*true/);
  }
});
