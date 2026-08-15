import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('migration 0019 amends finalized orders atomically and preserves audit history', () => {
  const sql = read('migrations/0019_order_amendment_and_customer_advance.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_amend_order/);
  assert.match(sql, /actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(sql, /original_order\.status <> 'settled'/);
  assert.match(sql, /active_return_count > 0/);
  assert.match(sql, /PERFORM public\.p19_reverse_order_for_amendment[\s\S]*replacement := public\.rpc_confirm_order/);
  assert.match(sql, /new_balance := round\(COALESCE\(customer_row\.debt, 0\)\) - round\(charge\.debt_change\)/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.p19_reverse_order_for_amendment[\s\S]*authenticated/);
  assert.match(sql, /'orders', 'AMEND'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.rpc_amend_order[\s\S]*FROM PUBLIC, anon/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.rpc_amend_order[\s\S]*TO authenticated/);
});

test('history and invoice expose a dedicated finalized-order amendment path', () => {
  const history = read('js/components/history.js');
  const invoice = read('js/components/invoice.js');
  const service = read('js/services/supabase.js');
  assert.match(history, /showAmendBtn = order\.status === 'settled'/);
  assert.match(history, /activeOrderReturns\.length === 0/);
  assert.match(history, /data-amend-order-id/);
  assert.match(history, /state\.currentTab = 'invoice-panel'/);
  assert.match(invoice, /dbAmendOrder\(amendOrderId, order, amendmentReason\)/);
  assert.match(invoice, /dbRefreshOrderById\(amendOrderId\)/);
  assert.match(invoice, /dbRefreshOrderById\(persistedOrder\.id\)/);
  assert.doesNotMatch(invoice, /await fetchCloudData\(\)/);
  assert.match(invoice, /removeAttribute\('data-amend-order-id'\)/);
  assert.match(service, /supabaseClient\.rpc\('rpc_amend_order'/);
});

test('customer receipts may exceed receivables and become advance credit', () => {
  const sql = read('migrations/0019_order_amendment_and_customer_advance.sql');
  const service = read('js/services/supabase.js');
  const customers = read('js/components/customers.js');
  const cashbook = read('js/components/so_quy.js');
  assert.match(sql, /new_balance := round\(COALESCE\(customer_row\.debt, 0\)\) - round\(p_amount\)/);
  assert.match(sql, /'customer_credit', GREATEST\(-new_balance, 0\)/);
  assert.doesNotMatch(sql, /p_amount > (?:customer_row\.)?debt/);
  assert.match(service, /supabaseClient\.rpc\('rpc_record_customer_receipt'/);
  assert.doesNotMatch(customers, /amountPaid > debtBefore|debtBefore <= 0/);
  assert.doesNotMatch(cashbook, /value > currentDebt|currentDebt <= 0/);
  assert.match(customers, /tiền trả trước/);
  assert.match(cashbook, /normalizedCategory\.includes\('trả trước'\)/);
});
