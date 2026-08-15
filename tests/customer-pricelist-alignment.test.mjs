import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');

test('all cloud customer hydration paths prefer the price list edited by the customer form', () => {
  const service = read('js/services/supabase.js');
  const alignedMappings = service.match(
    /pricelistId: cust\.pricelist_id \|\| cust\.default_price_list_id \|\| ''/g
  ) || [];

  assert.equal(alignedMappings.length, 3);
  assert.match(
    service,
    /const candidate = customer\.pricelistId \|\| customer\.defaultPriceListId \|\| '';/
  );
});

test('customer labels use the same price-list priority as order pricing', () => {
  const customers = read('js/components/customers.js');

  assert.match(
    customers,
    /const id = customer\.pricelistId \|\| customer\.defaultPriceListId \|\| '';/
  );
});

test('price-list display order cannot override the customer selection priority', () => {
  const pricing = read('js/domain/pricing.js');

  assert.match(
    pricing,
    /references\s*\.map\(reference => activeLists\.find\(priceList => matchesPriceListReference\(priceList, reference\)\)\)\s*\.find\(Boolean\)/
  );
  assert.doesNotMatch(
    pricing,
    /activeLists\.find\(priceList =>\s*references\.some/
  );
});

test('database order pricing prefers the customer-form selection without trusting browser prices', () => {
  const sql = read('migrations/0031_customer_pricelist_priority_alignment.sql');

  assert.match(
    sql,
    /ARRAY\[customer_row\.pricelist_id, customer_row\.default_price_list_id\]/
  );
  assert.match(sql, /public\.can_use_price_list\(price_list\.id\)/);
  assert.match(sql, /public\.p1_price_list_is_effective\(price_list\)/);
  assert.doesNotMatch(sql, /item->>'(?:unitPrice|price)'/);
});
