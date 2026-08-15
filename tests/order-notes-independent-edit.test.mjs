import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('order notes use a dedicated non-financial audited RPC', () => {
  const sql = read('migrations/0029_order_notes_annotation.sql');
  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.rpc_update_order_notes/);
  assert.match(sql, /actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(sql, /SET notes = normalized_notes,[\s\S]*updated_by = actor\.auth_user_id::text/);
  assert.match(sql, /'orders', 'UPDATE_NOTES'/);
  assert.match(sql, /'financial_impact', false/);
  assert.doesNotMatch(sql, /UPDATE public\.customers|customer_debt_transactions|cashbook_transactions|commission_transactions/);
});

test('history edits notes outside the finalized-order amendment flow', () => {
  const history = read('js/components/history.js');
  const service = read('js/services/supabase.js');
  assert.match(history, /history-notes-btn/);
  assert.match(history, /dbUpdateOrderNotes\(order\.id, nextNotes\.trim\(\), order\.status === 'draft'\)/);
  assert.match(service, /isDraft \? 'rpc_update_draft_order_notes' : 'rpc_update_order_notes'/);
  assert.doesNotMatch(service.match(/export async function dbUpdateOrderNotes[\s\S]*?\n\}/)?.[0] || '', /rpc_amend_order|dbAmendOrder/);
});

test('customer debt history does not expose amendment and cancellation bookkeeping labels', () => {
  const customers = read('js/components/customers.js');
  assert.match(customers, /buildCustomerDebtDisplayHistory/);
  assert.doesNotMatch(customers, /Đảo bản cũ/);
});
