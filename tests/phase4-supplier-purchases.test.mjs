import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('migrations/0009_supplier_purchases_debt_and_payments.sql');
const service = read('js/services/supabase.js');
const purchases = read('js/components/purchases.js');
const suppliers = read('js/components/suppliers.js');
const integration = read('migrations/tests/phase4_supplier_purchases_integration.sql');

test('database owns purchase totals and ignores browser totals', () => {
  assert.match(migration, /jsonb_array_elements\(p_input->'items'\)/);
  assert.match(migration, /sum\(round\(\(item->>'quantity'\)::numeric \* round\(\(item->>'unitPrice'\)::numeric\)\)\)/);
  assert.doesNotMatch(service.slice(service.indexOf('export async function dbCreatePurchase'), service.indexOf('export async function dbRecordSupplierPayment')), /totalAmount|lineTotal|balanceDue/);
  assert.match(purchases, /Database sẽ tự tính lại toàn bộ thành tiền và công nợ/);
});

test('purchase, supplier payment and debt ledger are atomic and actor stamped', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.rpc_create_purchase\(p_input jsonb\)/);
  assert.match(migration, /INSERT INTO public\.purchases/);
  assert.match(migration, /INSERT INTO public\.purchase_items/);
  assert.match(migration, /INSERT INTO public\.purchase_payments/);
  assert.match(migration, /INSERT INTO public\.supplier_debt_transactions/);
  assert.match(migration, /INSERT INTO public\.cashbook_transactions/);
  assert.match(migration, /actor\.auth_user_id::text/);
  assert.match(migration, /pg_advisory_xact_lock/);
});

test('supplier financial aggregates cannot be written from browser', () => {
  assert.match(migration, /p4_supplier_totals_guard/);
  assert.match(migration, /REVOKE ALL ON TABLE public\.%I FROM PUBLIC, anon, authenticated/);
  assert.doesNotMatch(service.slice(service.indexOf('export async function dbSaveSupplier'), service.indexOf('async function legacyDbSaveSuppliersBulk')), /\.from\(/);
  assert.match(service, /rpc_save_supplier/);
  assert.match(service, /rpc_deactivate_supplier/);
  assert.match(suppliers, /totalPurchase: toNumber\(supplier\.totalPurchase\)/);
});

test('cancellation preserves rows and appends debt and cashbook reversals', () => {
  assert.match(migration, /rpc_cancel_supplier_payment/);
  assert.match(migration, /supplier_payment_reversal/);
  assert.match(migration, /rpc_cancel_purchase/);
  assert.match(migration, /purchase_reversal/);
  assert.match(migration, /reversal_of_id/);
  assert.doesNotMatch(migration, /DELETE\s+FROM\s+public\.(?:purchases|purchase_items|purchase_payments|supplier_debt_transactions)/i);
});

test('sale and anon are denied while finance roles use reviewed RPCs', () => {
  assert.match(migration, /actor\.role NOT IN \('admin', 'accounting'\)/);
  assert.match(migration, /REVOKE ALL ON FUNCTION public\.rpc_create_purchase\(jsonb\) FROM PUBLIC, anon/);
  assert.match(migration, /CREATE POLICY %I[\s\S]*public\.is_admin_or_accounting\(\)/);
  assert.match(migration, /target \|\| '_finance_select'/);
  assert.match(purchases, /state\.currentUser\?\.role === 'admin'.*state\.currentUser\?\.role === 'accounting'/s);
});

test('phase 4 has no inventory or production coupling', () => {
  const forbidden = /public\.(?:finished_goods_stock|raw_materials|semi_finished|recipes|production_logs|inventory)/i;
  assert.doesNotMatch(migration, forbidden);
  assert.doesNotMatch(purchases, /finishedGoodsStock|rawMaterials|productionLogs|inventory/i);
});

test('frontend uses canonical RPC responses and never stores purchases locally', () => {
  assert.match(service, /applyPhase4Response/);
  assert.match(purchases, /await dbCreatePurchase/);
  assert.match(purchases, /await dbRecordSupplierPayment/);
  assert.match(purchases, /await dbCancelSupplierPayment/);
  assert.match(purchases, /await dbCancelPurchase/);
  assert.doesNotMatch(purchases, /localStorage|sessionStorage|billing_system_goods_receipts/);
});

test('staging suite covers calculation, retries, roles and full reversals', () => {
  assert.match(integration, /backend_calculates_purchase_total/);
  assert.match(integration, /same_purchase_request_is_idempotent/);
  assert.match(integration, /supplier_payment_updates_debt_and_cashbook/);
  assert.match(integration, /cancel_purchase_reverses_debt_and_payments/);
  assert.match(integration, /sale_cannot_create_purchase/);
  assert.match(integration, /anon_cannot_create_purchase/);
  assert.match(integration, /ROLLBACK;/);
});
