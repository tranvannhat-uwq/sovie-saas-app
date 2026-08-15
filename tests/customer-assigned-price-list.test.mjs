import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('a disabled sales price list is authorized only through the selected customer assignment', () => {
  const migration = read('migrations/0040_customer_assigned_price_list_exception.sql');
  assert.match(migration, /public\.can_access_customer\(p_customer_id\)/);
  assert.match(migration, /ARRAY\[customer\.pricelist_id, customer\.default_price_list_id\]/);
  assert.match(migration, /lower\(btrim\(price_list\.id\)\)/);
  assert.match(migration, /lower\(btrim\(COALESCE\(price_list\.code, ''\)\)\)/);
  assert.match(migration, /public\.can_use_price_list_for_customer\(customer_row\.id, price_list\.id\)/);
  assert.doesNotMatch(migration, /UPDATE public\.pricelists[\s\S]*is_available_for_sales\s*=\s*true/);
});

test('order confirmation, history and drafts keep the customer context in price authorization', () => {
  const migration = read('migrations/0040_customer_assigned_price_list_exception.sql');
  assert.match(migration, /p40_resolve_sku_price_for_customer\(selected_list_id, product_row\.id, customer_id\)/);
  assert.match(migration, /can_use_order_price_lists_for_customer\(customer_id, pricelist_id, items\)/);
  assert.match(migration, /CREATE POLICY orders_select/);
  assert.match(migration, /CREATE POLICY drafts_insert/);
  assert.match(migration, /CREATE POLICY drafts_update/);
  assert.match(migration, /Re-running 0040 is safe/);
  assert.match(migration, /IF current_definition LIKE '%public\.can_use_price_list_for_customer/);
  assert.match(migration, /AND current_definition LIKE '%public\.p40_resolve_sku_price_for_customer/);
});

test('legacy order triggers use the customer-scoped price-list authorization', () => {
  const migration = read('migrations/0053_customer_assigned_price_list_trigger_repair.sql');
  assert.match(migration, /CREATE OR REPLACE FUNCTION public\.reject_forbidden_order_price_lists/);
  assert.match(migration, /can_use_order_price_lists_for_customer\(\s*NEW\.customer_id,\s*NEW\.pricelist_id,\s*NEW\.items/s);
  assert.match(migration, /UPDATE OF customer_id, pricelist_id, items ON public\.orders/);
  assert.match(migration, /UPDATE OF customer_id, pricelist_id, items ON public\.draft_orders/);
  assert.doesNotMatch(migration, /UPDATE public\.pricelists[\s\S]*is_available_for_sales\s*=\s*true/);
});

test('browser permits the exception only when the current order customer references that list', () => {
  const pricing = read('js/domain/pricing.js');
  const invoice = read('js/components/invoice.js');
  const pricelists = read('js/components/pricelists.js');
  const service = read('js/services/supabase.js');
  assert.match(pricing, /canUserUsePriceListForCustomer/);
  assert.match(pricing, /customer\.pricelistId, customer\.defaultPriceListId/);
  assert.match(invoice, /canUserUsePriceListForCustomer\(state\.currentUser, priceList, orderCustomer\)/);
  assert.match(pricelists, /data-customer-assigned="true"/);
  assert.equal((service.match(/canUserUsePriceListForCustomer\(state\.currentUser, priceList, orderCustomer\)/g) || []).length, 2);
  assert.match(service, /export async function dbLoadCustomerAssignedPricing\(customer\)/);
  assert.match(service, /\.eq\('price_list_id', priceList\.id\)/);
  assert.match(invoice, /await dbLoadCustomerAssignedPricing\(customer\)/);
  assert.match(invoice, /applicablePricing\.selectionSource !== 'customer_default'/);
  assert.match(invoice, /selectionSource: 'missing_customer_default'/);
  assert.match(invoice, /applicable\.selectionSource === 'customer_default'/);
});

test('scoped pricing RPC bypasses table visibility without broadening the assignment', () => {
  const migration = read('migrations/0041_customer_assigned_pricing_rpc.sql');
  const service = read('js/services/supabase.js');
  assert.match(migration, /rpc_get_customer_assigned_pricing/);
  assert.match(migration, /public\.can_access_customer\(p_customer_id\)/);
  assert.match(migration, /ARRAY\[customer\.pricelist_id, customer\.default_price_list_id\]/);
  assert.match(migration, /public\.can_use_price_list_for_customer\(customer\.id, price_list\.id\)/);
  assert.match(migration, /WHERE item\.price_list_id = selected_list\.id/);
  assert.match(migration, /SECURITY DEFINER/);
  assert.doesNotMatch(migration, /GRANT\s+SELECT/i);
  assert.match(service, /rpc\('rpc_get_customer_assigned_pricing'/);
  assert.match(service, /\['42883', 'PGRST202'\]/);
});
