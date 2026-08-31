import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const invoice = fs.readFileSync(new URL('../js/components/invoice.js', import.meta.url), 'utf8');

test('a shared sales price list may persist an order when accounting enables saving', () => {
  assert.match(invoice, /selectedType === PRICE_LIST_TYPES\.SALES[\s\S]{0,100}!isPrintOnlyPriceList\(selected\)/);
  assert.match(invoice, /selectedType === PRICE_LIST_TYPES\.GENERAL[\s\S]{0,100}\|\| isApprovedSalesList/);
  assert.match(invoice, /Bảng giá đã chọn không được phép lưu đơn cho khách hàng này/);
});
