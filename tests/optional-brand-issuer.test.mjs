import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const migration = read('migrations/0105_optional_workspace_brands_and_invoice_issuer.sql');
const dashboard = read('js/components/dashboard.js');
const history = read('js/components/history.js');
const customers = read('js/components/customers.js');
const brands = read('js/components/brands.js');
const service = read('js/services/supabase.js');
const { isBrandCatalogEnabled } = await import(pathToFileURL(
  path.join(root, 'js', 'domain', 'business-capabilities.js')
));

test('brand catalog visibility is independent from brand sales restriction', () => {
  const catalogDisabled = { modules: { sales: { config: {
    brand_catalog_enabled: false,
    brand_restriction_enabled: false
  } } } };
  const catalogEnabled = { modules: { sales: { config: {
    brand_catalog_enabled: true,
    brand_restriction_enabled: false
  } } } };
  const restricted = { modules: { sales: { config: {
    brand_catalog_enabled: false,
    brand_restriction_enabled: true
  } } } };
  const existingData = [{ name: 'Sample brand' }];

  assert.equal(isBrandCatalogEnabled(catalogDisabled, existingData, [{ brand: 'Sample brand' }]), false);
  assert.equal(isBrandCatalogEnabled(catalogEnabled, [], []), true);
  assert.equal(isBrandCatalogEnabled(restricted, [], []), true);
  assert.equal(isBrandCatalogEnabled({ modules: { sales: { config: {} } } }, existingData, []), true);
});

test('products can be unbranded while preserving one SKU per workspace', () => {
  assert.match(migration, /ALTER TABLE public\.products ALTER COLUMN brand DROP NOT NULL/);
  assert.match(migration, /products_organization_unbranded_code_uidx/);
  assert.match(migration, /WHERE NULLIF\(btrim\(brand\), ''\) IS NULL/);
  assert.match(migration, /rpc_set_sales_brand_settings/);
  assert.match(service, /if \(!brandName\) return null/);
  assert.match(service, /query\.or\('brand\.is\.null,brand\.eq\.'\)/);
});

test('editing brand metadata preserves customer assignments and catalog links', () => {
  const saveBrand = service.slice(
    service.indexOf('export async function dbSaveBrand'),
    service.indexOf('export async function dbDeleteBrand')
  );
  assert.match(saveBrand, /\.upsert\(dbRow, \{ onConflict: 'id' \}\)/);
  assert.doesNotMatch(saveBrand, /\.delete\(\)/);
  assert.match(brands, /linkedCustomerCount/);
  assert.match(brands, /linkedCount > 0 \|\| linkedCustomerCount > 0/);
});

test('transaction company is the reporting scope outside legacy compatibility paths', () => {
  assert.match(dashboard, /function getItemRevenueCompanyId\(item, orderCompanyId\)[\s\S]*if \(!isLegacyPaintWorkspace\(\)\) return ''/);
  assert.match(dashboard, /return getOrderCompanyId\(order\) === selectedCompanyId/);
  assert.match(history, /if \(!isLegacyPaintWorkspace\(\)\) return false/);
  assert.match(customers, /if \(!customerCompanyId && isLegacyPaintWorkspace\(\)\)/);
  assert.match(customers, /if \(!isLegacyPaintWorkspace\(\)\) return false/);

  const dashboardStart = migration.indexOf('CREATE OR REPLACE FUNCTION public.rpc_get_phase5_dashboard');
  const dashboardEnd = migration.indexOf('ALTER FUNCTION public.rpc_get_phase5_dashboard', dashboardStart);
  const dashboardSql = migration.slice(dashboardStart, dashboardEnd);
  assert.match(dashboardSql, /sale\.company_id revenue_company_id/);
  assert.equal((dashboardSql.match(/OR sale\.company_id = p_filters->>'company_id'/g) || []).length, 2);
  assert.doesNotMatch(dashboardSql, /brand\.company_id/);
});

test('issuer settings are tenant-scoped and historical order snapshots remain printable', () => {
  assert.match(migration, /rpc_set_invoice_issuer_profile/);
  assert.match(migration, /issuer_profile_snapshot jsonb/);
  assert.match(migration, /CREATE TRIGGER orders_issuer_profile_snapshot/);
  assert.match(migration, /CREATE TRIGGER draft_orders_issuer_profile_snapshot/);
  assert.match(migration, /public\.has_organization_role\(active_organization_id, ARRAY\['owner', 'admin'\]\)/);
});
