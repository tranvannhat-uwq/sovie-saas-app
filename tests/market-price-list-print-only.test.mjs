import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const invoice = read('js/components/invoice.js');
const service = read('js/services/supabase.js');
const html = read('index.html');
const migration = read('migrations/0027_market_price_lists_are_print_only.sql');
const approvalMigration = read('migrations/0028_tt_20072026_requires_accounting_approval.sql');
const pricelists = read('js/components/pricelists.js');

test('market pricing remains printable but invoice persistence actions are blocked', () => {
  assert.match(invoice, /function isPrintOnlyInvoiceMode\(\)/);
  assert.match(invoice, /saveActiveOrder\(status = 'settled'\)[\s\S]{0,180}isPrintOnlyInvoiceMode\(\)/);
  assert.match(invoice, /Bảng giá này chỉ dùng để in và chưa được Kế toán cho phép lưu/);
  assert.match(invoice, /button\.disabled = printOnly/);
  assert.match(html, /id="invoice-print-only-notice"/);
  assert.match(invoice, /const order = state\.invoiceItems\.length > 0 \? compileActiveOrder\(\) : lastFinalizedOrder/);
});

test('service layer rejects market-price drafts, confirmations and amendments', () => {
  assert.match(service, /function findPrintOnlyOrderPriceList\(order\)/);
  for (const signature of [
    'export async function dbSaveOrder(order)',
    'export async function dbConfirmOrder(order)',
    'export async function dbAmendOrder(originalOrderId, order, reason)'
  ]) {
    const start = service.indexOf(signature);
    assert.ok(start >= 0, `${signature} must exist`);
    assert.match(service.slice(start, start + 260), /findPrintOnlyOrderPriceList\(order\)/);
  }
});

test('database blocks print-only price lists before order or draft persistence', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS is_print_only boolean NOT NULL DEFAULT false/);
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.p27_reject_print_only_order\(\)/);
  assert.match(migration, /BEFORE INSERT ON public\.orders/);
  assert.match(migration, /BEFORE INSERT ON public\.draft_orders/);
  assert.match(migration, /BEFORE UPDATE ON public\.draft_orders/);
  assert.match(migration, /chưa được Kế toán cho phép lưu; chỉ được in và không được phát sinh công nợ/);
  assert.doesNotMatch(migration, /DELETE FROM public\.(?:orders|draft_orders|customer_debt_transactions)/i);
});

test('TT 20/07/2026 requires an independent Accounting approval to save orders', () => {
  assert.match(html, /id="pl-allow-order-save"/);
  assert.match(pricelists, /isPrintOnly: !document\.getElementById\('pl-allow-order-save'\)\.checked/);
  assert.match(invoice, /requiresOrderSaveApproval\(selected\)[\s\S]{0,120}selected\?\.isPrintOnly === false/);
  assert.match(service, /is_print_only: pricelist\.isPrintOnly === true/);
  assert.match(approvalMigration, /TT20072026/);
  assert.match(approvalMigration, /SET is_print_only = true/);
  assert.doesNotMatch(approvalMigration, /DELETE FROM public\./i);
});
