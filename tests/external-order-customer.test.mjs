import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

test('external customer entry is stored on an order without entering quick-create mode', () => {
  const html = read('index.html');
  const invoice = read('js/components/invoice.js');
  const state = read('js/state.js');
  const compile = invoice.slice(
    invoice.indexOf('export function compileActiveOrder'),
    invoice.indexOf('export async function saveActiveOrder')
  );

  assert.match(html, /id="btn-invoice-external-customer"/);
  assert.match(html, /id="invoice-external-customer-name"/);
  assert.match(html, /id="invoice-external-customer-phone"/);
  assert.match(html, /id="invoice-external-customer-address"/);
  assert.match(state, /isExternalCustomerMode: false/);
  assert.match(invoice, /export function enableExternalCustomerMode/);
  assert.match(compile, /else if \(state\.isExternalCustomerMode\)[\s\S]*?custId = null/);
  assert.match(compile, /customerId: custId,[\s\S]*?customerName,[\s\S]*?customerPhone: phone[\s\S]*?customerAddress: address/);
  assert.match(invoice, /Khoản còn phải thu sẽ được theo dõi riêng trên đơn hàng/);
  assert.match(invoice, /clearBtn\?\.addEventListener\('click', \(\) => prepareInvoiceCustomerReselection\(\)\)/);
  assert.match(invoice, /if \(state\.isQuickCustomerMode \|\| state\.isExternalCustomerMode\) return/);
});

test('external customer contacts survive cloud saves, history editing, and the order print view', () => {
  const service = read('js/services/supabase.js');
  const history = read('js/components/history.js');
  const invoice = read('js/components/invoice.js');

  assert.match(service, /customer_phone: order\.customerPhone \|\| null/);
  assert.match(service, /customer_address: order\.customerAddress \|\| null/);
  assert.match(service, /customerPhone: order\.customer_phone \|\| order\.customerPhone \|\| ''/);
  assert.match(service, /customerAddress: order\.customer_address \|\| order\.customerAddress \|\| ''/);
  assert.match(history, /enableExternalCustomerMode\(\{[\s\S]*?phone: order\.customerPhone \|\| order\.customer_phone[\s\S]*?address: order\.customerAddress \|\| order\.customer_address/);
  assert.match(invoice, /if \(addressEl\) addressEl\.innerText = order\.customerAddress \|\| 'N\/A'/);
  assert.match(invoice, /formatPhoneNumber\(order\.customerPhone\) \|\| 'N\/A'/);
});

test('migration keeps external contact snapshots order-scoped and private behind the executor', () => {
  const migration = read('migrations/0109_order_only_external_customer_snapshots.sql');

  assert.match(migration, /ALTER TABLE public\.orders[\s\S]*ADD COLUMN IF NOT EXISTS customer_phone text[\s\S]*ADD COLUMN IF NOT EXISTS customer_address text/);
  assert.match(migration, /ALTER TABLE public\.draft_orders[\s\S]*ADD COLUMN IF NOT EXISTS customer_phone text[\s\S]*ADD COLUMN IF NOT EXISTS customer_address text/);
  assert.match(migration, /IF saved_customer_id IS NULL THEN[\s\S]*UPDATE public\.orders sale[\s\S]*AND sale\.customer_id IS NULL/);
  assert.match(migration, /never create\s+-- or update a customer profile/i);
  assert.doesNotMatch(migration, /INSERT\s+INTO\s+public\.customers|UPDATE\s+public\.customers/i);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.persist_order_customer_contact_snapshot[\s\S]*FROM PUBLIC, anon, authenticated/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.persist_order_customer_contact_snapshot[\s\S]*TO saas_rpc_executor/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.rpc_confirm_order\(jsonb\) TO authenticated/);
});
