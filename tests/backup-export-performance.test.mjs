import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backup = fs.readFileSync(path.join(root, 'js/services/backup.js'), 'utf8');

test('backup export uses bounded concurrency and preserves manifest sheet order', () => {
  assert.match(backup, /const BACKUP_FETCH_CONCURRENCY = 3/);
  assert.match(backup, /mapWithConcurrency\([\s\S]*limit: BACKUP_FETCH_CONCURRENCY/);
  assert.match(backup, /PHASE6_BACKUP_TABLES\.forEach\(\(spec, index\)/);
  assert.match(backup, /\.order\(cursorColumn, \{ ascending: true \}\)/);
  assert.match(backup, /\.gt\(cursorColumn, cursorValue\)/);
  assert.doesNotMatch(backup, /\.range\(from, from \+ pageSize - 1\)/);
  assert.doesNotMatch(backup, /Nhat_Ky_Audit|table:\s*['"]audit_logs['"]/);
});

test('backup export prevents duplicate runs and exposes visible progress', () => {
  assert.match(backup, /if \(activeBackupExport\) return activeBackupExport/);
  assert.match(backup, /Đang sao lưu \$\{completed\}\/\$\{total\}/);
  assert.match(backup, /button\.disabled = true/);
  assert.match(backup, /await nextBrowserPaint\(\)[\s\S]*XLSX\.writeFile/);
  assert.match(backup, /spec\.sheet[\s\S]*rowCount\.toLocaleString\('vi-VN'\)/);
  assert.match(backup, /controller\.abort\(\), 30000/);
});
