import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(
  path.join(root, 'migrations/0050_cancel_amended_customer_receipt.sql'),
  'utf8'
);

test('cancelling an amended receipt reverses its current effective value', () => {
  assert.match(migration, /debt_delta := round\(COALESCE\(entry\.value, 0\)\)/);
  assert.doesNotMatch(migration, /ELSE -COALESCE\(original_customer_ledger\.debt_change/);
  assert.match(migration, /rpc_cancel_cashbook_entry\(text,text\)/);
});

test('confirmed KH000003 repair is append-only, guarded and auditable', () => {
  assert.match(migration, /PT-20260810-00000146/);
  assert.match(migration, /20587100/);
  assert.match(migration, /9995000/);
  assert.match(migration, /10592100/);
  assert.match(migration, /INSERT INTO public\.customer_debt_transactions/);
  assert.match(migration, /'DEBT_REPAIR'/);
  assert.doesNotMatch(migration, /UPDATE public\.customer_debt_transactions|DELETE FROM public\./i);
});

test('clean staging skips the production-specific repair but rejects partial target data', () => {
  assert.match(migration, /target_customer_count = 0[\s\S]*target_voucher_count = 0[\s\S]*cancellation_count = 0/);
  assert.match(migration, /confirmed KH000003 repair target is absent; skipping data repair/);
  assert.match(migration, /confirmed repair target is incomplete/);
  assert.match(migration, /NOT EXISTS \(SELECT 1 FROM public\.customers WHERE code = 'KH000003'\)/);
});
