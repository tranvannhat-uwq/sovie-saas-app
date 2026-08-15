import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const migration = read('migrations/0036_activity_log.sql');
const draftMigration = read('migrations/0037_draft_order_activity.sql');
const historyBridge = read('migrations/0038_activity_history_bridge.sql');
const component = read('js/components/activity-log.js');
const service = read('js/services/supabase.js');
const main = read('js/main.js');
const html = read('index.html');

test('activity log is append-only, indexed and actor identity comes from auth', () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS public\.activity_logs/);
  assert.match(migration, /IF auth\.uid\(\) IS NULL/);
  assert.match(migration, /SELECT \* INTO actor FROM public\.profiles/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.activity_logs FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(service, /from\(['"]activity_logs['"]\)\.(insert|update|delete|upsert)/);
  for (const index of ['created_at', 'actor', 'module', 'action', 'target', 'order', 'customer']) assert.match(migration, new RegExp(`activity_logs_${index}_idx`));
});

test('one transaction groups changed fields for one target and omits technical fields', () => {
  assert.match(migration, /UNIQUE \(operation_key, module, target_type, target_id\)/);
  assert.match(migration, /ON CONFLICT \(operation_key,module,target_type,target_id\) DO UPDATE/);
  assert.match(migration, /p36_activity_changes/);
  assert.match(migration, /\('updated_at'\)/);
});

test('activity readers are paginated and role restricted without forbidden modules', () => {
  assert.match(migration, /page_limit := LEAST\(GREATEST/);
  assert.match(migration, /actor\.role NOT IN \('admin','accounting'\)/);
  assert.match(migration, /rpc_get_order_activity/);
  const triggerTargets = migration.slice(migration.indexOf("FOREACH target IN ARRAY"), migration.indexOf('CREATE OR REPLACE FUNCTION public.rpc_get_activity_logs'));
  assert.doesNotMatch(triggerTargets, /inventory|warehouse|stock|production|manufacturing/i);
});

test('activity UI has dropdown, page filters, detail diff and clickable orders', () => {
  assert.match(html, /id="btn-activity-log"/);
  assert.match(html, /id="activity-log-panel"/);
  assert.match(html, /id="activity-detail-modal"/);
  assert.match(component, /dbFetchActivityLogs/);
  assert.match(component, /dbFetchOrderActivity/);
  assert.match(component, /activity-target-link/);
  assert.match(component, /switchTab\('history-panel'\)/);
  assert.match(main, /case 'activity-log-panel'/);
  assert.ok(html.indexOf('id="activity-log-panel"') < html.indexOf('id="settings-panel"'));
  assert.ok(html.indexOf('id="btn-activity-log"') < html.indexOf('id="btn-settings-toggle"'));
  assert.match(html, /id="btn-activity-log"[^>]*>[\s\S]*?data-lucide="bell"/);
});

test('activity log initially requests only the 20 newest changes', () => {
  assert.match(component, /const PAGE_SIZE = 20/);
  assert.match(component, /dbFetchActivityLogs\(\{ limit: PAGE_SIZE, offset: 0 \}\)/);
  assert.match(component, /activityPage = 1;\s*dropdown\.classList\.remove\('active'\);\s*switchTab\('activity-log-panel'\)/);
  assert.match(service, /rows: \[\], total: 0, limit: 20, offset: 0/);
});

test('draft notes use the draft table and produce order activity', () => {
  assert.match(draftMigration, /AFTER INSERT OR UPDATE OR DELETE ON public\.draft_orders/);
  assert.match(draftMigration, /rpc_update_draft_order_notes/);
  assert.match(draftMigration, /UPDATE public\.draft_orders SET notes=normalized/);
  assert.match(draftMigration, /'update_draft_order_notes'/);
  assert.match(service, /isDraft \? 'rpc_update_draft_order_notes' : 'rpc_update_order_notes'/);
  assert.match(read('js/components/history.js'), /dbUpdateOrderNotes\(order\.id, nextNotes\.trim\(\), order\.status === 'draft'\)/);
});

test('legacy audit history is bridged without rewriting business or audit data', () => {
  assert.match(historyBridge, /INSERT INTO public\.activity_logs/);
  assert.match(historyBridge, /JOIN LATERAL[\s\S]*public\.profiles/);
  assert.match(historyBridge, /'legacy-audit:' \|\| id/);
  assert.match(historyBridge, /operation_rank = 1/);
  assert.doesNotMatch(historyBridge, /(?:UPDATE|DELETE FROM) public\.(?:audit_logs|orders|customers|payments)/i);
});

test('structured product changes render as concise item-level differences', () => {
  assert.match(component, /function renderItemsDiff/);
  assert.match(component, /Số lượng:/);
  assert.match(component, /Đơn giá:/);
  assert.doesNotMatch(component, /JSON\.stringify\(value, null, 2\)/);
});

test('activity detail hides technical fields and scrolls inside a viewport-sized modal', () => {
  assert.match(component, /HIDDEN_ACTIVITY_FIELDS/);
  assert.match(component, /function visibleChanges/);
  assert.match(component, /total_market: 'Tổng tiền hàng'/);
  assert.match(component, /discount_type: 'Hình thức giảm giá'/);
  assert.match(read('style.css'), /modal-content\.activity-detail-modal[\s\S]*max-height: calc\(100vh - 3rem\)[\s\S]*overflow: hidden/);
  assert.match(read('style.css'), /activity-detail-modal \.modal-body[\s\S]*overflow-y: auto/);
});

test('customer financial activity fields use Vietnamese labels', () => {
  const ui = read('js/components/activity-log.js');
  assert.match(ui, /debt: 'Công nợ'/);
  assert.match(ui, /net_revenue: 'Doanh thu thuần'/);
  assert.match(ui, /last_order_at: 'Thời gian đơn hàng gần nhất'/);
  assert.match(ui, /total_transaction: 'Tổng giao dịch'/);
  assert.match(ui, /other_fee_value: 'Mức thu khác'/);
  assert.match(ui, /other_fee_amount: 'Số tiền thu khác'/);
  assert.match(ui, /shipping_support: 'Hỗ trợ vận chuyển'/);
  assert.match(ui, /shipping_discount: 'Giảm phí vận chuyển'/);
  assert.match(ui, /shipping_fee_value: 'Mức phí vận chuyển'/);
  assert.match(ui, /parsed === false \|\| parsed === 'false'\) return 'Không'/);
});

test('draft activity keeps technical ids for navigation but displays readable order codes', () => {
  assert.match(component, /getOrderDisplayCode/);
  assert.match(component, /data-order-id="\$\{escapeHtml\(row\.order_id\)\}"/);
  assert.match(component, /#\$\{escapeHtml\(displayCode\)\}/);
  assert.match(component, /activity-dropdown-meta/);
  assert.ok(component.indexOf('activity-dropdown-info') < component.indexOf('activity-dropdown-meta', component.indexOf('activity-dropdown-info')));
  assert.match(component, /<article class="activity-dropdown-item"/);
  assert.doesNotMatch(component, /<button class="activity-dropdown-item"/);
});
