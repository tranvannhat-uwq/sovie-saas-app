import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const migration = fs.readFileSync(path.join(root, 'migrations/0022_dot_color_surcharge.sql'), 'utf8');
const authoritativeMigration = fs.readFileSync(
  path.join(root, 'migrations/0023_authoritative_color_surcharges.sql'),
  'utf8'
);

test('a trailing dot adds five percent without changing existing color suffixes', async () => {
  globalThis.localStorage = { getItem: () => null };
  const { getColorPercentFromCode, calculateColorMarkedUpPrice } = await import('../js/utils.js');
  assert.equal(getColorPercentFromCode('ABC-P.'), 5);
  assert.equal(getColorPercentFromCode(' abc-p. '), 5);
  assert.equal(getColorPercentFromCode('ABC-P'), 0);
  assert.equal(getColorPercentFromCode('ABC-T'), 15);
  assert.equal(getColorPercentFromCode('ABC-D'), 20);
  assert.equal(getColorPercentFromCode('ABC-A'), 25);
  assert.equal(getColorPercentFromCode('ABC-X'), 0);
  assert.equal(getColorPercentFromCode(''), 0);
  assert.equal(calculateColorMarkedUpPrice(100000, 15), 115000);
  assert.equal(calculateColorMarkedUpPrice(100000, 0), 100000);
  assert.equal(calculateColorMarkedUpPrice(0, 25), 0);
});

test('manual prices are recalculated after color markup without replacing the base price', () => {
  const invoiceSource = fs.readFileSync(path.join(root, 'js/components/invoice.js'), 'utf8');
  const manualPriceHandler = invoiceSource.slice(
    invoiceSource.indexOf("document.querySelectorAll('.item-manual-price')"),
    invoiceSource.indexOf("document.querySelectorAll('.item-notes')")
  );
  assert.match(manualPriceHandler, /item\.unitPrice = price;[\s\S]*item\.listPrice = price;/);
  assert.match(manualPriceHandler, /recalculateItemPriceWithColorMarkup\(idx\);/);
  assert.match(manualPriceHandler, /updateRowUnitPrice\(row, idx\);/);
  assert.doesNotMatch(manualPriceHandler, /item\.price = price;/);
});

test('order confirmation derives the dot surcharge from colorCode on the server', () => {
  assert.match(migration, /right\(btrim\(COALESCE\(item->>''colorCode''/);
  assert.match(migration, /THEN 5/);
  assert.match(migration, /resolved_price\.price \* \(1 \+ color_markup_percent \/ 100\)/);
  assert.doesNotMatch(migration, /resolved_price\.price \* \(1 \+ \(item->>''colorPercent''\)/);
});

test('confirming and amending orders preserve every existing color surcharge', () => {
  assert.match(authoritativeMigration, /THEN 5/);
  assert.match(authoritativeMigration, /THEN 15/);
  assert.match(authoritativeMigration, /THEN 20/);
  assert.match(authoritativeMigration, /THEN 25/);
  assert.match(authoritativeMigration, /'colorPercent'', color_markup_percent/);
  assert.match(authoritativeMigration, /resolved_price\.price \* \(1 \+ color_markup_percent \/ 100\)/);
  assert.doesNotMatch(
    authoritativeMigration,
    /unit_price\s*:=\s*.*(?:item->>''price''|item->>''unitPrice'')/
  );
});

test('the authoritative color migration can patch a server that has not run 0022', () => {
  assert.match(authoritativeMigration, /current_definition NOT LIKE '%color_markup_percent numeric;%'/);
  assert.match(authoritativeMigration, /'unit_price numeric;'/);
  assert.match(authoritativeMigration, /'unit_price := round\(resolved_price\.price\);'/);
  assert.match(authoritativeMigration, /complete color pricing rule was not assembled/);
});
