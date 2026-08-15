import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('migrations/0006_authoritative_order_pricing_and_idempotency.sql');
const conflictFix = read('migrations/0011_confirm_order_variable_conflict_fix.sql');
const invoice = read('js/components/invoice.js');
const service = read('js/services/supabase.js');

test('finalization requires an idempotency UUID and serializes duplicate requests', () => {
  assert.match(migration, /idempotencyKey UUID is required/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /orders_actor_idempotency_uidx/);
  assert.match(migration, /idempotency key was already used with a different payload/);
  assert.match(invoice, /crypto\?\.randomUUID|crypto\.randomUUID/);
  assert.match(invoice, /billing_pending_order_idempotency_key/);
  assert.match(invoice, /billing_pending_order_id/);
  assert.match(invoice, /function getPendingOrderIdentity\(\)/);
  assert.match(invoice, /return \{ key, orderId \}/);
  assert.match(invoice, /const orderId = editOrderId \|\| pendingOrderIdentity\.orderId/);
  assert.match(invoice, /idempotencyKey: pendingOrderIdentity\.key/);
  assert.match(invoice, /sessionStorage\.removeItem\(ORDER_PENDING_ID_STORAGE_KEY\)/);
});

test('order confirmation resolves database columns and local variables deterministically', () => {
  assert.match(conflictFix, /#variable_conflict use_variable/);
  assert.match(conflictFix, /pg_get_functiondef\('public\.rpc_confirm_order\(jsonb\)'::regprocedure\)/);
  assert.match(conflictFix, /SECURITY DEFINER/);
  assert.match(conflictFix, /SET search_path = pg_catalog, public/);
});

test('database ignores browser prices and calculates canonical monetary fields', () => {
  assert.match(migration, /p1_resolve_sku_price\(selected_list_id, product_row\.id\)/);
  assert.match(migration, /unit_price := round\(resolved_price\.price\)/);
  assert.match(migration, /total_payable := subtotal - order_discount \+ other_fee/);
  assert.match(migration, /total_amount := total_payable \+ shipping_fee/);
  assert.doesNotMatch(migration, /unit_price\s*:=\s*.*item->>'(?:unitPrice|price)'/);
  assert.doesNotMatch(migration, /total_payable\s*:=\s*.*p_order->>'totalPayable'/);
});

test('SKU, price-list scope and immutable snapshots are enforced server-side', () => {
  assert.match(migration, /FROM public\.products[\s\S]*is_active = true/);
  assert.match(migration, /public\.can_use_price_list\(p_requested_id\)/);
  assert.match(migration, /product_name_snapshot/);
  assert.match(migration, /price_list_name_snapshot/);
  assert.match(migration, /actor\.auth_user_id::text/);
});

test('frontend submits business inputs and uses the canonical RPC response', () => {
  assert.match(service, /const command = \{/);
  assert.match(service, /items: \(order\.items \|\| \[\]\)\.map/);
  assert.match(invoice, /saved\.order \? saved\.order : order/);
  assert.match(invoice, /lastFinalizedOrder = persistedOrder/);
  assert.doesNotMatch(invoice, /`HD-\$\{Date\.now\(\)/);
});

test('a post-commit UI refresh error is never reported as a failed draft or finalization', () => {
  const saveFlow = invoice.slice(
    invoice.indexOf('export async function saveActiveOrder'),
    invoice.indexOf('export function resetInvoiceCustomer')
  );
  assert.match(saveFlow, /let persistedOrderAfterCommit = null/);
  assert.match(saveFlow, /if \(isCloudActive && \(status === 'draft' \|\| \(status === 'settled' && typeof saved === 'object'\)\)\)[\s\S]*persistedOrderAfterCommit = persistedOrder/);
  assert.match(saveFlow, /if \(persistedOrderAfterCommit\) \{/);
  assert.match(saveFlow, /completedAction = status === 'draft' \? 'lưu nháp' : 'chốt và lưu'/);
  assert.match(saveFlow, /return persistedOrderAfterCommit/);
  assert.ok(
    saveFlow.indexOf('resetInvoiceBuilder();') < saveFlow.indexOf('Đã chốt và lưu đơn hàng'),
    'success must be shown only after the local UI refresh completes'
  );
});

test('order browser cache is bounded and quota failures cannot fail Cloud saves', () => {
  assert.match(service, /const ORDER_CACHE_MAX_ITEMS = 120/);
  assert.match(service, /const ORDER_CACHE_MAX_JSON_CHARS = 750000/);
  assert.match(service, /export function cacheOrdersLocally/);
  assert.match(service, /localStorage\.removeItem\(ORDER_CACHE_KEY\)[\s\S]*localStorage\.setItem\(ORDER_CACHE_KEY, payload\)/);
  assert.match(invoice, /cacheOrdersLocally\(state\.savedOrders\)/);
  assert.doesNotMatch(invoice, /localStorage\.setItem\('billing_system_orders'/);
});

test('an uncertain RPC response is reconciled by the immutable order id', () => {
  assert.match(service, /async function recoverCommittedOrderAfterConfirmError\(order\)/);
  assert.match(service, /\.from\(tableOrdersName\)[\s\S]*\.eq\('id', order\.id\)[\s\S]*\.eq\('idempotency_key', order\.idempotencyKey\)/);
  assert.match(service, /recovered_after_error: true/);
  assert.match(service, /customer_state: customerState/);
  assert.match(service, /const recovered = await recoverCommittedOrderAfterConfirmError\(order\)/);
  assert.match(invoice, /const recoveredCustomer = saved\.customer_state/);
  assert.match(invoice, /cust\.totalTransaction = Number\(recoveredCustomer\.total_transaction \|\| 0\)/);
});

test('phase 1 has no inventory or production coupling and blocks finalized deletes', () => {
  const forbidden = /public\.(?:finished_goods_stock|raw_materials|semi_finished|recipes|production_logs|inventory)/i;
  assert.doesNotMatch(migration, forbidden);
  assert.match(migration, /REVOKE DELETE ON TABLE public\.orders, public\.order_items FROM authenticated/);
  const deleteFunction = service.slice(service.indexOf('export async function dbDeleteOrder'), service.indexOf('export async function dbDeleteAllOrders'));
  assert.doesNotMatch(deleteFunction, /from\(tableOrdersName\)\s*\.delete/);
  const fetchBatchStart = service.lastIndexOf('await Promise.all([');
  const fetchBatch = service.slice(fetchBatchStart, service.indexOf(']);', fetchBatchStart));
  assert.doesNotMatch(fetchBatch, /fetch(?:RawMaterials|SemiFinished|Recipes|ProductionLogs|FinishedGoodsStock)\(/);
  assert.match(service, /const localRaw = \[\];[\s\S]*const localFgs = \[\];/);
  assert.match(service, /if \(connectionSession\?\.user\) \{[\s\S]*fetchCloudData\(\)/);
});

test('staging SQL integration suite covers tampering, retries and authorization', () => {
  const sql = read('migrations/tests/phase1_order_pricing_integration.sql');
  assert.match(sql, /database_recalculates_tampered_prices_and_totals/);
  assert.match(sql, /same_idempotency_payload_returns_original_order/);
  assert.match(sql, /same_key_different_payload_is_rejected/);
  assert.match(sql, /inactive_sku_is_rejected/);
  assert.match(sql, /sale_cannot_force_private_price_list/);
  assert.match(sql, /ROLLBACK;/);
});
