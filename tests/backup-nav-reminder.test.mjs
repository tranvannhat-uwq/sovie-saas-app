import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('end-of-day backup reminder and shortcut are removed from the application shell', () => {
  const html = read('index.html');
  const main = read('js/main.js');
  const users = read('js/components/users.js');
  assert.doesNotMatch(html, /backup-reminder-banner|btn-backup-reminder-download|Chưa sao lưu dữ liệu cuối ngày/);
  assert.doesNotMatch(main, /checkAndShowBackupReminder/);
  assert.doesNotMatch(users, /sao lưu Excel cuối ngày|exportBackupToExcel/);
});

test('backup remains available only from the Cloud configuration section', () => {
  const html = read('index.html');
  const backup = read('js/services/backup.js');
  const css = read('style.css');
  const backupSection = html.slice(html.indexOf('id="backup-section"'), html.indexOf('<!-- Báo cáo & KPI Panel -->'));
  assert.match(backupSection, /id="btn-export-backup"/);
  assert.match(backupSection, /Sao lưu & Khôi phục dữ liệu/);
  assert.doesNotMatch(backup, /checkAndShowBackupReminder|btn-backup-reminder|weblendon_banner_ignored_date/);
  assert.doesNotMatch(css, /backup-nav-alert|backupAlertPulse/);
});
