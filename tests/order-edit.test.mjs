import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  normalizeOrderItemsForEditing,
  reorderOrderItems,
  resolveOrderCustomerForEditing
} from '../js/domain/order-edit.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const invoiceSource = fs.readFileSync(path.join(root, 'js/components/invoice.js'), 'utf8');

test('guest drafts remain guest orders when reopened or copied', () => {
  const context = resolveOrderCustomerForEditing({
    customerId: null,
    customerName: 'Khách lẻ anh Nam'
  }, [{ id: 'customer-1', name: 'Khách có hồ sơ' }]);

  assert.equal(context.isGuest, true);
  assert.equal(context.customerId, null);
  assert.equal(context.customerName, 'Khách lẻ anh Nam');
});

test('drafts whose old customer record is unavailable keep their name snapshot', () => {
  const context = resolveOrderCustomerForEditing({
    customerId: 'deleted-customer',
    customerName: 'Tên khách trên đơn'
  }, []);

  assert.equal(context.isGuest, true);
  assert.equal(context.customerId, null);
  assert.equal(context.customerName, 'Tên khách trên đơn');
});

test('registered draft customers still resolve to the current customer record', () => {
  const context = resolveOrderCustomerForEditing({
    customerId: 'customer-1',
    customerName: 'Tên snapshot cũ'
  }, [{ id: 'customer-1', name: 'Tên hiện tại' }]);

  assert.equal(context.isGuest, false);
  assert.equal(context.customerId, 'customer-1');
  assert.equal(context.customerName, 'Tên hiện tại');
});

test('legacy draft items with an embedded product remain editable', () => {
  const [item] = normalizeOrderItemsForEditing([{
    product: {
      id: 'legacy-product',
      code: 'LEGACY-01',
      name: 'Sơn lót chống kiềm nội thất',
      brand: 'COVA NANO',
      packageType: 'Lon'
    },
    package: 'Lon',
    quantity: 10,
    price: 629000,
    discountPercent: 0
  }], []);

  assert.equal(item.product.name, 'Sơn lót chống kiềm nội thất');
  assert.equal(item.product.code, 'LEGACY-01');
  assert.equal(item.variantId, 'legacy-product');
  assert.equal(item.quantity, 10);
  assert.equal(item.price, 629000);
});

test('snapshot draft items prefer the current matching catalog product without changing money', () => {
  const products = [{ id: 'sku-1', code: 'SKU-01', name: 'Tên hiện tại', brand: 'ABS' }];
  const [item] = normalizeOrderItemsForEditing([{
    variantId: 'sku-1',
    variantCode: 'SKU-01',
    productName: 'Tên snapshot',
    brand: 'ABS',
    packagingName: 'Bộ',
    quantity: 8,
    price: 1110500,
    discountPercent: 5
  }], products);

  assert.equal(item.product.id, products[0].id);
  assert.equal(item.product.name, 'Tên hiện tại');
  assert.equal(item.package, 'Bộ');
  assert.equal(item.quantity, 8);
  assert.equal(item.price, 1110500);
  assert.equal(item.discountPercent, 5);
});

test('incomplete legacy rows receive safe display fallbacks instead of stopping edit', () => {
  const [item] = normalizeOrderItemsForEditing([{ quantity: '2', price: '50000' }], []);
  assert.equal(item.product.name, 'Sản phẩm 1');
  assert.equal(item.product.code, 'LEGACY-1');
  assert.equal(item.quantity, 2);
  assert.equal(item.price, 50000);
});

test('order items can be moved forward or backward without mutating their data', () => {
  const source = [
    { id: 'a', quantity: 1, discountPercent: 5 },
    { id: 'b', quantity: 2, discountPercent: 10 },
    { id: 'c', quantity: 3, discountPercent: 15 }
  ];

  const movedDown = reorderOrderItems(source, 0, 2);
  assert.deepEqual(movedDown.map(item => item.id), ['b', 'c', 'a']);
  assert.deepEqual(movedDown[2], source[0]);
  assert.deepEqual(source.map(item => item.id), ['a', 'b', 'c']);

  const movedUp = reorderOrderItems(movedDown, 2, 0);
  assert.deepEqual(movedUp.map(item => item.id), ['a', 'b', 'c']);
});

test('invalid item moves leave the current order array untouched', () => {
  const source = [{ id: 'a' }, { id: 'b' }];
  assert.equal(reorderOrderItems(source, 0, 0), source);
  assert.equal(reorderOrderItems(source, -1, 1), source);
  assert.equal(reorderOrderItems(source, 0, 5), source);
});

test('editable historical orders refresh current prices while read-only orders keep snapshots', () => {
  const listener = invoiceSource.slice(
    invoiceSource.indexOf("document.addEventListener('loadDraftOrder'"),
    invoiceSource.indexOf("document.addEventListener('loadDraftOrder'") + 900
  );

  assert.match(listener, /if \(isReadOnly\)[\s\S]*renderInvoiceTable\(\)[\s\S]*return;/);
  assert.match(listener, /applyActivePriceListToInvoice\(\)/);
  assert.ok(listener.indexOf('return;') < listener.indexOf('applyActivePriceListToInvoice();'));
});
