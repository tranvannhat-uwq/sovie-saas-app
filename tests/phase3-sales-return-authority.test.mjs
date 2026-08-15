import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('migrations/0008_authoritative_sales_returns_and_reversals.sql');
const conflictFix = read('migrations/0014_sales_return_variable_conflict_fix.sql');
const deductionMigration = read('migrations/0055_sales_return_deduction_percent.sql');
const service = read('js/services/supabase.js');
const history = read('js/components/history.js');
const markup = read('index.html');

test('return RPC accepts business quantities and calculates canonical refund values', () => {
  assert.match(migration, /rpc_record_sales_return\(p_input jsonb\)/);
  assert.match(migration, /FROM public\.order_items[\s\S]*order_id = sale\.id FOR UPDATE/);
  assert.match(migration, /Returned quantity exceeds remaining sold quantity/);
  assert.match(migration, /line_refund := cumulative_amount - previous_cumulative_amount/);
  assert.match(migration, /new_order_returned > COALESCE\(sale\.total_payable, 0\)/);
  assert.doesNotMatch(migration, /p_total_refund/);
});

test('return deduction is per item, optional and calculated authoritatively', () => {
  assert.match(markup, /Khấu trừ %/);
  assert.match(history, /class="form-control return-deduction-percent-input"/);
  assert.match(history, /deductionPercent = parseFloat/);
  assert.match(history, /unitPrice \* qty \* \(1 - deductionPercent \/ 100\)/);
  assert.match(service, /deductionPercent: Number\(item\.deductionPercent \|\| 0\)/);
  assert.match(deductionMigration, /item_deduction_percent < 0 OR item_deduction_percent > 100/);
  assert.match(deductionMigration, /line_refund := round\(line_refund \* \(100 - item_deduction_percent\) \/ 100\)/);
  assert.match(deductionMigration, /return_deduction_percent.*item_deduction_percent/);
  assert.match(deductionMigration, /sum\(other_item\.subtotal\).*INTO remaining_amount/s);
  assert.match(deductionMigration, /active_item\.quantity > 0/);
  assert.match(deductionMigration, /VALUES \('0055'/);
});

test('return idempotency and database actors cannot be supplied by the browser', () => {
  assert.match(migration, /sales_returns_actor_idempotency_uidx/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /actor := public\.require_authenticated_profile\(\)/);
  assert.match(migration, /actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(migration, /actor\.auth_user_id::text/);
  assert.match(service, /idempotencyKey: ret\.idempotencyKey/);
  const rpcClient = service.slice(service.indexOf('export async function dbRecordSalesReturn'), service.indexOf('export async function dbCancelSalesReturn'));
  assert.doesNotMatch(rpcClient, /totalRefund|refundPrice|subtotal|createdBy|orderStatus/);
});

test('return separates debt reduction from cash refund without negative debt', () => {
  assert.match(migration, /debt_reduction := LEAST\(v_total_refund, GREATEST\(balance_before, 0\)\)/);
  assert.match(migration, /cash_refund := v_total_refund - debt_reduction/);
  assert.match(migration, /transaction_type[^\n]*sales_return_refund|\'sales_return_refund\'/);
  assert.match(migration, /debt_change[\s\S]*-debt_reduction/);
});

test('cancel return appends debt, cashbook, revenue and commission reversals', () => {
  assert.match(migration, /rpc_cancel_sales_return\([\s\S]*p_reason text/);
  assert.match(migration, /reversal_of_id/);
  assert.match(migration, /sales_return_refund_reversal/);
  assert.match(migration, /sales_return_reversal/);
  assert.match(migration, /sales_return_cancel_reversal/);
  assert.match(migration, /total_return = total_return - return_value/);
  assert.match(migration, /INSERT INTO public\.audit_logs/);
});

test('return flow has no inventory or production coupling', () => {
  const forbiddenSql = /public\.(?:finished_goods_stock|raw_materials|semi_finished|recipes|production_logs|inventory)/i;
  const forbiddenFrontend = /(?:finishedGoodsStock|billing_system_finished_goods_stock|rawMaterials|productionLogs)/i;
  assert.doesNotMatch(migration, forbiddenSql);
  const returnFlow = history.slice(history.indexOf('// --- PHÂN HỆ TRẢ HÀNG'), history.indexOf('// Attach to window for inline HTML handlers'));
  assert.doesNotMatch(returnFlow, forbiddenFrontend);
});

test('frontend exposes return actions only to finance roles and uses canonical response', () => {
  assert.match(history, /Chỉ Admin hoặc Kế toán được lập phiếu trả hàng/);
  assert.match(history, /returnResult\?\.return/);
  assert.match(history, /order\.status = returnResult\.order_status/);
  assert.match(history, /cancelResult\.order_status/);
  assert.match(history, /history-return-cancel-btn/);
  assert.match(history, /history-return-print-btn/);
  assert.match(history, /history-return-print-btn[^>]*aria-label="In phiếu trả[^>]*>[\s\S]*In phiếu/);
  assert.doesNotMatch(history, /history-return-print-btn[^>]*>[\s\S]{0,120}\$\{item\.id\}/);
  assert.match(read('style.css'), /\.order-actions \.history-return-print-btn[\s\S]*overflow: hidden/);
  assert.match(markup, /Database sẽ tính lại từ snapshot giá của đơn gốc/);
  assert.doesNotMatch(markup, /class="form-control return-disc-type"/);
});

test('direct writes and legacy return RPCs are closed', () => {
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.sales_returns, public\.sales_return_items FROM authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_record_sales_return\(text, text, numeric, text, jsonb\) FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_cancel_sales_return\(text\) FROM PUBLIC, anon, authenticated/);
  const directSave = service.slice(service.indexOf('export async function dbSaveSalesReturn'), service.indexOf('export function backfillMultiCompanyAndRevenueData'));
  assert.doesNotMatch(directSave, /\.from\(tableSalesReturnsName\)|\.upsert/);
});

test('staging integration suite covers calculation, retries, roles and reversals', () => {
  const sql = read('migrations/tests/phase3_sales_returns_integration.sql');
  assert.match(sql, /backend_calculates_refund_and_splits_debt_from_cash/);
  assert.match(sql, /same_return_request_is_idempotent/);
  assert.match(sql, /quantity_already_returned_is_rejected/);
  assert.match(sql, /cancel_return_reverses_debt_cash_revenue_items_and_commission/);
  assert.match(sql, /sale_cannot_record_return/);
  assert.match(sql, /ROLLBACK;/);
});

test('follow-up migration removes ambiguous sales return identifiers without changing formulas', () => {
  assert.match(conflictFix, /pg_get_functiondef\('public\.rpc_record_sales_return\(jsonb\)'::regprocedure\)/);
  assert.match(conflictFix, /target_order_id text :=/);
  assert.match(conflictFix, /sale_source\.id = target_order_id/);
  assert.match(conflictFix, /public\.order_items\.id = item_id AND public\.order_items\.order_id = sale\.id/);
  assert.match(conflictFix, /SECURITY DEFINER/);
  assert.match(conflictFix, /SET search_path = pg_catalog, public/);
  assert.match(conflictFix, /REVOKE ALL ON FUNCTION public\.rpc_record_sales_return\(jsonb\) FROM PUBLIC, anon/);
  assert.doesNotMatch(conflictFix, /line_refund\s*:=|debt_reduction\s*:=|cash_refund\s*:=/);
});
