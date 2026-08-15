import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('customer debt adjustment uses the reviewed RPC and keeps profile debt read-only', () => {
  const html = read('index.html');
  const customers = read('js/components/customers.js');
  const service = read('js/services/supabase.js');

  assert.match(html, /id="cust-debt"[^>]*readonly/);
  assert.match(html, /id="btn-open-customer-debt-adjust"/);
  assert.match(html, /id="customer-debt-adjust-modal"[\s\S]*?<div class="modal-content"/);
  const adjustmentInput = html.match(/<input[^>]*id="customer-debt-adjust-value"[^>]*>/)?.[0] || '';
  assert.match(adjustmentInput, /placeholder="Ví dụ: -1000000"/);
  assert.doesNotMatch(adjustmentInput, /\bmin=/);
  assert.match(html, /id="customer-debt-adjust-reason"[^>]*minlength="3"/);
  assert.match(customers, /\['admin', 'accounting'\]\.includes\(state\.currentUser\?\.role\)/);
  assert.match(customers, /await dbAdjustCustomerDebt\(customerId, newDebt, reason\)/);
  assert.match(service, /rpc\('rpc_adjust_customer_debt'/);
});

test('signed debt corrections are ledgered and audited by the database', () => {
  const migration = read('migrations/0020_customer_debt_adjustment_credit.sql');
  assert.doesNotMatch(migration, /p_new_debt\s*<\s*0/);
  assert.match(migration, /INSERT INTO public\.customer_debt_transactions/);
  assert.match(migration, /'ADJUST_DEBT'/);
  assert.match(migration, /actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_adjust_customer_debt/);
});
