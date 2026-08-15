import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('order entry keeps an explicit global price-list choice separate from the customer default', () => {
  const invoice = read('js/components/invoice.js');

  assert.match(invoice, /function isExplicitInvoicePriceListOverride\(\)/);
  assert.match(invoice, /select\?\.dataset\.explicitOverride === 'true'/);
  assert.match(invoice, /customerForPricing = isExplicitInvoicePriceListOverride\(\) && selectedId \? null : customer/);
  assert.match(invoice, /function shouldRequestAuthoritativePriceListOverride\(\)/);
  assert.match(invoice, /priceListOverride: shouldRequestAuthoritativePriceListOverride\(\)/);
  assert.match(invoice, /shouldOverrideWithGlobalCustomerPriceList\(\{/);
  assert.match(invoice, /isPrintOnlyPriceList\(selected\)/);
  assert.match(invoice, /plSelect\.disabled = false/);
  assert.doesNotMatch(invoice, /isDraftPriceListOverrideEnabled/);
});

test('editing or copying an order restores whether its price list overrides the customer default', () => {
  const history = read('js/components/history.js');

  assert.match(history, /customerDefaultPriceListId = customerContext\.customer/);
  assert.match(history, /orderPriceListId !== customerDefaultPriceListId/);
  assert.match(history, /isGlobalPriceList/);
  assert.match(history, /plSelect\.dataset\.explicitOverride = String/);
  assert.match(history, /plSelect\.disabled = isReadOnly/);
});

test('confirm and amend commands send the explicit override intent to the database', () => {
  const service = read('js/services/supabase.js');
  const matches = service.match(/priceListOverride: order\.priceListOverride === true/g) || [];

  assert.equal(matches.length, 2);
});

test('database accepts overrides only for active authorized global price lists', () => {
  const sql = read('migrations/0025_global_price_list_order_override.sql');

  assert.match(sql, /CREATE OR REPLACE FUNCTION public\.p25_resolve_order_price_list/);
  assert.match(sql, /COALESCE\(price_list\.price_list_type, price_list\.type, 'general'\) = 'general'/);
  assert.match(sql, /price_list\.customer_id IS NULL/);
  assert.match(sql, /price_list\.customer_group_id IS NULL/);
  assert.match(sql, /public\.p1_price_list_is_effective\(price_list\)/);
  assert.match(sql, /public\.can_use_price_list\(price_list\.id\)/);
  assert.match(sql, /is_available_for_sales = true/);
  assert.match(sql, /'GIA_CHUNG'/);
  assert.match(sql, /public\.p25_resolve_order_price_list\(/);
  assert.match(sql, /'priceListOverride'/);
  assert.doesNotMatch(sql, /GRANT EXECUTE ON FUNCTION public\.p25_resolve_order_price_list[\s\S]{0,100}authenticated/i);
});
