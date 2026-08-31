import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const history = fs.readFileSync(new URL('../js/components/history.js', import.meta.url), 'utf8');

test('order history prefers the price list captured by the order over the customer default', () => {
  const matches = history.match(/plName = orderPriceList\?\.name \|\| orderPriceListSnapshot/g) || [];
  assert.equal(matches.length, 2);
  assert.match(history, /order\.items\?\.find\(item => item\.priceListNameSnapshot\)/);
});
