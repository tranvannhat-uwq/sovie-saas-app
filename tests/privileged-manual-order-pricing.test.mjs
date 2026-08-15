import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8');

const invoice = read('js/components/invoice.js');
const service = read('js/services/supabase.js');
const migration = read('migrations/0048_privileged_manual_order_pricing.sql');

test('Admin and Accounting can explicitly confirm manual pricing while Sale rules remain unchanged', () => {
  assert.match(invoice, /function canApproveManualInvoicePricing\(\)[\s\S]{0,120}\['admin', 'accounting'\]/);
  assert.match(invoice, /isManualInvoicePriceMode\(\) && canApproveManualInvoicePricing\(\)[\s\S]{0,120}return true/);
  assert.match(invoice, /window\.confirm\([\s\S]{0,200}đơn giá nhập tay/);
  assert.match(invoice, /order\.manualPriceConfirmed = true/);
});

test('confirmation intent reaches both confirmation and amendment commands', () => {
  const matches = service.match(/manualPriceConfirmed: order\.manualPriceConfirmed === true/g) || [];
  assert.equal(matches.length, 2);
  const manualItemIds = service.match(/order\.manualPriceConfirmed === true && order\.pricelistId === 'retail'/g) || [];
  assert.equal(manualItemIds.length, 2);
});

test('database trusts manual prices only for a confirmed privileged actor', () => {
  assert.match(migration, /actor\.role NOT IN \(''admin'', ''accounting''\)/);
  assert.match(migration, /manualPriceConfirmed/);
  assert.match(migration, /manualItems/);
  assert.match(migration, /manual_override/);
  assert.match(migration, /sku_resolver_statement[\s\S]*resolve_sku_price/);
  assert.match(migration, /E'IF NOT manual_pricing THEN/);
  assert.doesNotMatch(migration, /UPDATE public\.(?:orders|draft_orders|customers)/i);
  assert.doesNotMatch(migration, /DELETE FROM public\./i);
});
