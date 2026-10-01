import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { isSalesBrandRestrictionEnabled } from '../js/domain/business-capabilities.js';
import { itemMatchesAssignedBrand, partitionItemsByAssignedBrand } from '../js/domain/order-brand-policy.js';

test('assigned-brand restrictions are opt-in in a generic workspace capability snapshot', () => {
  assert.equal(isSalesBrandRestrictionEnabled(null), false);
  assert.equal(isSalesBrandRestrictionEnabled({ modules: { sales: { enabled: true, config: {} } } }), false);
  assert.equal(isSalesBrandRestrictionEnabled({
    modules: { sales: { enabled: true, config: { brand_restriction_enabled: true } } }
  }), true);
});

test('brand policy compares canonical IDs and uses names only for legacy rows', () => {
  assert.equal(itemMatchesAssignedBrand({ brandId: 'brand-a', brand: 'A' }, 'brand-a', 'A'), true);
  assert.equal(itemMatchesAssignedBrand({ brandId: 'brand-b', brand: 'A' }, 'brand-a', 'A'), false);
  assert.equal(itemMatchesAssignedBrand({ brand: 'A' }, 'brand-a', 'A'), false);
  assert.equal(itemMatchesAssignedBrand({ brand: 'A' }, 'brand-a', 'A', () => '', true), true);
  assert.equal(itemMatchesAssignedBrand({ isService: true }, 'brand-a', 'A'), true);
  assert.equal(itemMatchesAssignedBrand({ item_type: 'service' }, 'brand-a', 'A'), true);
  assert.equal(itemMatchesAssignedBrand({ itemKind: 'service' }, 'brand-a', 'A'), true);
  assert.equal(itemMatchesAssignedBrand({ item_kind: 'service' }, 'brand-a', 'A'), true);
  assert.equal(itemMatchesAssignedBrand({ product: { itemKind: 'service' } }, 'brand-a', 'A'), true);
  assert.equal(itemMatchesAssignedBrand({ itemKind: 'stock', brandId: 'brand-b' }, 'brand-a', 'A'), false);
  assert.equal(itemMatchesAssignedBrand({ brand: 'B' }, '', 'A'), false);
  assert.equal(itemMatchesAssignedBrand({ brand: '' }, '', 'Tất cả'), true);
});

test('partition preserves original item objects and identifies only incompatible rows', () => {
  const first = { id: 'line-1', brandId: 'a' };
  const second = { id: 'line-2', brandId: 'b' };
  const result = partitionItemsByAssignedBrand([first, second], 'a', 'A');
  assert.deepEqual(result.matching, [first]);
  assert.deepEqual(result.excluded, [second]);
});

test('server enforcement follows workspace sales config and protects both order tables', () => {
  const migration = fs.readFileSync(new URL('../migrations/0102_enforce_assigned_brand_on_orders.sql', import.meta.url), 'utf8');
  assert.match(migration, /module\.config->'brand_restriction_enabled' = 'true'::jsonb/);
  assert.match(migration, /customer\.organization_id = NEW\.organization_id/);
  assert.match(migration, /product\.organization_id = NEW\.organization_id/);
  assert.match(migration, /UPDATE OF items, customer_id, organization_id ON public\.orders/);
  assert.match(migration, /UPDATE OF items, customer_id, organization_id ON public\.draft_orders/);
  assert.match(migration, /item_is_service/);
  assert.match(migration, /Customer "%" is not available in this workspace/);
  assert.match(migration, /NEW\.organization_id = legacy_organization_id\s+AND NULLIF\(btrim\(assigned_brand_name\)/);
  assert.match(migration, /NEW\.organization_id = legacy_organization_id\s+AND NULLIF\(btrim\(product_brand_name\)/);
});

test('workspace settings RPC is tenant-scoped and restricted to Owner/Admin', () => {
  const migration = fs.readFileSync(new URL('../migrations/0103_workspace_sales_policy_and_neutral_defaults.sql', import.meta.url), 'utf8');
  const service = fs.readFileSync(new URL('../js/services/supabase.js', import.meta.url), 'utf8');
  assert.match(migration, /current_organization_id\(\)/);
  assert.match(migration, /has_organization_role\(active_organization_id, ARRAY\['owner', 'admin'\]\)/);
  assert.match(migration, /WHERE organization_id = active_organization_id\s+AND module_key = 'sales'/);
  assert.match(migration, /GRANT EXECUTE ON FUNCTION public\.rpc_set_sales_brand_restriction\(boolean\) TO authenticated/);
  assert.match(service, /rpc\('rpc_set_sales_brand_restriction'/);
});

test('database defaults no longer assign products and orders to the old paint company', () => {
  const migration = fs.readFileSync(new URL('../migrations/0103_workspace_sales_policy_and_neutral_defaults.sql', import.meta.url), 'utf8');
  assert.match(migration, /ALTER TABLE public\.products ALTER COLUMN brand DROP DEFAULT/);
  assert.match(migration, /ALTER TABLE public\.profiles ALTER COLUMN company_id DROP DEFAULT/);
  assert.match(migration, /ALTER TABLE public\.orders ALTER COLUMN company_id DROP DEFAULT/);
  assert.match(migration, /ALTER TABLE public\.draft_orders ALTER COLUMN company_id DROP DEFAULT/);
  assert.match(migration, /NEW\.company_id := NEW\.organization_id::text/);
  assert.match(migration, /CASE WHEN organization_id = '00000000-0000-4000-8000-000000000001'::uuid\s+THEN 'true'::jsonb ELSE 'false'::jsonb END/);
});
