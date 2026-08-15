import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('cashbook history reconciliation is exact, atomic and corrects debt once', () => {
  const sql = read('migrations/0034_cashbook_customer_history_backfill.sql');

  assert.match(sql, /match\.match_count = 1/);
  assert.match(sql, /cashbook\.reversal_of_id IS NULL/);
  assert.match(sql, /cashbook\.cancelled_at IS NULL/);
  assert.match(sql, /NOT EXISTS[\s\S]*debt\.cashbook_transaction_id = cashbook\.id/);
  assert.match(sql, /LOCK TABLE public\.customers/);
  assert.match(sql, /INSERT INTO public\.payments/);
  assert.match(sql, /INSERT INTO public\.customer_debt_transactions/);
  assert.match(sql, /'payment',[\s\S]*-repair\.amount/);
  assert.match(sql, /UPDATE public\.customers customer[\s\S]*SET debt = round\(COALESCE\(customer\.debt, 0\) - totals\.receipt_total\)/);
  assert.match(sql, /transaction_type = 'customer_payment'/);
  assert.match(sql, /operation_type = 'customer_debt_receipt'/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/);
  assert.match(sql, /'RECONCILE_CASHBOOK_CUSTOMER_HISTORY'/);
  assert.doesNotMatch(sql, /UPDATE public\.(orders|payments)/);
  assert.doesNotMatch(sql, /DELETE FROM/);
});
