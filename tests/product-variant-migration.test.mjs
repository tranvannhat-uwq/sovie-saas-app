import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../migration_product_parent_variants.sql', import.meta.url), 'utf8');

[
  'CREATE TABLE IF NOT EXISTS public.product_groups',
  'product_group_id',
  'variant_id',
  'variant_code_snapshot',
  'packaging_name_snapshot',
  'weight_or_volume_snapshot',
  'product_variant_migration_issues',
  'AMBIGUOUS_BASE_CODE',
  'AMBIGUOUS_RETURN_VARIANT',
  'v_product_parent_variants',
  'v_variant_prices'
].forEach(fragment => assert.ok(sql.includes(fragment), `Missing migration fragment: ${fragment}`));

['LON', 'THUNG', 'THÙNG', 'HOP', 'HỘP', 'BAO', 'TUI', 'TÚI', 'CHAI', 'GOI', 'GÓI', 'KG', 'LIT', 'LÍT']
  .forEach(suffix => assert.ok(sql.includes(suffix), `Missing legacy suffix: ${suffix}`));

assert.doesNotMatch(sql, /\bTRUNCATE\s+public\.(products|orders|order_items)\b/i);
assert.doesNotMatch(sql, /\bDELETE\s+FROM\s+public\.(products|orders|order_items)\b/i);

console.log('product-variant-migration.test.mjs: all assertions passed');
