import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');
const migration = read('migrations/0044_cashbook_voucher_amendment.sql');
const lineageMigration = read('migrations/0045_cashbook_amendment_lineage.sql');
const ui = read('js/components/so_quy.js');
const service = read('js/services/supabase.js');
const html = read('index.html');

test('receipt and payment amendments keep their original direction', () => {
  assert.match(migration, /Voucher direction is immutable/);
  assert.doesNotMatch(migration, /SET[\s\S]{0,80}\btype\s*=/);
  assert.match(ui, /Sửa phiếu thu/);
  assert.match(ui, /Sửa phiếu chi/);
  assert.match(ui, /Loại thu/);
  assert.match(ui, /Loại chi/);
});

test('collector and counterparty are separate from immutable creator identity', () => {
  for (const column of ['collector_id', 'collector_name', 'counterparty_type', 'counterparty_id']) {
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${column}`));
  }
  assert.match(html, /id="cashbook-edit-collector"/);
  assert.match(html, /id="cashbook-edit-counterparty"/);
  assert.match(service, /collectorId: t\.collector_id/);
  assert.match(service, /counterpartyType: t\.counterparty_type/);
  assert.doesNotMatch(migration, /SET[\s\S]{0,120}\bcreated_by\s*=/);
});

test('linked customer receipts append debt adjustments and update payment atomically', () => {
  assert.match(migration, /'payment_amend'/);
  assert.match(migration, /'payment_relink'/);
  assert.match(migration, /UPDATE public\.payments SET customer_id = next_customer_id, amount = next_value/);
  assert.match(migration, /UPDATE public\.customers SET debt/);
  assert.doesNotMatch(migration, /UPDATE public\.customer_debt_transactions/);
  assert.doesNotMatch(migration, /DELETE FROM public\.customer_debt_transactions/);
});

test('amendments use separate lineage and never consume the one-reversal slot', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS amends_ledger_id/);
  assert.match(migration, /cashbook_transaction_id, amends_ledger_id, description/);
  assert.match(lineageMigration, /SET amends_ledger_id = reversal_of_id,[\s\S]*reversal_of_id = NULL/);
  assert.match(lineageMigration, /transaction_type IN \('payment_amend', 'payment_relink', 'return_amend'\)/);
  assert.match(service, /amendsLedgerId: row\.amends_ledger_id/);
});

test('order-linked sale receipts update order payment and customer debt atomically', () => {
  assert.match(migration, /operation = 'sale_receipt'/);
  assert.match(migration, /'sale_payment_amend'/);
  assert.match(migration, /UPDATE public\.orders[\s\S]*paid_amount = next_sale_paid/);
  assert.match(migration, /Amended receipt would make the order paid amount invalid/);
  assert.match(ui, /return 'sale_receipt'/);
});

test('linked supplier payments and return refunds use dedicated financial routes', () => {
  assert.match(migration, /'supplier_payment_amend'/);
  assert.match(migration, /UPDATE public\.purchase_payments SET supplier_id = next_supplier_id/);
  assert.match(migration, /PERFORM public\.p4_recompute_purchase/);
  assert.match(migration, /'return_amend'/);
  assert.match(migration, /UPDATE public\.sales_returns SET refund_amount = next_value/);
  assert.match(migration, /Cash refund cannot exceed the total return amount/);
});

test('amendment rejects cancelled and reversal vouchers and audits before/after state', () => {
  assert.match(migration, /Cancelled cashbook transactions cannot be amended/);
  assert.match(migration, /Reversal cashbook transactions cannot be amended/);
  assert.match(migration, /'cashbook_transactions', 'AMEND', entry\.id, to_jsonb\(entry\)/);
  assert.match(migration, /actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_amend_cashbook_transaction\(text, jsonb\)/);
});
