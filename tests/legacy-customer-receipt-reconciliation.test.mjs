import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('legacy receipt reconciliation is explicit, atomic, audited and idempotent', () => {
  const sql = read('migrations/0032_reconcile_legacy_customer_receipts.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_reconcile_legacy_customer_receipt/);
  assert.match(sql, /actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(sql, /customer_debt_transactions[\s\S]*cashbook_transaction_id = entry\.id/);
  assert.match(sql, /'already_reconciled', true/);
  assert.match(sql, /INSERT INTO public\.payments/);
  assert.match(sql, /INSERT INTO public\.customer_debt_transactions/);
  assert.match(sql, /UPDATE public\.customers[\s\S]*SET debt = new_balance/);
  assert.match(sql, /'RECONCILE_CUSTOMER_RECEIPT'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.rpc_reconcile_legacy_customer_receipt\(text, text\)[\s\S]*FROM PUBLIC, anon/);
  assert.doesNotMatch(sql, /DELETE FROM/);
});

test('cashbook exposes reconciliation only for a uniquely matched legacy receipt', () => {
  const html = read('index.html');
  const cashbook = read('js/components/so_quy.js');
  const service = read('js/services/supabase.js');
  assert.doesNotMatch(html, /id="so-quy-detail-modal"/);
  assert.match(cashbook, /js-cashbook-inline-reconcile/);
  assert.match(cashbook, /function getLegacyReceiptCustomer/);
  assert.match(cashbook, /return matches\.length === 1 \? matches\[0\] : null/);
  assert.match(cashbook, /await dbReconcileLegacyCustomerReceipt\(cashbookId, legacyCustomer\.id\)/);
  assert.match(cashbook, /dbRefreshCustomerFinancialState\(legacyCustomer\.id, \{ includeHistory: false \}\)/);
  assert.match(service, /supabaseClient\.rpc\('rpc_reconcile_legacy_customer_receipt'/);
});
