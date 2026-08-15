import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('migrations/0007_payments_debt_cashbook_and_order_reversals.sql');
const compatibilityMigration = read('migrations/0013_legacy_cashbook_customer_and_order_compatibility.sql');
const service = read('js/services/supabase.js');
const customers = read('js/components/customers.js');
const cashbook = read('js/components/so_quy.js');
const history = read('js/components/history.js');

test('collections are atomic, actor-stamped and idempotent', () => {
  assert.match(migration, /rpc_record_customer_payment\([\s\S]*p_idempotency_key text/);
  assert.match(migration, /pg_advisory_xact_lock/);
  assert.match(migration, /Payment exceeds outstanding debt/);
  assert.match(migration, /actor\.auth_user_id::text/);
  assert.match(migration, /INSERT INTO public\.payments/);
  assert.match(migration, /INSERT INTO public\.customer_debt_transactions/);
  assert.match(migration, /INSERT INTO public\.cashbook_transactions/);
});

test('financial history is append-only and browser debt writes are rejected', () => {
  assert.match(migration, /p2_ledger_immutable/);
  assert.match(migration, /BEFORE INSERT ON public\.customers/);
  assert.match(migration, /BEFORE UPDATE OF debt, total_transaction, total_return, net_revenue, last_order_at, last_payment_at\s+ON public\.customers\s+FOR EACH ROW/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.customer_debt_transactions FROM authenticated/);
  assert.match(migration, /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.orders, public\.order_items FROM authenticated/);
  assert.match(migration, /reversal_of_id/);
  const saveCustomer = customers.slice(customers.indexOf('export async function saveCustomer'), customers.indexOf('export async function deleteCustomer'));
  assert.doesNotMatch(saveCustomer, /dbAdjustCustomerDebt/);
  assert.match(saveCustomer, /await dbFetchCustomerById\(customerId\)/);
  const mapper = service.slice(service.indexOf('function mapCustomerToDbRow'), service.indexOf('export async function dbSaveCustomer'));
  assert.doesNotMatch(mapper, /\bdebt\s*:/);
  assert.doesNotMatch(mapper, /total_transaction\s*:/);
});

test('cashbook and opening balances use reviewed RPCs before local cache', () => {
  assert.match(service, /rpc_create_cashbook_transaction/);
  assert.match(service, /rpc_cancel_cashbook_entry/);
  assert.match(service, /rpc_set_cashbook_starting_balances/);
  assert.match(service, /rpc_set_cashbook_starred/);
  const saveBalances = cashbook.slice(cashbook.indexOf('export async function saveStartingBalances'), cashbook.indexOf('// Global active filters'));
  assert.match(saveBalances, /await dbSaveStartingBalances/);
  assert.ok(saveBalances.indexOf('await dbSaveStartingBalances') < saveBalances.indexOf('localStorage.setItem'));
  const legacySync = service.slice(service.indexOf('export async function syncLocalToCloud'), service.indexOf('// --- Thao tác CSDL chi tiết (Sản phẩm)'));
  assert.doesNotMatch(legacySync, /from\(tableCashbookTransactionsName\)\s*\.upsert/);
  assert.doesNotMatch(legacySync, /from\(tableStartingBalancesName\)\s*\.upsert/);
  assert.doesNotMatch(legacySync, /const settledRows/);
});

test('cancellations append reversal records and cannot be performed by Sale', () => {
  assert.match(migration, /rpc_cancel_customer_payment/);
  assert.match(migration, /transaction_type[^\n]*'payment_cancel'|\'payment_cancel\'/);
  assert.match(migration, /rpc_cancel_order/);
  assert.match(migration, /actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(migration, /Order has sales returns/);
  assert.match(migration, /order_cancel_reversal/);
  assert.match(history, /await dbCancelOrder/);
  assert.match(history, /await dbRefreshCustomerFinancialState\(order\.customerId, \{ includeHistory: false \}\)/);
  assert.doesNotMatch(history, /Number\(result\.new_debt\)/);
  assert.match(read('js/components/customers.js'), /buildCustomerDebtDisplayHistory/);
});

test('Phase 2 remains detached from inventory and production', () => {
  assert.doesNotMatch(migration, /public\.(?:finished_goods_stock|raw_materials|semi_finished|recipes|production_logs|inventory)/i);
  assert.doesNotMatch(migration, /UPDATE\s+public\.sales_returns|INSERT INTO\s+public\.sales_returns/i);
});

test('staging suite and recovery instructions cover required paths', () => {
  const sql = read('migrations/tests/phase2_financial_reversals_integration.sql');
  const recovery = read('migrations/ROLLBACK_0007.md');
  assert.match(sql, /payment_retry_is_idempotent/);
  assert.match(sql, /payment_cancel_appends_reversal/);
  assert.match(sql, /order_cancel_reverses_debt_revenue_and_status/);
  assert.match(sql, /sale_cannot_record_payment/);
  assert.match(sql, /ROLLBACK;/);
  assert.match(recovery, /Do not delete payments/);
});
