import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('migrations/0012_phase5_reporting_kpi_payroll.sql');
const payroll = read('js/components/payroll.js');
const dashboard = read('js/components/dashboard.js');
const reports = read('js/components/reports.js');
const service = read('js/services/supabase.js');
const integration = read('migrations/tests/phase5_reporting_payroll_integration.sql');

test('phase 5 has no inventory or production coupling', () => {
  const forbidden = /public\.(?:finished_goods_stock|raw_materials|semi_finished|recipes|production_logs|inventory)/i;
  assert.doesNotMatch(migration, forbidden);
  assert.doesNotMatch(payroll, /finishedGoodsStock|rawMaterials|productionLogs|inventory/i);
});

test('dashboard and reports use authenticated server RPCs', () => {
  assert.match(migration, /rpc_get_phase5_dashboard\(p_filters jsonb/);
  assert.match(migration, /rpc_get_phase5_report\(p_input jsonb/);
  assert.match(migration, /actor := public\.require_authenticated_profile\(\)/);
  assert.match(service, /rpc_get_phase5_dashboard/);
  assert.match(service, /rpc_get_phase5_report/);
  assert.match(dashboard, /await dbFetchPhase5Dashboard/);
  assert.match(reports, /await dbFetchPhase5Report/);
});

test('financial summaries exclude cancelled and draft records', () => {
  assert.match(migration, /sale\.status NOT IN \('cancelled', 'canceled', 'draft'\)/);
  assert.match(migration, /ret\.status NOT IN \('cancelled', 'canceled'\)/);
  assert.match(migration, /pay\.status = 'completed'/);
  assert.match(migration, /p\.status NOT IN \('cancelled', 'canceled'\)/);
});

test('sale report scope is derived from authenticated profile', () => {
  assert.match(migration, /actor\.role <> 'sale' OR sale\.salesperson_id IN \(actor\.id, actor\.username, actor\.auth_user_id::text\)/);
  assert.match(migration, /actor\.role <> 'sale' OR customer\.managed_by IN \(actor\.id, actor\.username, actor\.auth_user_id::text\)/);
  assert.doesNotMatch(service.slice(service.indexOf('dbFetchPhase5Dashboard'), service.indexOf('dbFetchCustomersPaginated')), /role\s*:/);
});

test('commission is rule based, snapshotted and reversible by existing ledgers', () => {
  assert.match(migration, /p5_apply_order_item_commission/);
  assert.match(migration, /rule_snapshot/);
  assert.match(migration, /candidate\.employee_id/);
  assert.match(migration, /candidate\.brand_id/);
  assert.match(migration, /candidate\.product_group_id/);
  assert.doesNotMatch(payroll, /0\.03|3%|commissionRate\s*\|\|/);
});

test('payroll is database owned and locked snapshots are immutable from browser', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.payroll_periods/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.payroll_entries/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.payroll_adjustments/);
  assert.match(migration, /DELETE FROM public\.payroll_entries WHERE period = p_period/);
  assert.match(migration, /status = 'locked'/);
  assert.doesNotMatch(payroll, /localStorage|sessionStorage|billing_system_salary_periods|billing_system_payroll_adj/);
  assert.match(payroll, /await dbFetchPayrollPeriod/);
});

test('unlock requires admin, reason and audit log', () => {
  assert.match(migration, /actor\.role <> 'admin'/);
  assert.match(migration, /Unlock reason is required/);
  assert.match(migration, /'payroll_periods', CASE WHEN p_lock THEN 'LOCK' ELSE 'UNLOCK' END/);
  assert.match(migration, /actor\.auth_user_id::text/);
});

test('anon and direct financial table mutations are denied', () => {
  assert.match(migration, /REVOKE ALL ON TABLE public\.kpi_targets[\s\S]*FROM anon/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.kpi_targets[\s\S]*public\.commission_transactions FROM authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_get_phase5_dashboard\(jsonb\) FROM PUBLIC, anon/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.rpc_get_payroll_period\(text\) TO authenticated/);
});

test('rollback guidance preserves financial history', () => {
  const rollback = read('migrations/ROLLBACK_0012.md');
  assert.match(rollback, /Do not drop Phase 5 tables/);
  assert.match(rollback, /Never delete existing commission or payroll rows/);
});

test('database integration covers commission, scoped dashboard, payroll and anon denial', () => {
  assert.match(integration, /order_creates_rule_snapshot_commission/);
  assert.match(integration, /sale_dashboard_is_server_scoped/);
  assert.match(integration, /payroll_lock_snapshots_server_calculation/);
  assert.match(integration, /non_admin_cannot_unlock/);
  assert.match(integration, /anon_cannot_call_phase5_rpc/);
  assert.match(integration, /ROLLBACK;/);
});
