import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('invoice quick customer uses its scoped RPC instead of direct table upsert', () => {
  const invoice = read('js/components/invoice.js');
  const service = read('js/services/supabase.js');
  assert.match(invoice, /dbCreateQuickCustomer\(newCustomer\)/);
  assert.doesNotMatch(invoice, /dbSaveCustomer\(newCustomer\)/);
  const quickSave = service.slice(
    service.indexOf('export async function dbCreateQuickCustomer'),
    service.indexOf('export async function dbSaveCustomersBulk')
  );
  assert.match(quickSave, /rpc\('rpc_create_quick_customer'/);
  assert.doesNotMatch(quickSave, /\.from\(tableCustomersName\)/);
  assert.match(invoice, /const savedCustomer = custSaved === true/);
  assert.match(invoice, /state\.customers\.push\(savedCustomer\)/);
});

test('duplicate quick-customer phone reuses the existing customer without blocking the order', () => {
  const invoice = read('js/components/invoice.js');
  const saveStart = invoice.indexOf('export async function saveActiveOrder');
  const saveEnd = invoice.indexOf('export function resetInvoiceCustomer', saveStart);
  const save = invoice.slice(saveStart, saveEnd);

  assert.match(save, /const duplicateCustomer = cleanPhone[\s\S]*?state\.customers\.find/);
  assert.match(save, /const cleanPhone = normalizeCustomerPhone\(qPhone\)/);
  assert.match(save, /const cPhone = normalizeCustomerPhone\(c\.phone\)/);
  assert.match(save, /resolvedQuickCustomer = duplicateCustomer;/);
  assert.match(save, /reusedExistingQuickCustomer = true;/);
  assert.match(save, /Đơn hàng sẽ được lưu cho khách hàng này\./);
  assert.match(save, /compileActiveOrder\(resolvedQuickCustomer\)/);
  assert.match(save, /canPersistCurrentInvoicePricing\(reusedExistingQuickCustomer \? resolvedQuickCustomer : null\)/);
  assert.doesNotMatch(save, /Số điện thoại này đã được đăng ký cho khách hàng khác![\s\S]{0,100}return null/);
});

test('existing customer override supplies authoritative order identity snapshots', () => {
  const invoice = read('js/components/invoice.js');
  const compileStart = invoice.indexOf('export function compileActiveOrder');
  const compileEnd = invoice.indexOf('export async function saveActiveOrder', compileStart);
  const compile = invoice.slice(compileStart, compileEnd);

  assert.match(compile, /if \(customerOverride\)/);
  assert.match(compile, /custId = customerOverride\.id;/);
  assert.match(compile, /customerName = customerOverride\.name/);
  assert.match(compile, /customerManagerId = customerOverride\.managedBy/);
});

test('quick customer RPC is role-scoped, sale-owned and cannot accept financial balances', () => {
  const sql = read('migrations/0018_quick_customer_creation_rpc.sql');
  assert.match(sql, /actor\.role NOT IN \('admin', 'accounting', 'sale'\)/);
  assert.match(sql, /IF actor\.role = 'sale' THEN[\s\S]*manager_profile := actor/);
  assert.match(sql, /manager_profile\.auth_user_id::text/);
  assert.match(sql, /'active', 0, 0, 0, 0, '\[\]'::jsonb/);
  assert.doesNotMatch(sql, /p_customer->>'(?:debt|totalTransaction|totalReturn|netRevenue)'/);
  assert.match(sql, /'QUICK_CREATE'/);
  assert.match(sql, /REVOKE ALL ON FUNCTION public\.rpc_create_quick_customer\(jsonb\) FROM PUBLIC, anon/);
  assert.match(sql, /GRANT EXECUTE ON FUNCTION public\.rpc_create_quick_customer\(jsonb\) TO authenticated/);
});

test('quick customer manager identity is normalized to the profile username', () => {
  const sql = read('migrations/0054_quick_customer_manager_identity.sql');
  assert.match(sql, /manager_profile\.username/);
  assert.doesNotMatch(sql, /manager_profile\.auth_user_id::text/);
  assert.match(sql, /audit\.action = 'QUICK_CREATE'/);
  assert.match(sql, /audit\.new_data->>'source' = 'invoice_quick_create'/);
  assert.match(sql, /customer\.managed_by = profile\.auth_user_id::text/);
  assert.match(sql, /SET managed_by = profile\.username/);
});
