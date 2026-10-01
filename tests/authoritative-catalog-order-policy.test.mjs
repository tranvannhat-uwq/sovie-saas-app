import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const read = path => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('product editor uses workspace catalog units and persists generic item kind', () => {
  const editor = read('js/components/products.js');
  const service = read('js/services/supabase.js');
  const bulkSave = service.slice(
    service.indexOf('export async function dbSaveProductsBulk'),
    service.indexOf('export async function dbRenameBrandProducts')
  );
  const singleSave = service.slice(
    service.indexOf('export async function dbSaveProduct'),
    service.indexOf('export async function dbSaveProductsBulk')
  );
  const normalize = service.slice(
    service.indexOf('function normalizeProductRow'),
    service.indexOf('function resolveProductBrandId')
  );
  assert.match(editor, /state\.businessCapabilities\?\.catalog\?\.units/);
  assert.match(editor, /sellUnitCode: unit\.code/);
  assert.match(editor, /itemKind: document\.getElementById\('prod-item-kind'\)/);
  assert.match(bulkSave, /item_kind: \['stock', 'non_stock', 'service', 'bundle'\]/);
  assert.match(bulkSave, /sell_unit_code: product\.sellUnitCode \|\| 'piece'/);
  assert.match(bulkSave, /track_inventory: product\.trackInventory !== false/);
  assert.match(singleSave, /query\.or\('brand\.is\.null,brand\.eq\.'\)/);
  assert.match(bulkSave, /package_type: product\.packageType \|\| null/);
  assert.match(editor, /Tên quy cách \(không bắt buộc\)/);
  assert.doesNotMatch(editor, /variant-package-input[^>]*required/);
  assert.match(editor, /!variant\.sellUnitCode/);
  assert.match(normalize, /row\.brand !== undefined\s*\? String\(row\.brand \|\| ''\)/);
  assert.match(normalize, /row\.brand_id !== undefined/);
  assert.match(editor, /brandId: matchedBrand\?\.id \|\| null/);
});

test('new product, brand, customer phone and province are not paint-only required fields', () => {
  const productEditor = read('js/components/products.js');
  const brandEditor = read('js/components/brands.js');
  const customerEditor = read('js/components/customers.js');
  assert.match(productEditor, /if \(!baseCode \|\| !name \|\| rows\.length === 0\)/);
  assert.match(brandEditor, /if \(!name\)/);
  assert.match(customerEditor, /isCustomerFieldRequired\('phone'\)/);
  assert.match(customerEditor, /isCustomerFieldRequired\('province'\)/);
});

test('server order policy resolves service status from the tenant product catalog and audits setting changes', () => {
  const migration = read('migrations/0104_authoritative_catalog_order_policy.sql');
  assert.match(migration, /product\.item_kind/);
  assert.match(migration, /item_is_service := product_item_kind = 'service'/);
  assert.match(migration, /allow_unlinked_service_lines/);
  assert.match(migration, /INSERT INTO public\.activity_logs/);
  assert.match(migration, /old_value, new_value, changes, metadata/);
  assert.match(migration, /has_organization_role\(active_organization_id, ARRAY\['owner', 'admin'\]\)/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF items, customer_id, organization_id ON public\.orders/);
  assert.match(migration, /BEFORE INSERT OR UPDATE OF items, customer_id, organization_id ON public\.draft_orders/);
});
