import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sql = fs.readFileSync(
  path.join(root, 'migrations', '0062_generic_catalog_and_extensions.sql'), 'utf8'
);
const invoice = fs.readFileSync(path.join(root, 'js', 'components', 'invoice.js'), 'utf8');
const catalog = await import(pathToFileURL(
  path.join(root, 'js', 'domain', 'generic-catalog.js')
));

test('catalog core is industry-neutral and tenant-relational', () => {
  for (const table of ['catalog_units', 'catalog_categories',
    'catalog_attribute_definitions', 'catalog_product_attribute_values',
    'catalog_variant_attribute_values', 'catalog_extensions']) {
    assert.match(sql, new RegExp(`CREATE TABLE public\\.${table}`));
  }
  assert.match(sql, /FOREIGN KEY \(organization_id, product_group_id\)/);
  assert.match(sql, /FOREIGN KEY \(organization_id, product_id\)/);
  assert.match(sql, /item_kind IN \('stock','non_stock','service','bundle'\)/);
});

test('paint pricing is an explicit compatibility-tenant extension', () => {
  assert.match(sql, /'paint_color', true/);
  assert.match(sql, /WHERE organization_id = '00000000-0000-4000-8000-000000000001'/);
  assert.match(sql, /catalog_extension_adjustment_percent\(''paint_color'', item\)/);
  assert.match(sql, /New organizations are generic/);
});

test('generic tenants hide the paint UI and calculate extension rules from config', () => {
  assert.match(invoice, /isCatalogExtensionEnabled\([\s\S]*'paint_color'/);
  assert.match(invoice, /catalogAdjustmentPercent\([\s\S]*'paint_color'/);
  const generic = catalog.resolveCatalogContext({ organizationId: 'a' }, 'a');
  assert.equal(catalog.catalogAdjustmentPercent(generic, 'paint_color', { colorCode: 'RED-A' }), 0);
  const paint = catalog.resolveCatalogContext({
    organizationId: 'a', extensions: { paint_color: { enabled: true, config: {
      input_field: 'colorCode', suffix_adjustments: [{ suffix: 'A', percent: 25 }]
    } } }
  }, 'a');
  assert.equal(catalog.catalogAdjustmentPercent(paint, 'paint_color', { colorCode: 'red-a' }), 25);
  assert.throws(() => catalog.resolveCatalogContext({ organizationId: 'b' }, 'a'));
});

test('catalog context is loaded with the authenticated tenant context', () => {
  const service = fs.readFileSync(path.join(root, 'js', 'services', 'supabase.js'), 'utf8');
  assert.match(service, /rpc\('rpc_my_catalog_context'\)/);
  assert.match(service, /resolveCatalogContext\(catalogResponse\.data, context\.organizationId\)/);
});
