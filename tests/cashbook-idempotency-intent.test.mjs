import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCashbookIdempotencyIntent } from '../js/domain/cashbook.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cashbookSource = fs.readFileSync(path.join(root, 'js/components/so_quy.js'), 'utf8');
const serviceSource = fs.readFileSync(path.join(root, 'js/services/supabase.js'), 'utf8');

const payment = {
  id: 'TCM000001',
  date: '2026-10-14T02:51:00.000Z',
  type: 'chi',
  category: 'Chi trả lương',
  partner: 'Nhất',
  value: 8000000,
  method: 'cash',
  accounting: true,
  note: ''
};

test('cashbook retry keeps its request key only for an unchanged form payload', () => {
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const firstAttempt = createCashbookIdempotencyIntent(null, payment, createId);
  const retry = createCashbookIdempotencyIntent(firstAttempt, { ...payment }, createId);

  assert.equal(retry.key, firstAttempt.key);
  assert.equal(generated, 1);
});

test('a changed cashbook payload or a new attempt gets a fresh key even with the same display code', () => {
  let generated = 0;
  const createId = () => `request-${++generated}`;
  const firstAttempt = createCashbookIdempotencyIntent(null, payment, createId);
  const changedAmount = createCashbookIdempotencyIntent(firstAttempt, { ...payment, value: 9000000 }, createId);
  const nextVoucher = createCashbookIdempotencyIntent(null, payment, createId);

  assert.equal(firstAttempt.key, 'cashbook:request-1');
  assert.equal(changedAmount.key, 'cashbook:request-2');
  assert.equal(nextVoucher.key, 'cashbook:request-3');
});

test('manual expense form supplies an intent key and clears it when the modal closes', () => {
  assert.match(cashbookSource, /createCashbookIdempotencyIntent\([\s\S]*newTx\s*\)[\s\S]*newTx\.idempotencyKey = pendingPaymentIdempotencyIntent\.key/);
  assert.match(cashbookSource, /const hidePaymentModal = \(\) => \{[\s\S]*pendingPaymentIdempotencyIntent = null/);
  assert.doesNotMatch(serviceSource, /`cashbook:\$\{tx\.id \|\| ''\}`/);
});
