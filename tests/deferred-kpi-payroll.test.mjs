import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('KPI and payroll UI are deferred without deleting database objects', () => {
  const html = read('index.html');
  const main = read('js/main.js');
  const reports = read('js/components/reports.js');
  const migration = read('migrations/0012_phase5_reporting_kpi_payroll.sql');

  assert.match(html, /data-target="payroll-panel"/);
  assert.match(html, /data-subtab="kpi"[^>]*data-feature-status="deferred"/);
  assert.match(html, /id="payroll-panel"[^>]*data-feature-status="deferred"/);
  assert.doesNotMatch(main, /setupPayrollPanel|renderPayrollTable|renderKpiReport/);
  assert.match(main, /panelId === 'payroll-panel'\) panelId = 'dashboard-panel'/);
  assert.match(reports, /if \(subtab === 'kpi'\) subtab = 'debt'/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.payroll_entries/);
});
