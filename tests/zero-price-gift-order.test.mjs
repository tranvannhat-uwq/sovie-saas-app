import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const invoice = read('js/components/invoice.js');
const service = read('js/services/supabase.js');
const pricingMigration = read('migrations/0006_authoritative_order_pricing_and_idempotency.sql');

test('invoice treats an explicit zero price as usable and still rejects a missing price', () => {
  assert.match(invoice, /if \(!isUsableResolvedPrice\(resolvedPrice\)\)/);
  assert.match(invoice, /const hasPrice = isUsableResolvedPrice\(price\)/);
  assert.match(invoice, /Number\(unitPrice\) < 0/);
  assert.doesNotMatch(invoice, /Number\(resolvedPrice\.price\) <= 0/);
});

test('zero survives order payload serialization instead of falling through to another value', () => {
  assert.match(invoice, /unitPrice: item\.unitPrice \?\? item\.price/);
  assert.match(service, /unitPrice: Number\(item\.unitPrice \?\? item\.price \?\? 0\)/);
  assert.match(service, /unit_price: parseFloat\(item\.unitPrice \?\? item\.price \?\? 0\)/);
});

test('database price list and authoritative order pricing allow nonnegative prices', () => {
  assert.match(pricingMigration, /CHECK \(price >= 0\)/);
  assert.match(pricingMigration, /IF found_price IS NOT NULL THEN/);
  assert.doesNotMatch(pricingMigration, /found_price\s*>\s*0/);
});
