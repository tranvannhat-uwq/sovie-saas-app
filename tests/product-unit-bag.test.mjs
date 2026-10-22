import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productsCode = fs.readFileSync(path.join(root, 'js', 'components', 'products.js'), 'utf8');
const migration0110 = fs.readFileSync(path.join(root, 'migrations', '0110_add_bag_catalog_unit.sql'), 'utf8');

test('products UI includes Bao (bao) unit resolver logic', () => {
  assert.match(productsCode, /code:\s*'bag',\s*name:\s*'Bao',\s*symbol:\s*'bao'/);
  assert.match(productsCode, /units\.some\(unit => String\(unit\?\.code \|\| ''\)\.toLowerCase\(\) === 'bag'/);
});

test('migration 0110 is ordered, safe, and seeds bag catalog unit', () => {
  assert.match(migration0110, /\bBEGIN\s*;/i);
  assert.match(migration0110, /\bCOMMIT\s*;/i);
  assert.match(migration0110, /version = '0109'/);
  assert.match(migration0110, /\('bag',\s*'Bao',\s*'bao',\s*'count',\s*0\)/);
  assert.match(migration0110, /VALUES\s*\(\s*'0110',\s*'Add bag catalog unit'\s*\)/);
  assert.match(migration0110, /INSERT INTO public\.catalog_units/);
  assert.match(migration0110, /SELECT id, 'bag', 'Bao', 'bao', 'count', 0/);
});
